//! Backend-neutral cross-frame **tile-cache policy** (the decision half of the tile cache).
//!
//! A tile's rendered pixels are *pan-invariant* but *scale-* and *content-variant*: panning only
//! changes which tile indices are visible, so a pan can reuse a tile's buffer and re-render just the
//! newly-exposed strip; a zoom drops everything (the 1:1 composite is only valid at the render
//! scale); an edit invalidates just the tiles its dirty rects cover. Deciding *which* tiles that
//! leaves to (re)render, and *which* to evict when the budget is exceeded, is pure bookkeeping over
//! [`TileKey`]s and a frame counter — no GPU in it — so it lives here and every backend shares it.
//!
//! The *storage* stays in the backend: [`TileCache`] is generic over the surface type `S` (a wgpu
//! texture for the Vello sink, an `SkImage`/picture for a Skia sink, …). This crate never looks
//! inside `S`; it only owns the `TileKey → Option<S>` map, where `None` records a *cached empty*
//! tile (no shape overlaps it) so [`TileCache::plan`] does not re-dirty it every frame.
//!
//! Usage each frame: [`plan`](TileCache::plan) (invalidate + return the tiles to render) →
//! [`advance_frame`](TileCache::advance_frame) → the backend renders those tiles and
//! [`store`](TileCache::store)s them → reused (unrendered) visible tiles are blitted from
//! [`get`](TileCache::get) and [`touch`](TileCache::touch)ed → [`evict`](TileCache::evict).

use std::collections::{HashMap, HashSet};

use kurbo::{Affine, Rect};

use crate::tiling::{self, TileKey};

/// How many *not-currently-visible* tiles the cache keeps before evicting the least-recently-used.
/// Visible tiles are always retained on top of this (see [`TileCache::evict`]).
pub const DEFAULT_TILE_BUDGET: usize = 48;

/// The cross-frame tile cache: the neutral invalidation + eviction policy over a backend-owned
/// surface type `S`. See the module docs for the per-frame call sequence.
pub struct TileCache<S> {
    /// Each *processed* tile: `Some(surface)` for a tile with content, `None` for a cached-empty
    /// tile. Presence of the key (either value) is what marks a tile clean so `plan` skips it.
    entries: HashMap<TileKey, Option<S>>,
    /// Last frame each cached tile was visible, for LRU eviction.
    last_used: HashMap<TileKey, u64>,
    /// The scale every cached tile was rendered at; a change invalidates the whole cache.
    scale: Option<f64>,
    /// Monotonic frame counter driving `last_used`.
    frame: u64,
    /// Retention budget for non-visible tiles.
    budget: usize,
}

impl<S> Default for TileCache<S> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S> TileCache<S> {
    /// A cache with the [`DEFAULT_TILE_BUDGET`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_budget(DEFAULT_TILE_BUDGET)
    }

    /// A cache retaining up to `budget` non-visible tiles.
    #[must_use]
    pub fn with_budget(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            last_used: HashMap::new(),
            scale: None,
            frame: 0,
            budget,
        }
    }

    /// Decide which visible tiles must be (re)rendered this frame, invalidating the cache first: a
    /// **scale change** drops everything (tile pixels are scale-variant); `dirty_all` drops
    /// everything; otherwise each dirty **page-space** rect removes the tiles it covers.
    ///
    /// Returns `(dirty, invalidated)`: the visible tiles not in the cache — the newly-exposed strip
    /// plus the invalidated ones — that the caller builds the schedule for (the rest are reused from
    /// cache), and the *content surfaces the invalidation just dropped*, so the backend can recycle
    /// their textures instead of freeing them (the same reason [`evict`](Self::evict) hands its back).
    pub fn plan(
        &mut self,
        view: Affine,
        width: u32,
        height: u32,
        dirty_all: bool,
        dirty_rects: &[Rect],
    ) -> (Vec<TileKey>, Vec<S>) {
        let scale = tiling::view_scale(view);
        let mut invalidated = Vec::new();
        if self.scale != Some(scale) {
            invalidated.extend(self.entries.drain().filter_map(|(_, s)| s));
            self.last_used.clear();
            self.scale = Some(scale);
        }
        if dirty_all {
            invalidated.extend(self.entries.drain().filter_map(|(_, s)| s));
            self.last_used.clear();
        } else {
            for rect in dirty_rects {
                for t in tiling::tiles_overlapping_page_rect(view, *rect) {
                    if let Some(Some(s)) = self.entries.remove(&t) {
                        invalidated.push(s);
                    }
                    self.last_used.remove(&t);
                }
            }
        }
        let dirty = tiling::visible_tiles(view, width, height)
            .into_iter()
            .filter(|t| !self.entries.contains_key(t))
            .collect();
        (dirty, invalidated)
    }

    /// Begin a produced frame: advance the counter that stamps `last_used`. Call once, after
    /// [`plan`](Self::plan) and before harvesting, so this frame's stores and touches share a stamp.
    pub fn advance_frame(&mut self) -> u64 {
        self.frame += 1;
        self.frame
    }

    /// Record a freshly-produced tile — `Some(surface)` for content, `None` for an empty tile (kept
    /// so `plan` won't re-dirty it) — and stamp it used this frame. Returns the content surface this
    /// one replaced, if any, so the backend can recycle its texture (a re-rendered dirty tile).
    pub fn store(&mut self, key: TileKey, surface: Option<S>) -> Option<S> {
        self.last_used.insert(key, self.frame);
        self.entries.insert(key, surface).flatten()
    }

    /// The cached content surface for a tile, or `None` if the tile is cached-empty or absent. Does
    /// not stamp usage — call [`touch`](Self::touch) when a reused tile is actually presented.
    #[must_use]
    pub fn get(&self, key: TileKey) -> Option<&S> {
        self.entries.get(&key).and_then(Option::as_ref)
    }

    /// Whether the tile is in the cache at all (content *or* cached-empty). This is the "is it clean"
    /// test `plan` uses; distinct from [`get`](Self::get), which is `None` for a cached-empty tile.
    #[must_use]
    pub fn contains(&self, key: TileKey) -> bool {
        self.entries.contains_key(&key)
    }

    /// Mark a cached tile used this frame — for a reused tile that was only blitted, so LRU sees it
    /// as live and does not evict it.
    pub fn touch(&mut self, key: TileKey) {
        self.last_used.insert(key, self.frame);
    }

    /// Evict least-recently-used tiles beyond the budget, never a currently-visible one. Returns the
    /// evicted *content* surfaces (cached-empty tiles yield nothing) so the backend can recycle their
    /// textures; drop the returned vec to just free them.
    pub fn evict(&mut self, visible: &[TileKey]) -> Vec<S> {
        if self.entries.len() <= self.budget {
            return Vec::new();
        }
        let visible: HashSet<TileKey> = visible.iter().copied().collect();
        let mut candidates: Vec<(u64, TileKey)> = self
            .entries
            .keys()
            .filter(|k| !visible.contains(k))
            .map(|k| (self.last_used.get(k).copied().unwrap_or(0), *k))
            .collect();
        candidates.sort_unstable_by_key(|(used, _)| *used);
        let mut over = self.entries.len().saturating_sub(self.budget);
        let mut freed = Vec::new();
        for (_, key) in candidates {
            if over == 0 {
                break;
            }
            if let Some(Some(surface)) = self.entries.remove(&key) {
                freed.push(surface);
            }
            self.last_used.remove(&key);
            over -= 1;
        }
        freed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(x: i32, y: i32) -> TileKey {
        TileKey { tile_x: x, tile_y: y, zoom_bucket: tiling::zoom_bucket(1.0) }
    }

    #[test]
    fn a_pan_reuses_cached_tiles_and_only_plans_the_newly_exposed_strip() {
        let mut cache: TileCache<u32> = TileCache::new();
        let (first, _) = cache.plan(Affine::IDENTITY, 1024, 512, false, &[]);
        assert_eq!(first.len(), 2);
        cache.advance_frame();
        for t in &first {
            cache.store(*t, Some(1));
        }
        let (panned, _) = cache.plan(Affine::translate((-512.0, 0.0)), 1024, 512, false, &[]);
        assert_eq!(panned, vec![tile(2, 0)]);
        assert!(cache.contains(tile(1, 0)));
    }

    #[test]
    fn a_scale_change_drops_the_whole_cache() {
        let mut cache: TileCache<u32> = TileCache::new();
        let (first, _) = cache.plan(Affine::IDENTITY, 1024, 512, false, &[]);
        cache.advance_frame();
        for t in &first {
            cache.store(*t, Some(1));
        }
        let (zoomed, _) = cache.plan(Affine::scale(2.0), 1024, 512, false, &[]);
        assert!(!zoomed.is_empty());
        assert!(!cache.contains(tile(0, 0)));
    }

    #[test]
    fn a_dirty_rect_invalidates_only_the_tiles_it_covers() {
        let mut cache: TileCache<u32> = TileCache::new();
        let (first, _) = cache.plan(Affine::IDENTITY, 1024, 512, false, &[]);
        cache.advance_frame();
        for t in &first {
            cache.store(*t, Some(1));
        }
        let (dirty, _) = cache.plan(Affine::IDENTITY, 1024, 512, false, &[Rect::new(20.0, 20.0, 100.0, 100.0)]);
        assert_eq!(dirty, vec![tile(0, 0)]);
        assert!(cache.contains(tile(1, 0)));
        let (all, _) = cache.plan(Affine::IDENTITY, 1024, 512, true, &[]);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn a_cached_empty_tile_is_clean_but_yields_no_surface() {
        let mut cache: TileCache<u32> = TileCache::new();
        cache.advance_frame();
        cache.store(tile(0, 0), None);
        assert!(cache.contains(tile(0, 0)));
        assert!(cache.get(tile(0, 0)).is_none());
    }

    #[test]
    fn eviction_drops_the_least_recently_used_and_never_a_visible_tile() {
        let mut cache: TileCache<u32> = TileCache::with_budget(2);
        for (f, t) in [tile(0, 0), tile(1, 0), tile(2, 0)].into_iter().enumerate() {
            cache.advance_frame();
            cache.store(t, Some(f as u32));
            let _ = f;
        }
        let freed = cache.evict(&[]);
        assert_eq!(freed.len(), 1);
        assert!(!cache.contains(tile(0, 0)));
        assert!(cache.contains(tile(1, 0)) && cache.contains(tile(2, 0)));
    }

    #[test]
    fn eviction_keeps_visible_tiles_even_when_over_budget() {
        let mut cache: TileCache<u32> = TileCache::with_budget(1);
        for t in [tile(0, 0), tile(1, 0)] {
            cache.advance_frame();
            cache.store(t, Some(0));
        }
        let freed = cache.evict(&[tile(0, 0), tile(1, 0)]);
        assert!(freed.is_empty());
        assert!(cache.contains(tile(0, 0)) && cache.contains(tile(1, 0)));
    }
}
