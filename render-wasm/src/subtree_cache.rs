//! Cross-frame cache for rasterized subtree images. Keyed by
//! `(root_id, revision, scale_bucket, backdrop_fingerprint)`. The
//! cache module itself is intentionally **dumb** — it knows nothing
//! about scheduling, promotion policy, or how the fingerprint is
//! computed. Callers (P3 + P4) compute keys and decide when to probe.
//!
//! ## Invalidation contract
//!
//! - `revision` is bumped by `State::touch_shape` on every FFI mutation
//!   (P1, shipped). Walk goes up the parent chain so any ancestor whose
//!   rasterized output depends on a mutated descendant also flips its
//!   revision and therefore its cache key.
//! - `backdrop_fingerprint` is a P3-managed XOR-fold of
//!   `effect_cache::hash_backdrop_for` over every Gather (glass /
//!   background blur) descendant of the subtree root. Computed once
//!   per scene rebuild at schedule build, stored on the shape, read at
//!   probe. `0` for subtrees with no Gather descendants.
//! - `scale_bucket` is `round(log2(scale * dpr))` clamped `[-3, 5]`.
//!   Reused from `effect_cache::compute_scale_bucket` for cross-cache
//!   parity.
//!
//! ## P2 scope (this file)
//!
//! Module + types + LRU bookkeeping + tests only. No render-path
//! reads or writes. Wired into `RenderState` next to `effect_cache`,
//! `tick_frame` advances every render entry. Validates plumbing
//! without behaviour change — visual output identical to develop.
//!
//! ## Subsequent phases
//!
//! - P3: bottom-up `backdrop_fingerprint` fold at schedule build,
//!   inline promotion predicate at probe.
//! - P4: capture path — render miss → render-into-image → insert.
//! - P5: replay path — hit → blit cached image at correct transform.
//! - P6: explicit `invalidate_root` hooks for shape-delete.
//!
//! Gated on `tile-scheduler` because the cache is a V2-only optimization
//! — V1 has no use for it.

#![cfg(feature = "tile-scheduler")]

use crate::uuid::Uuid;
use lru::LruCache;
use skia_safe::{self as skia};

/// Reuse `effect_cache::compute_scale_bucket` so both caches map
/// (scale, dpr) → bucket identically. Avoids subtle drift if the
/// formula ever evolves.
pub use crate::effect_cache::compute_scale_bucket;

/// Reuse `effect_cache::estimate_image_bytes` for symmetry with the
/// effect-cache byte-accounting.
pub use crate::effect_cache::estimate_image_bytes;

/// Default GPU memory cap for the subtree cache. Smaller than
/// `effect_cache`'s 96 MB because subtree images are larger per-entry
/// (whole-subtree raster vs single-effect output) and we want headroom
/// for both caches to coexist without cumulatively blowing the wasm32
/// heap.
const DEFAULT_CAP_BYTES: u64 = 64 * 1024 * 1024;

/// Per-entry size limit. Snapshots larger than this skip insert
/// silently (counted as a "skipped" stat, not a miss). Caps at
/// roughly a 2K × 2K RGBA8 raster — covers typical viewport-sized
/// subtrees, blocks pathological full-canvas snapshots from
/// single-handedly evicting the rest of the cache.
pub const MAX_BYTES_PER_ENTRY: u32 = 16 * 1024 * 1024;

/// Maximum cached entries retained per `root_id`. One active revision
/// × ~4 scale_buckets covers smooth zoom; revision bumps create new
/// keys naturally and the oldest sibling (lowest `last_used_frame`)
/// drops on overshoot.
pub const MAX_ENTRIES_PER_ROOT: usize = 4;

/// Composite key. All fields participate in equality so a same-content
/// + same-scale subtree hits cache, while any mutation flips
/// `revision` (or `backdrop_fingerprint`, P3+) and forces a re-render.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct SubtreeCacheKey {
    pub root_id: Uuid,
    /// `Shape::revision` at capture time. Bumped via `State::touch_shape`
    /// on FFI mutations (P1).
    pub revision: u32,
    /// `round(log2(scale * dpr))` clamped `[-3, 5]`. Matches
    /// `effect_cache::compute_scale_bucket`.
    pub scale_bucket: i8,
    /// XOR-fold of `effect_cache::hash_backdrop_for` over every
    /// Gather descendant of this subtree's root. `0` when subtree has
    /// no Gather descendants. Computed by callers at probe (P3); cache
    /// itself never computes it.
    pub backdrop_fingerprint: u64,
}

#[derive(Clone)]
pub struct SubtreeCacheValue {
    /// GPU-backed image of the rasterized subtree.
    pub image: skia::Image,
    /// Top-left of `image` in the subtree-local device-pixel coord
    /// system. Subtree origin may not be at (0, 0) of `image` if the
    /// extrect leaks negative — for example, a drop shadow that
    /// extends left/up of the shape's selrect requires extra padding
    /// in the captured raster, and the offset records where the
    /// "actual shape origin" sits inside the image.
    pub bounds_origin_devpx: skia::IPoint,
}

pub struct SubtreeCacheEntry {
    pub value: SubtreeCacheValue,
    /// Estimated GPU memory footprint (`width * height * 4`). Used
    /// for the byte-cap eviction loop.
    pub bytes: u32,
    /// Last frame this entry was returned from `get` or first
    /// inserted. Bumped on `LruCache::get` automatically; we still
    /// track it explicitly so per-root sub-cap enforcement can scan
    /// siblings without iterating the LRU's internal recency list
    /// twice.
    pub last_used_frame: u32,
}

pub struct SubtreeCache {
    /// `lru` crate gives O(1) `get` (recency-bumping), O(1) `put`,
    /// and O(1) `pop_lru` for byte-cap eviction. We pass
    /// `LruCache::unbounded()` and enforce eviction by bytes ourselves
    /// — `LruCache` doesn't support byte caps natively, only count
    /// caps.
    map: LruCache<SubtreeCacheKey, SubtreeCacheEntry>,
    bytes_used: u64,
    bytes_cap: u64,
    /// Wraps every `tick_frame`. Used as the recency timestamp for
    /// `last_used_frame`; `u32` overflow at 2^32 frames ≈ 2 years at
    /// 60 Hz so safe to wrap.
    current_frame: u32,
    /// Cumulative counters. Plain fields here so non-`perf-trace`
    /// builds also account; `perf-trace` adapters in the render loop
    /// (P4+) mirror them into the per-frame snapshot for the
    /// `perf:diff` consumer.
    pub stat_hits: u64,
    pub stat_misses: u64,
    pub stat_evictions: u64,
    /// Inserts skipped because the would-be entry exceeds
    /// `MAX_BYTES_PER_ENTRY`. Tracked separately from hits/misses so
    /// the diagnostic surface can flag pathological-subtree workloads.
    pub stat_skipped_oversize: u64,
}

impl SubtreeCache {
    pub fn new() -> Self {
        Self {
            // `LruCache::unbounded` does not pre-allocate; passing a
            // finite count cap with `usize::MAX` aborted under
            // emscripten in `effect_cache` because `LruCache::new`
            // does up-front allocation tied to capacity. Mirror that
            // pattern here.
            map: LruCache::unbounded(),
            bytes_used: 0,
            bytes_cap: DEFAULT_CAP_BYTES,
            current_frame: 0,
            stat_hits: 0,
            stat_misses: 0,
            stat_evictions: 0,
            stat_skipped_oversize: 0,
        }
    }

    /// Bump the recency clock. Called at the top of every render
    /// entry point alongside `effect_cache.tick_frame()`.
    pub fn tick_frame(&mut self) {
        self.current_frame = self.current_frame.wrapping_add(1);
    }

    /// Returns the cached value if present. `LruCache::get` bumps the
    /// entry to the front of the recency list in O(1). Also refreshes
    /// `last_used_frame` so per-root sub-cap enforcement sees current
    /// recency.
    pub fn get(&mut self, key: &SubtreeCacheKey) -> Option<&SubtreeCacheValue> {
        let frame = self.current_frame;
        let entry = self.map.get_mut(key)?;
        entry.last_used_frame = frame;
        self.stat_hits = self.stat_hits.wrapping_add(1);
        crate::perf_count!(subtree_cache_hit);
        Some(&entry.value)
    }

    /// Insert (or replace) an entry. `LruCache::put` returns the
    /// displaced value if the key was already present so the byte
    /// total can adjust. Cap enforcement runs after the insert via
    /// `evict_to_cap` — O(k) where k is entries dropped.
    ///
    /// Inserts where `bytes > MAX_BYTES_PER_ENTRY` are silently
    /// skipped and tallied as `stat_skipped_oversize` so a single
    /// pathological snapshot doesn't displace the rest of the cache.
    /// Callers should still treat the call as completing — the cache
    /// just won't have an entry for the key on the next probe.
    pub fn insert(&mut self, key: SubtreeCacheKey, value: SubtreeCacheValue, bytes: u32) {
        if bytes > MAX_BYTES_PER_ENTRY {
            self.stat_skipped_oversize = self.stat_skipped_oversize.wrapping_add(1);
            crate::perf_count!(subtree_cache_skip_oversize);
            return;
        }
        let new_entry = SubtreeCacheEntry {
            value,
            bytes,
            last_used_frame: self.current_frame,
        };
        if let Some(old) = self.map.put(key, new_entry) {
            self.bytes_used = self.bytes_used.saturating_sub(old.bytes as u64);
        }
        self.bytes_used = self.bytes_used.saturating_add(bytes as u64);
        self.stat_misses = self.stat_misses.wrapping_add(1);
        crate::perf_count!(subtree_cache_miss);
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
            crate::perf_count!(subtree_cache_evict);
        }
    }

    /// Cap entries-per-root: when more than `MAX_ENTRIES_PER_ROOT`
    /// keys share a `root_id`, drop the oldest siblings (lowest
    /// `last_used_frame`) until at the cap. Called after a fresh
    /// insert by callers that want to enforce per-shape memory
    /// fairness — typically right after `insert(...)`.
    ///
    /// Linear scan over the LRU iter; n bounded by total cache size.
    /// Sub-cap fires only on overshoot, so the scan amortizes well.
    pub fn enforce_sub_cap(&mut self, root_id: Uuid) {
        let mut siblings: Vec<(u32, SubtreeCacheKey)> = self
            .map
            .iter()
            .filter(|(k, _)| k.root_id == root_id)
            .map(|(k, e)| (e.last_used_frame, *k))
            .collect();
        if siblings.len() <= MAX_ENTRIES_PER_ROOT {
            return;
        }
        siblings.sort_by_key(|(f, _)| *f);
        let drop_count = siblings.len() - MAX_ENTRIES_PER_ROOT;
        for (_, key) in siblings.into_iter().take(drop_count) {
            if let Some(removed) = self.map.pop(&key) {
                self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
                self.stat_evictions = self.stat_evictions.wrapping_add(1);
                crate::perf_count!(subtree_cache_evict);
            }
        }
    }

    /// Drop every entry whose key's `root_id` matches. Used by the
    /// shape-delete path (P6) and for explicit invalidation when the
    /// caller knows revision bumping won't suffice — for example, a
    /// shape removed entirely from the scene leaves stale entries
    /// that would otherwise sit until LRU eviction.
    pub fn invalidate_root(&mut self, root_id: Uuid) {
        let to_drop: Vec<SubtreeCacheKey> = self
            .map
            .iter()
            .filter(|(k, _)| k.root_id == root_id)
            .map(|(k, _)| *k)
            .collect();
        for key in to_drop {
            if let Some(removed) = self.map.pop(&key) {
                self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
                self.stat_evictions = self.stat_evictions.wrapping_add(1);
                crate::perf_count!(subtree_cache_evict);
            }
        }
    }

    /// Promote a set of root ids to the front of the LRU order so they
    /// survive the next `evict_to_cap`. Called by the schedule builder
    /// for shapes intersecting the viewport — off-viewport shapes age
    /// out naturally even if their cache entries weren't touched this
    /// frame. P3+ viewport scoping. O(in-viewport-entries).
    pub fn promote_viewport(&mut self, root_ids: &[Uuid]) {
        if root_ids.is_empty() {
            return;
        }
        // Collect matching keys first — `LruCache::get` mutably
        // borrows `self.map`, so we can't iterate-and-promote in one
        // pass.
        let to_promote: Vec<SubtreeCacheKey> = self
            .map
            .iter()
            .filter(|(k, _)| root_ids.contains(&k.root_id))
            .map(|(k, _)| *k)
            .collect();
        for k in to_promote {
            // `get` bumps recency without overwriting the value; we
            // ignore the returned reference.
            let _ = self.map.get(&k);
        }
    }

    /// Drop everything. Used on viewport reset, scene rebuild, or
    /// catastrophic invalidation (P6+).
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
    /// new cap is below current usage. Used by tests and for future
    /// runtime tuning hooks (e.g. wapi extern in P8).
    pub fn set_bytes_cap(&mut self, cap: u64) {
        self.bytes_cap = cap;
        self.evict_to_cap();
    }
}

impl Default for SubtreeCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(shape: u128, rev: u32, bucket: i8, fp: u64) -> SubtreeCacheKey {
        SubtreeCacheKey {
            root_id: Uuid::from_u128(shape),
            revision: rev,
            scale_bucket: bucket,
            backdrop_fingerprint: fp,
        }
    }

    fn dummy_value() -> SubtreeCacheValue {
        // Building a real GPU image needs a context — tests stay at
        // the structural level. Capture/replay integration tests live
        // in P4+ where they can run against a real GPU surface in the
        // playwright harness.
        let info = skia::ImageInfo::new_n32_premul((1, 1), None);
        let surface = skia::surfaces::raster(&info, None, None).unwrap();
        let image = surface.image_snapshot();
        SubtreeCacheValue {
            image,
            bounds_origin_devpx: skia::IPoint::new(0, 0),
        }
    }

    #[test]
    fn empty_after_construction() {
        let c = SubtreeCache::new();
        assert_eq!(c.len(), 0);
        assert_eq!(c.bytes_used(), 0);
        assert!(c.is_empty());
    }

    #[test]
    fn insert_then_get_hits() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        let key = k(1, 0, 0, 0);
        c.insert(key, dummy_value(), 4);
        assert_eq!(c.bytes_used(), 4);
        assert!(c.get(&key).is_some());
        assert_eq!(c.stat_hits, 1);
        assert_eq!(c.stat_misses, 1);
    }

    #[test]
    fn miss_returns_none() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        let key = k(1, 0, 0, 0);
        assert!(c.get(&key).is_none());
        assert_eq!(c.stat_hits, 0);
    }

    #[test]
    fn revision_change_misses() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 5, 0, 0), dummy_value(), 4);
        // Same shape, same bucket, different revision — different key
        assert!(c.get(&k(1, 6, 0, 0)).is_none());
        assert!(c.get(&k(1, 5, 0, 0)).is_some());
    }

    #[test]
    fn scale_bucket_change_misses() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4);
        assert!(c.get(&k(1, 0, 1, 0)).is_none());
    }

    #[test]
    fn backdrop_fingerprint_change_misses() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 0, 0, 0xabcd), dummy_value(), 4);
        // Same shape/rev/bucket, different backdrop — must miss
        assert!(c.get(&k(1, 0, 0, 0xdcba)).is_none());
        assert!(c.get(&k(1, 0, 0, 0xabcd)).is_some());
    }

    #[test]
    fn evicts_to_cap() {
        let mut c = SubtreeCache::new();
        c.set_bytes_cap(8);
        for i in 0..4u128 {
            c.tick_frame();
            c.insert(k(i, 0, 0, 0), dummy_value(), 4);
        }
        assert!(c.bytes_used() <= 8);
        assert!(c.stat_evictions >= 2);
    }

    #[test]
    fn lru_evicts_oldest_first() {
        let mut c = SubtreeCache::new();
        c.set_bytes_cap(12);
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4); // oldest
        c.tick_frame();
        c.insert(k(2, 0, 0, 0), dummy_value(), 4);
        c.tick_frame();
        c.insert(k(3, 0, 0, 0), dummy_value(), 4); // bytes=12, at cap
        c.tick_frame();
        // touch k(1, ...) so it's no longer least-recent
        let _ = c.get(&k(1, 0, 0, 0));
        c.insert(k(4, 0, 0, 0), dummy_value(), 4); // bytes=16, evict
        // LRU now is k(2,...) — should have been dropped.
        assert!(c.bytes_used() <= 12);
        assert!(c.get(&k(2, 0, 0, 0)).is_none());
        assert!(c.get(&k(1, 0, 0, 0)).is_some()); // recently used, kept
    }

    #[test]
    fn oversize_entry_skipped() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        let oversize = MAX_BYTES_PER_ENTRY + 1;
        c.insert(k(1, 0, 0, 0), dummy_value(), oversize);
        // Insert silently dropped — counted as skip, not miss.
        assert_eq!(c.len(), 0);
        assert_eq!(c.bytes_used(), 0);
        assert_eq!(c.stat_skipped_oversize, 1);
        assert_eq!(c.stat_misses, 0);
    }

    #[test]
    fn enforce_sub_cap_keeps_recent() {
        let mut c = SubtreeCache::new();
        // Insert MAX_ENTRIES_PER_ROOT + 2 entries for the same root,
        // each at a different revision. Touch the most-recent ones
        // explicitly so the eviction predictably drops the older.
        let root = 42u128;
        for i in 0..(MAX_ENTRIES_PER_ROOT as u32 + 2) {
            c.tick_frame();
            c.insert(k(root, i, 0, 0), dummy_value(), 4);
        }
        c.enforce_sub_cap(Uuid::from_u128(root));
        // After enforcement: <= MAX_ENTRIES_PER_ROOT siblings remain.
        let remaining = c
            .map
            .iter()
            .filter(|(k, _)| k.root_id == Uuid::from_u128(root))
            .count();
        assert_eq!(remaining, MAX_ENTRIES_PER_ROOT);
        // The most-recent inserts (highest revisions) should still be
        // present; the earliest should be gone.
        assert!(c.get(&k(root, 0, 0, 0)).is_none());
        assert!(c.get(&k(root, MAX_ENTRIES_PER_ROOT as u32 + 1, 0, 0)).is_some());
    }

    #[test]
    fn invalidate_root_drops_matching_only() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4);
        c.insert(k(1, 1, 0, 0), dummy_value(), 4);
        c.insert(k(2, 0, 0, 0), dummy_value(), 4);
        c.invalidate_root(Uuid::from_u128(1));
        assert!(c.get(&k(1, 0, 0, 0)).is_none());
        assert!(c.get(&k(1, 1, 0, 0)).is_none());
        // Other root untouched.
        assert!(c.get(&k(2, 0, 0, 0)).is_some());
    }

    #[test]
    fn promote_viewport_bumps_recency() {
        let mut c = SubtreeCache::new();
        c.set_bytes_cap(12);
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4); // would be LRU
        c.tick_frame();
        c.insert(k(2, 0, 0, 0), dummy_value(), 4);
        c.tick_frame();
        c.insert(k(3, 0, 0, 0), dummy_value(), 4); // at cap
        // Promote shape 1 to front — should now survive the next
        // eviction in preference to shape 2.
        c.promote_viewport(&[Uuid::from_u128(1)]);
        c.tick_frame();
        c.insert(k(4, 0, 0, 0), dummy_value(), 4); // forces eviction
        assert!(c.bytes_used() <= 12);
        assert!(c.get(&k(1, 0, 0, 0)).is_some(), "promoted shape kept");
        assert!(c.get(&k(2, 0, 0, 0)).is_none(), "true LRU evicted");
    }

    #[test]
    fn clear_drops_everything() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4);
        c.insert(k(2, 0, 0, 0), dummy_value(), 4);
        c.clear();
        assert_eq!(c.len(), 0);
        assert_eq!(c.bytes_used(), 0);
        assert!(c.get(&k(1, 0, 0, 0)).is_none());
    }

    #[test]
    fn set_bytes_cap_evicts_immediately() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        c.insert(k(1, 0, 0, 0), dummy_value(), 4);
        c.tick_frame();
        c.insert(k(2, 0, 0, 0), dummy_value(), 4);
        c.tick_frame();
        c.insert(k(3, 0, 0, 0), dummy_value(), 4);
        assert_eq!(c.bytes_used(), 12);
        c.set_bytes_cap(4);
        assert!(c.bytes_used() <= 4);
        assert!(c.stat_evictions >= 2);
    }

    #[test]
    fn replace_existing_key_does_not_double_count() {
        let mut c = SubtreeCache::new();
        c.tick_frame();
        let key = k(1, 0, 0, 0);
        c.insert(key, dummy_value(), 4);
        assert_eq!(c.bytes_used(), 4);
        // Re-insert under the same key — bytes_used should not grow.
        c.insert(key, dummy_value(), 4);
        assert_eq!(c.bytes_used(), 4);
        assert_eq!(c.len(), 1);
    }
}
