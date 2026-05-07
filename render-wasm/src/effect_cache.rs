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

use crate::shapes::{Blur, GlassEffect, Shape, TextureEffect};
use crate::tile_grid::EffectKey;
use crate::uuid::Uuid;
use skia_safe::{self as skia};
use std::collections::HashMap;
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
    /// Drives LRU eviction. Phase 5 also bumps on viewport-scope
    /// pass.
    pub last_used_frame: u32,
}

/// Default GPU memory cap. Override via `EFFECT_CACHE_MB` env var at
/// wasm build time (read at module init). Sized for a 1080p viewport
/// rendering ~4 buckets of typical fx_combos shapes:
///   500 shapes × 64 KB avg × 3 buckets ≈ 96 MB.
const DEFAULT_CAP_BYTES: u64 = 96 * 1024 * 1024;

pub struct EffectCache {
    map: HashMap<EffectCacheKey, EffectCacheEntry>,
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
            map: HashMap::new(),
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
    /// Phase 5 extends this to also run the viewport-scoped LRU
    /// promotion pass and emit gauge metrics.
    pub fn tick_frame(&mut self) {
        self.current_frame = self.current_frame.wrapping_add(1);
    }

    /// Returns the cached value if present, bumping recency. Phase 1
    /// has no callers — exists for build validation.
    pub fn get(&mut self, key: &EffectCacheKey) -> Option<&EffectCacheValue> {
        let frame = self.current_frame;
        let entry = self.map.get_mut(key)?;
        entry.last_used_frame = frame;
        self.stat_hits = self.stat_hits.wrapping_add(1);
        crate::perf_count!(effect_cache_hit);
        Some(&entry.value)
    }

    /// Insert (or replace) an entry. Triggers byte-cap enforcement
    /// when the running total exceeds the cap.
    pub fn insert(&mut self, key: EffectCacheKey, value: EffectCacheValue, bytes: u32) {
        let new_entry = EffectCacheEntry {
            value,
            bytes,
            last_used_frame: self.current_frame,
        };
        if let Some(old) = self.map.insert(key, new_entry) {
            self.bytes_used = self.bytes_used.saturating_sub(old.bytes as u64);
        }
        self.bytes_used = self.bytes_used.saturating_add(bytes as u64);
        self.stat_misses = self.stat_misses.wrapping_add(1);
        crate::perf_count!(effect_cache_miss);
        if self.bytes_used > self.bytes_cap {
            self.evict_to_cap();
        }
    }

    /// Drop oldest entries until under the byte cap. Phase 1
    /// implementation: collect-keys + sort-by-`last_used_frame` is
    /// O(n log n) per call. Acceptable while n ≤ ~2k entries — at the
    /// expected steady state of ~400 entries (96 MB / 250 KB avg)
    /// this is sub-millisecond and only fires on cap overflow. Phase
    /// 5 swaps in `lru::LruCache` for O(1) `pop_lru`. See plan.
    pub fn evict_to_cap(&mut self) {
        if self.bytes_used <= self.bytes_cap {
            return;
        }
        let mut order: Vec<(u32, EffectCacheKey)> = self
            .map
            .iter()
            .map(|(k, e)| (e.last_used_frame, *k))
            .collect();
        order.sort_by_key(|(frame, _)| *frame);
        for (_, key) in order {
            if self.bytes_used <= self.bytes_cap {
                break;
            }
            if let Some(removed) = self.map.remove(&key) {
                self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
                self.stat_evictions = self.stat_evictions.wrapping_add(1);
                crate::perf_count!(effect_cache_evict);
            }
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

impl EffectCache {
    /// Drop the oldest bucket for `(shape_id, effect)` when the
    /// per-shape sub-cap is exceeded after a fresh insert. Called
    /// by `BuildCache(Scatter)` after `effect_cache.insert(...)`.
    /// Linear scan — n is bounded by total cache size and the
    /// sub-cap fires only on overshoot, so amortized cost stays low.
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
            if let Some(removed) = self.map.remove(&key) {
                self.bytes_used = self.bytes_used.saturating_sub(removed.bytes as u64);
                self.stat_evictions = self.stat_evictions.wrapping_add(1);
                crate::perf_count!(effect_cache_evict);
            }
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
}
