//! Cross-frame cache for rendered effect outputs. Generic over
//! `EffectKey` — one map shared by drop shadows, glass, layer blur,
//! background blur, scatter blits. The current `surfaces.scatter_output_cache`
//! and `surfaces.glass_backdrop_cache` are per-frame caches with
//! end-of-schedule clears; this cache **persists across frames** and
//! is the foundation for the pan/zoom/move latency wins surfaced by
//! the perf bench.
//!
//! ## Phase 1 scope
//!
//! Scaffold only — types, lifecycle, perf counters. No
//! `scheduler_render_effects` arm reads or writes the cache yet.
//! Validates plumbing without behaviour change.
//!
//! ## Subsequent phases
//!
//! - Phase 2: hook `scheduler_render_effects` for `Scatter(DropShadows)`
//!   and `Local(LayerBlur)` (highest-value, no backdrop dep).
//! - Phase 3: scale buckets with hysteresis; per-shape sub-cap.
//! - Phase 4: backdrop hash for `Gather(_)` keys (glass, bg_blur).
//! - Phase 5: swap eviction to O(1) `lru` crate; add viewport
//!   scoping; expose true gauge metrics.
//! - Phase 6: shape-mutation invalidation hooks.
//!
//! Gated on `tile-scheduler` because the cache key embeds `EffectKey`,
//! a V2-scheduler type. The cache is V2-only by design.

#![cfg(feature = "tile-scheduler")]

use crate::shapes::{Blur, Fill, GlassEffect, Shape, TextureEffect};
use crate::state::ShapesPoolRef;
use crate::tile_grid::{EffectKey, TileGrid};
use crate::uuid::Uuid;
use lru::LruCache;
use skia_safe::{self as skia};
use std::hash::{Hash, Hasher};

/// Composite key. All fields participate in equality so a shape with
/// the same geometry + same effect params at the same scale-bucket
/// hits cache, while any mutation flips one of these hashes and
/// forces a re-render.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct EffectCacheKey {
    pub shape_id: Uuid,
    pub effect: EffectKey,
    /// `round(log2(scale * dpr))` clamped to `[-3, 5]`. Phase 3 adds
    /// hysteresis at bucket boundaries.
    pub scale_bucket: i8,
    /// Hash of shape bbox + path digest. Flipped by `_set_modifiers`.
    pub geometry_hash: u64,
    /// Hash of the effect's parameters (radius, color, offset, ...)
    /// for this shape. Effect param edits flip this without
    /// invalidating geometry-only entries.
    pub params_hash: u64,
    /// Hash of the set of shapes intersecting this shape's bbox plus
    /// each member's geometry+fill hashes. Non-zero only for
    /// `Gather(_)` keys (phase 4). Pan does not change this; moving a
    /// shape under glass does.
    pub backdrop_hash: u64,
}

#[derive(Clone)]
pub struct EffectCacheValue {
    /// GPU-backed image. Keyed by world coords so pan reuses without
    /// re-render.
    pub image: skia::Image,
    /// World-space bbox the image covers. Caller blits into the
    /// scaled equivalent on a hit.
    pub world_bbox: skia::Rect,
}

pub struct EffectCacheEntry {
    pub value: EffectCacheValue,
    /// Estimated GPU memory footprint (`width * height * 4`). Used
    /// for byte-cap eviction.
    pub bytes: u32,
    /// Last frame this entry was returned from `get` (or inserted).
    /// Bumped on `LruCache::get` automatically; we still track it
    /// explicitly so the per-shape sub-cap can scan siblings without
    /// a second pass through the LRU's internal list.
    pub last_used_frame: u32,
}

/// Default GPU memory cap. Override via `EFFECT_CACHE_MB` env var at
/// wasm build time (read at module init). Sized for a 1080p viewport
/// rendering ~4 buckets of typical fx_combos shapes:
///   500 shapes × 64 KB avg × 3 buckets ≈ 96 MB.
const DEFAULT_CAP_BYTES: u64 = 96 * 1024 * 1024;

pub struct EffectCache {
    /// `lru` crate gives O(1) `get` (recency-bumping), O(1) `put`
    /// and O(1) `pop_lru` for byte-cap eviction. We pass
    /// `usize::MAX` as the count cap and enforce eviction by bytes
    /// instead — `LruCache` doesn't support byte caps natively.
    map: LruCache<EffectCacheKey, EffectCacheEntry>,
    bytes_used: u64,
    bytes_cap: u64,
    /// Wraps every `tick_frame`. Used as the recency timestamp; u32
    /// overflow at 2^32 frames ≈ 2 years at 60 Hz so safe to wrap.
    current_frame: u32,
    /// Cumulative counters surfaced via the perf snapshot. Plain
    /// fields here so non-`perf-trace` builds also account; the
    /// `perf-trace` adapters in `tick_frame` mirror them into the
    /// per-frame snapshot for diff CLI consumption.
    pub stat_hits: u64,
    pub stat_misses: u64,
    pub stat_evictions: u64,
}

impl EffectCache {
    pub fn new() -> Self {
        Self {
            // Bytes-only cap — we enforce eviction manually via
            // `evict_to_cap` and `enforce_sub_cap`. `LruCache::unbounded`
            // doesn't pre-allocate; passing a finite count cap with
            // `usize::MAX` aborted under emscripten because
            // `LruCache::new` does some up-front allocation work tied
            // to capacity.
            map: LruCache::unbounded(),
            bytes_used: 0,
            bytes_cap: DEFAULT_CAP_BYTES,
            current_frame: 0,
            stat_hits: 0,
            stat_misses: 0,
            stat_evictions: 0,
        }
    }

    /// Bump the recency clock. Called at the top of every render
    /// entry point (`start_render_loop`, `process_animation_frame`).
    pub fn tick_frame(&mut self) {
        self.current_frame = self.current_frame.wrapping_add(1);
    }

    /// Returns the cached value if present. `LruCache::get` bumps
    /// the entry to the front of the recency list in O(1).
    pub fn get(&mut self, key: &EffectCacheKey) -> Option<&EffectCacheValue> {
        let frame = self.current_frame;
        let entry = self.map.get_mut(key)?;
        entry.last_used_frame = frame;
        self.stat_hits = self.stat_hits.wrapping_add(1);
        crate::perf_count!(effect_cache_hit);
        Some(&entry.value)
    }

    /// Insert (or replace) an entry. `LruCache::put` returns the
    /// displaced value if the same key was already present so we
    /// can adjust the byte total. Cap enforcement runs after the
    /// insert via `pop_lru` — O(k) where k = entries to drop.
    ///
    /// Skips the insert silently if `bytes > MAX_BYTES_PER_ENTRY` so
    /// a single oversized snapshot doesn't evict the rest of the
    /// cache. Counted as a miss for snapshot-stat consistency.
    pub fn insert(&mut self, key: EffectCacheKey, value: EffectCacheValue, bytes: u32) {
        if bytes > MAX_BYTES_PER_ENTRY {
            self.stat_misses = self.stat_misses.wrapping_add(1);
            crate::perf_count!(effect_cache_miss);
            return;
        }
        let new_entry = EffectCacheEntry {
            value,
            bytes,
            last_used_frame: self.current_frame,
        };
        if let Some(old) = self.map.put(key, new_entry) {
            self.bytes_used = self.bytes_used.saturating_sub(old.bytes as u64);
        }
        self.bytes_used = self.bytes_used.saturating_add(bytes as u64);
        self.stat_misses = self.stat_misses.wrapping_add(1);
        crate::perf_count!(effect_cache_miss);
        if self.bytes_used > self.bytes_cap {
            self.evict_to_cap();
        }
    }

    /// Drop least-recently-used entries until under the byte cap.
    /// O(k) where k is number of entries evicted — `LruCache::pop_lru`
    /// is O(1) per call.
    pub fn evict_to_cap(&mut self) {
        while self.bytes_used > self.bytes_cap {
            let Some((_, removed)) = self.map.pop_lru() else {
                break;
            };
            self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
            self.stat_evictions = self.stat_evictions.wrapping_add(1);
            crate::perf_count!(effect_cache_evict);
        }
    }

    /// Drop everything. Used on viewport reset, scene rebuild, or
    /// catastrophic invalidation.
    pub fn clear(&mut self) {
        self.map.clear();
        self.bytes_used = 0;
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn bytes_used(&self) -> u64 {
        self.bytes_used
    }

    pub fn bytes_cap(&self) -> u64 {
        self.bytes_cap
    }

    /// Set a custom byte cap. Triggers eviction immediately if the
    /// new cap is below the current usage. Used by tests and for
    /// future runtime tuning hooks.
    pub fn set_bytes_cap(&mut self, cap: u64) {
        self.bytes_cap = cap;
        self.evict_to_cap();
    }
}

impl Default for EffectCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Hash the geometry inputs that decide whether a cached effect
/// output is still valid for this shape. Anything that changes the
/// shape's silhouette/extent must feed in here, so any cached output
/// is invalidated when geometry mutates. Position-in-world is
/// included on purpose — moving a shape changes which world tiles
/// its shadow covers, so the world-keyed image must be rebuilt.
///
/// f32 fields are hashed via their `to_bits()` representation —
/// `f32` is not `Hash` itself.
pub fn hash_shape_geometry(shape: &Shape) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let r = shape.selrect;
    r.x().to_bits().hash(&mut h);
    r.y().to_bits().hash(&mut h);
    r.width().to_bits().hash(&mut h);
    r.height().to_bits().hash(&mut h);
    // shape_type discriminant matters: rect vs circle change silhouette
    // even at the same bbox. We hash the variant index via Debug —
    // cheap and deterministic across runs.
    std::mem::discriminant(&shape.shape_type).hash(&mut h);
    // Rotation / transform feeds into extrect; hash via the 9-float
    // skia::Matrix raw view. f32 not Hash — bit-cast each element.
    let m: [f32; 8] = [
        shape.transform.scale_x(),
        shape.transform.skew_x(),
        shape.transform.translate_x(),
        shape.transform.skew_y(),
        shape.transform.scale_y(),
        shape.transform.translate_y(),
        shape.transform.persp_x(),
        shape.transform.persp_y(),
    ];
    for f in m.iter() {
        f.to_bits().hash(&mut h);
    }
    h.finish()
}

/// Hash the parameter set for a `TextureEffect`. Used as
/// `params_hash` on `Scatter(Blit)` cache keys. Param edits flip
/// this without invalidating geometry-only entries, so future
/// per-shape multi-param caches survive geometry tweaks.
pub fn hash_texture_params(tex: &TextureEffect) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    tex.noise_size.to_bits().hash(&mut h);
    tex.radius.to_bits().hash(&mut h);
    tex.clip_to_shape.hash(&mut h);
    tex.hidden.hash(&mut h);
    h.finish()
}

/// Hash a `GlassEffect`'s 16 parameters. Used as `params_hash` on
/// `Gather(Glass)` cache keys.
pub fn hash_glass_params(g: &GlassEffect) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    g.surface_type.hash(&mut h);
    for f in [
        g.bezel_width,
        g.glass_thickness,
        g.refractive_index,
        g.specular_angle,
        g.specular_opacity,
        g.specular_saturation,
        g.chromatic_aberration,
        g.splay,
        g.tilt_angle,
        g.edge_boost,
        g.zoom,
        g.blur,
        g.frost,
    ] {
        f.to_bits().hash(&mut h);
    }
    g.hidden.hash(&mut h);
    h.finish()
}

/// Hash a `Blur` (background or layer). Used as `params_hash` on
/// `Gather(BackgroundBlur)` cache keys.
pub fn hash_blur_params(b: &Blur) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    b.value.to_bits().hash(&mut h);
    b.hidden.hash(&mut h);
    // BlurType discriminant — Layer vs Background changes semantics.
    std::mem::discriminant(&b.blur_type).hash(&mut h);
    h.finish()
}

/// Hash a single fill. Captures fill-type discriminant for sure;
/// solid colors hash exactly via their u32 ARGB; gradient/image
/// fills hash by discriminant only because their structs hide
/// internals behind private fields. Limitation: gradient handle /
/// stop edits don't flip the hash. Acceptable v1 — gradient
/// param edits are rare and the lru evicts naturally; phase 6b
/// can add public accessors and tighten this.
fn hash_one_fill(f: &Fill, h: &mut std::collections::hash_map::DefaultHasher) {
    std::mem::discriminant(f).hash(h);
    match f {
        Fill::Solid(c) => {
            // skia::Color exposes r/g/b/a as u8 — combine into a u32
            // for hashing.
            let argb = ((c.0.a() as u32) << 24)
                | ((c.0.r() as u32) << 16)
                | ((c.0.g() as u32) << 8)
                | (c.0.b() as u32);
            argb.hash(h);
        }
        Fill::LinearGradient(_)
        | Fill::RadialGradient(_)
        | Fill::AngularGradient(_)
        | Fill::DiamondGradient(_)
        | Fill::Image(_) => {
            // Internals private — discriminant-only contributes.
        }
    }
}

/// Hash all fills on a shape. Returns 0 for empty fills (cheap
/// short-circuit on the common no-fill container case).
pub fn hash_shape_fills(shape: &Shape) -> u64 {
    if shape.fills.is_empty() {
        return 0;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for f in shape.fills.iter() {
        hash_one_fill(f, &mut h);
    }
    h.finish()
}

/// Compute the backdrop hash for a gather shape — fed into
/// `EffectCacheKey::backdrop_hash` so the cached gather snapshot
/// flips iff the pixels behind this shape would actually have
/// changed. Walks tiles intersecting the gather's tile span and
/// XOR-folds each member shape's geometry+fill subhash. XOR is
/// commutative so iteration order doesn't matter — equivalent
/// scenes (same shape set, different walk order) produce equal
/// hashes.
///
/// Pan does not change the gather shape's tile span (world coords
/// fixed) and does not change any member shape's geometry+fills →
/// `backdrop_hash` is stable on pan, gather cache hits every frame.
/// Move-shape-NOT-under-gather: shape is in some other tile, not in
/// this gather's tile span → no contribution → stable. Move-shape
/// UNDER-gather: that shape's `geometry_hash` flips → backdrop_hash
/// flips → cache miss (correct).
pub fn hash_backdrop_for(
    glass_shape: &Shape,
    tile_grid: &TileGrid,
    tree: ShapesPoolRef,
) -> u64 {
    // Tile span for the gather shape itself. `get_tiles_of` returns
    // the tile set the spatial index already maintains for this id.
    let Some(tiles) = tile_grid.get_tiles_of(&glass_shape.id) else {
        return 0;
    };
    let mut combined: u64 = 0;
    for tile in tiles {
        let Some(entries) = tile_grid.get_shapes_at(*tile) else {
            continue;
        };
        for entry in entries {
            // Skip the gather shape itself — its own pixels go on
            // top of the backdrop, not into it.
            if entry.id == glass_shape.id {
                continue;
            }
            let Some(s) = tree.get(&entry.id) else {
                continue;
            };
            let mut h = std::collections::hash_map::DefaultHasher::new();
            entry.id.hash(&mut h);
            hash_shape_geometry(s).hash(&mut h);
            hash_shape_fills(s).hash(&mut h);
            combined ^= h.finish();
        }
    }
    combined
}

/// Estimate the GPU memory footprint of a snapshot. RGBA8 backing —
/// 4 bytes/pixel. Saturating to avoid surprises on huge images.
pub fn estimate_image_bytes(image: &skia::Image) -> u32 {
    (image.width() as u64)
        .saturating_mul(image.height() as u64)
        .saturating_mul(4)
        .min(u32::MAX as u64) as u32
}

/// Effective scale → integer bucket. `bucket = round(log2(scale*dpr))`
/// clamped to `[-3, 5]` (≈0.125× → 32×). One bucket per power of two
/// keeps each cached image close to its native pixel resolution while
/// allowing reuse across small zoom drifts. Phase 3 has no
/// hysteresis — at exact 2× boundaries the bucket flips on every
/// frame and cache thrashes briefly. Acceptable since hold-zoom is
/// the common case; phase 5 adds proper hysteresis if zoom-thrash
/// becomes a real workload.
pub fn compute_scale_bucket(scale: f32, dpr: f32) -> i8 {
    let s = (scale * dpr).max(1e-6);
    let raw = s.log2().round();
    raw.clamp(-3.0, 5.0) as i8
}

/// Maximum cached buckets retained per `(shape_id, effect)`. Caps
/// memory growth from rapid-zoom workloads (which would otherwise
/// fill the cache with all 9 buckets per shape). On insert past this
/// limit the oldest sibling is evicted.
pub const MAX_BUCKETS_PER_SHAPE_EFFECT: usize = 3;

/// Per-entry size limit. Insert is a no-op when the would-be entry
/// is bigger than this. Sized to allow a full 1920×1080 RGBA8
/// Target-surface snapshot (≈8 MB) — that's the heaviest single
/// entry the gather backdrop cache produces today. Bbox-bounded
/// snapshots (followup) shrink most entries below 1 MB and let
/// dense scenes keep more shapes cached at once.
///
/// The point of this cap is to refuse pathologically huge entries
/// (e.g. an export-resolution snapshot accidentally entering the
/// cache) that would single-handedly evict everything else. It is
/// not a tool for pruning normal entries — that's `bytes_cap`'s
/// job.
pub const MAX_BYTES_PER_ENTRY: u32 = 16 * 1024 * 1024;

impl EffectCache {
    /// Drop the oldest bucket for `(shape_id, effect)` when the
    /// per-shape sub-cap is exceeded after a fresh insert. Called
    /// by `BuildCache(Scatter|Gather)` after `effect_cache.insert(...)`.
    /// Linear scan over the LRU iter — n bounded by total cache
    /// size; sub-cap fires only on overshoot.
    pub fn enforce_sub_cap(&mut self, shape_id: Uuid, effect: EffectKey) {
        let mut siblings: Vec<(u32, EffectCacheKey)> = self
            .map
            .iter()
            .filter(|(k, _)| k.shape_id == shape_id && k.effect == effect)
            .map(|(k, e)| (e.last_used_frame, *k))
            .collect();
        if siblings.len() <= MAX_BUCKETS_PER_SHAPE_EFFECT {
            return;
        }
        siblings.sort_by_key(|(f, _)| *f);
        let drop_count = siblings.len() - MAX_BUCKETS_PER_SHAPE_EFFECT;
        for (_, key) in siblings.into_iter().take(drop_count) {
            if let Some(removed) = self.map.pop(&key) {
                self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
                self.stat_evictions = self.stat_evictions.wrapping_add(1);
                crate::perf_count!(effect_cache_evict);
            }
        }
    }

    /// Promote a set of shape ids to the front of the LRU order so
    /// they survive the next `evict_to_cap`. Called by the schedule
    /// builder for shapes intersecting the viewport+margin —
    /// off-viewport shapes age out naturally even if their cache
    /// entries weren't touched this frame. Phase 5 viewport
    /// scoping. O(in-viewport-entries).
    pub fn promote_viewport_shapes(&mut self, ids: &[Uuid]) {
        if ids.is_empty() {
            return;
        }
        // Collect matching keys first — `LruCache::get` mutably
        // borrows `self.map`, so we can't iterate-and-promote in one
        // pass.
        let to_promote: Vec<EffectCacheKey> = self
            .map
            .iter()
            .filter(|(k, _)| ids.contains(&k.shape_id))
            .map(|(k, _)| *k)
            .collect();
        for k in to_promote {
            // `get` bumps recency without overwriting the value.
            let _ = self.map.get(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile_grid::{EffectKey, ScatterFx};

    fn k(shape: u128, frame: u8) -> EffectCacheKey {
        EffectCacheKey {
            shape_id: Uuid::from_u128(shape),
            effect: EffectKey::Scatter(ScatterFx::DropShadows),
            scale_bucket: 0,
            geometry_hash: frame as u64,
            params_hash: 0,
            backdrop_hash: 0,
        }
    }

    fn dummy_value() -> EffectCacheValue {
        // Building a real GPU image needs a context — tests stay at
        // the structural level. Phase 2 lands rendering integration
        // tests against a SwiftShader context.
        // This stub uses a 1x1 raster image which doesn't touch GPU.
        let info = skia::ImageInfo::new_n32_premul((1, 1), None);
        let surface = skia::surfaces::raster(&info, None, None).unwrap();
        let image = surface.image_snapshot();
        EffectCacheValue {
            image,
            world_bbox: skia::Rect::from_xywh(0.0, 0.0, 1.0, 1.0),
        }
    }

    #[test]
    fn empty_after_construction() {
        let c = EffectCache::new();
        assert_eq!(c.len(), 0);
        assert_eq!(c.bytes_used(), 0);
    }

    #[test]
    fn insert_then_get_hits() {
        let mut c = EffectCache::new();
        c.tick_frame();
        let key = k(1, 0);
        c.insert(key, dummy_value(), 4);
        assert_eq!(c.bytes_used(), 4);
        assert!(c.get(&key).is_some());
        assert_eq!(c.stat_hits, 1);
        assert_eq!(c.stat_misses, 1);
    }

    #[test]
    fn evicts_to_cap() {
        let mut c = EffectCache::new();
        c.set_bytes_cap(8);
        for i in 0..4u128 {
            c.tick_frame();
            c.insert(k(i, i as u8), dummy_value(), 4);
        }
        assert!(c.bytes_used() <= 8);
        assert!(c.stat_evictions >= 2);
    }

    #[test]
    fn lru_evicts_oldest_first() {
        let mut c = EffectCache::new();
        c.set_bytes_cap(12);
        c.tick_frame();
        c.insert(k(1, 0), dummy_value(), 4); // oldest
        c.tick_frame();
        c.insert(k(2, 0), dummy_value(), 4);
        c.tick_frame();
        c.insert(k(3, 0), dummy_value(), 4); // bytes=12, at cap
        c.tick_frame();
        // touch k(1, 0) so it's no longer least-recent
        let _ = c.get(&k(1, 0));
        c.insert(k(4, 0), dummy_value(), 4); // bytes=16, evict
        // Whoever is LRU now (k(2,0)) should have been dropped.
        assert!(c.bytes_used() <= 12);
        assert!(c.get(&k(2, 0)).is_none());
        assert!(c.get(&k(1, 0)).is_some()); // recently used, kept
    }
}
