//! Free-list pool of Skia surfaces keyed by `(width, height)`.
//!
//! Logical `SurfaceRef`s in the IR are bound to physical `skia::Surface`s
//! on demand by the dispatcher. When a surface's last reader fires (or
//! an explicit `EraseSurface` runs), the dispatcher calls `release()` —
//! the surface goes back into the pool, drained but kept alive, ready
//! for the next `acquire()` of the same size.
//!
//! Across animation frames the pool retains drained surfaces (within the
//! per-bucket high-water-mark cap), so steady-state animation pays zero
//! allocation cost. Cross-frame surface lifetime is the allocator's
//! concern; logical SSA names are per-frame and have no persistence
//! semantics beyond a single schedule.
//!
//! Acquire/release sites instrument hit/miss counters via
//! `AllocatorStats` so Step 3 tuning can pick pool sizes from data.

use crate::error::Result;
use crate::render::gpu_state::GpuState;
use rustc_hash::FxHashMap;
use skia_safe as skia;

/// Counters surfaced for tuning. Reset between frames by the dispatcher.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AllocatorStats {
    /// `acquire()` calls that found a drained surface in the pool.
    pub hits: u64,
    /// `acquire()` calls that had to create a fresh surface (miss → GPU
    /// allocation). High miss count in steady-state animation is a tuning
    /// signal: bucket cap may be too low, or size classes too granular.
    pub misses: u64,
    /// `release()` calls that returned a surface to the pool.
    pub returns: u64,
    /// `release()` calls that dropped the surface (bucket at high-water
    /// mark). Frequent drops imply the pool is undersized for the workload.
    pub drops: u64,
    /// Concurrent live `acquire`s minus `release`s. Tracked for the
    /// `peak_outstanding` watermark.
    pub outstanding: u64,
    /// Max value `outstanding` reached during the current frame.
    pub peak_outstanding: u64,
}

/// Free-list surface pool.
pub struct SurfaceAllocator {
    pool: FxHashMap<(i32, i32), Vec<skia::Surface>>,
    /// Per-bucket cap. Past this, `release()` drops the surface rather
    /// than retaining it — bounds GPU memory under pathological workloads
    /// (e.g. a one-time scene with hundreds of unique surfaces).
    high_water_mark_per_bucket: usize,
    stats: AllocatorStats,
}

impl SurfaceAllocator {
    /// Default per-bucket cap. Sized to comfortably cover the heaviest
    /// real scene measured today (`iso_glass_3frames_overlap` peaks at
    /// ~6 concurrent same-size surfaces in legacy). Tune in Step 3.
    pub const DEFAULT_HIGH_WATER_MARK: usize = 16;

    pub fn new() -> Self {
        Self::with_high_water_mark(Self::DEFAULT_HIGH_WATER_MARK)
    }

    pub fn with_high_water_mark(high_water_mark_per_bucket: usize) -> Self {
        Self {
            pool: FxHashMap::default(),
            high_water_mark_per_bucket,
            stats: AllocatorStats::default(),
        }
    }

    /// Borrow a surface of the given dimensions. If the pool has a drained
    /// surface of this exact size, returns it (hit). Otherwise creates
    /// one via `GpuState::create_surface_with_dimensions` (miss).
    ///
    /// The returned surface is the caller's to use until `release()`.
    /// The caller is responsible for clearing it before painting if
    /// they need a known starting state — the allocator does not
    /// guarantee a cleared surface (a fresh allocation is zero-cleared
    /// by Skia, but a pooled surface carries the prior contents until
    /// the caller clears).
    pub fn acquire(
        &mut self,
        width: i32,
        height: i32,
        gpu: &mut GpuState,
        label: &str,
    ) -> Result<skia::Surface> {
        let key = (width, height);
        let surface = if let Some(bucket) = self.pool.get_mut(&key) {
            if let Some(surface) = bucket.pop() {
                self.stats.hits += 1;
                surface
            } else {
                self.stats.misses += 1;
                gpu.create_surface_with_dimensions(label.to_string(), width, height)?
            }
        } else {
            self.stats.misses += 1;
            gpu.create_surface_with_dimensions(label.to_string(), width, height)?
        };

        self.stats.outstanding += 1;
        if self.stats.outstanding > self.stats.peak_outstanding {
            self.stats.peak_outstanding = self.stats.outstanding;
        }
        Ok(surface)
    }

    /// Return a surface to the pool. Drops it if the bucket is full.
    /// `width`/`height` must match the dimensions the surface was
    /// acquired at — the allocator trusts the caller here (the
    /// dispatcher always knows because it picked the size).
    pub fn release(&mut self, surface: skia::Surface, width: i32, height: i32) {
        // Decrement first so `outstanding` is consistent even if the
        // bucket is full and we drop the surface.
        self.stats.outstanding = self.stats.outstanding.saturating_sub(1);

        let bucket = self.pool.entry((width, height)).or_default();
        if bucket.len() < self.high_water_mark_per_bucket {
            bucket.push(surface);
            self.stats.returns += 1;
        } else {
            self.stats.drops += 1;
            drop(surface);
        }
    }

    /// Reset frame-scoped counters. Called by the dispatcher between
    /// frames so per-frame stats stay scoped.
    pub fn reset_frame_stats(&mut self) {
        // `outstanding` carries across frames (we may have surfaces
        // legitimately retained mid-yield); the rest are per-frame.
        let outstanding = self.stats.outstanding;
        self.stats = AllocatorStats {
            outstanding,
            peak_outstanding: outstanding,
            ..AllocatorStats::default()
        };
    }

    /// Current stats snapshot. Read by the perf_trace harness.
    pub fn stats(&self) -> AllocatorStats {
        self.stats
    }

    /// Total surfaces currently pooled (across all buckets). Useful for
    /// memory-pressure dashboards.
    pub fn pooled_count(&self) -> usize {
        self.pool.values().map(|b| b.len()).sum()
    }

    /// Drop every pooled surface. Called when the viewbox / GPU context
    /// reset invalidates all backings — e.g. on `webgl_lost_context` or
    /// when the canvas resizes and prior dimensions are no longer reused.
    pub fn clear(&mut self) {
        self.pool.clear();
        // outstanding stays as-is — the dispatcher's in-flight surfaces
        // are still live, they just won't be returned to the pool on
        // release (orphaned drop). That's correct behavior.
    }

    /// Number of distinct size buckets currently holding ≥1 surface.
    /// Used by tests and by Step 3 tuning instrumentation.
    pub fn bucket_count(&self) -> usize {
        self.pool.values().filter(|b| !b.is_empty()).count()
    }
}

impl Default for SurfaceAllocator {
    fn default() -> Self {
        Self::new()
    }
}
