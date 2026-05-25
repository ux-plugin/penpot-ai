//! Logical → physical surface binding for the dispatcher.
//!
//! The dispatcher uses this to resolve a `SurfaceRef` from the IR into
//! a concrete `skia::Surface` it can paint into / read from. Bindings
//! are created lazily on first write (via `bind_for_write`) and torn
//! down explicitly on kill (`release`). `Target` is a special case —
//! it's bound externally to the renderer's accumulator surface and
//! lives across the entire schedule.
//!
//! Per-frame lifetime: created at schedule start, drained at end. The
//! allocator backing the physical surfaces survives between frames so
//! steady-state animation pays zero allocation cost.

use rustc_hash::FxHashMap;
use skia_safe as skia;

use super::allocator::SurfaceAllocator;
use super::surface_ref::SurfaceRef;
use crate::error::Result;
use crate::render::gpu_state::GpuState;

/// What the dispatcher needs to know about a physical surface backing
/// a logical `SurfaceRef`. The `(width, height)` is retained so we can
/// hand it back to the allocator on release without re-querying Skia.
pub struct Binding {
    pub surface: skia::Surface,
    pub width: i32,
    pub height: i32,
}

/// Per-schedule surface map. Borrows the allocator and GPU context so
/// it can lazily acquire backings.
pub struct SurfaceMap<'a> {
    /// Active bindings — one per live `SurfaceRef`.
    bindings: FxHashMap<SurfaceRef, Binding>,
    allocator: &'a mut SurfaceAllocator,
    gpu: &'a mut GpuState,
}

impl<'a> SurfaceMap<'a> {
    pub fn new(allocator: &'a mut SurfaceAllocator, gpu: &'a mut GpuState) -> Self {
        Self {
            bindings: FxHashMap::default(),
            allocator,
            gpu,
        }
    }

    /// Bind `Target` to an externally-owned surface (the renderer's
    /// `Surfaces.target`). The map does NOT take ownership — on
    /// `drain()` Target is just dropped from the map without going
    /// back to the allocator.
    ///
    /// Note: skia::Surface doesn't implement Clone, so we use the
    /// caller-passed surface by-value here and don't put it in the
    /// allocator pool. Released via `release_external_target` at the
    /// end of the schedule.
    pub fn bind_target(&mut self, surface: skia::Surface, width: i32, height: i32) {
        let r = SurfaceRef::target();
        self.bindings.insert(
            r,
            Binding {
                surface,
                width,
                height,
            },
        );
    }

    /// Acquire a fresh backing for `ref` at the given size. Panics in
    /// debug builds if the ref is already bound — the SSA invariant
    /// the validator enforces is that each non-Target ref is written
    /// exactly once.
    pub fn bind_for_write(
        &mut self,
        r: SurfaceRef,
        width: i32,
        height: i32,
        label: &str,
    ) -> Result<&mut skia::Surface> {
        debug_assert!(
            r.is_target() || !self.bindings.contains_key(&r),
            "SSA violation: rebinding non-Target ref {:?} (already bound)",
            r
        );
        let surface = self.allocator.acquire(width, height, self.gpu, label)?;
        let binding = Binding {
            surface,
            width,
            height,
        };
        self.bindings.insert(r, binding);
        // `unwrap` safe — we just inserted.
        Ok(&mut self.bindings.get_mut(&r).unwrap().surface)
    }

    /// Read access to the surface backing `ref`. Returns `None` if
    /// the ref isn't bound (validator should have caught this earlier).
    pub fn get(&self, r: SurfaceRef) -> Option<&skia::Surface> {
        self.bindings.get(&r).map(|b| &b.surface)
    }

    /// Mutable access. Same caveat as `get`. Used by `Composite` and
    /// any step that writes to a pre-existing surface (i.e. Target).
    pub fn get_mut(&mut self, r: SurfaceRef) -> Option<&mut skia::Surface> {
        self.bindings.get_mut(&r).map(|b| &mut b.surface)
    }

    /// Drop the binding for `ref` and return its surface to the
    /// allocator pool (for non-Target refs). Target bindings are
    /// dropped silently without returning to the pool — they're
    /// externally owned.
    pub fn release(&mut self, r: SurfaceRef) {
        if let Some(binding) = self.bindings.remove(&r) {
            if !r.is_target() {
                self.allocator
                    .release(binding.surface, binding.width, binding.height);
            }
            // For Target: surface drops, externally owned reference is
            // gone. Caller (Dispatcher::finish) should snatch it back
            // via `take_external_target` before calling drain().
        }
    }

    /// Pull Target's surface out without releasing to the pool. Used
    /// by the dispatcher at schedule end so the caller can hand the
    /// Target surface back to `Surfaces`.
    pub fn take_external_target(&mut self) -> Option<skia::Surface> {
        self.bindings
            .remove(&SurfaceRef::target())
            .map(|b| b.surface)
    }

    /// Number of currently-bound refs. Used by tests and by the
    /// dispatcher's end-of-schedule invariant check.
    pub fn live_count(&self) -> usize {
        self.bindings.len()
    }

    /// True if `ref` has a live binding.
    pub fn is_bound(&self, r: SurfaceRef) -> bool {
        self.bindings.contains_key(&r)
    }

    /// Drain at end of schedule. Every remaining binding (except
    /// Target, which the caller should already have taken) is
    /// returned to the allocator pool. The validator should have
    /// ensured no leaks, but we drain defensively.
    pub fn drain(&mut self) {
        let refs: Vec<SurfaceRef> = self.bindings.keys().copied().collect();
        for r in refs {
            self.release(r);
        }
    }
}

impl<'a> Drop for SurfaceMap<'a> {
    fn drop(&mut self) {
        // Safety net — if the dispatcher panics mid-schedule, drain
        // the map so allocated surfaces don't leak.
        self.drain();
    }
}
