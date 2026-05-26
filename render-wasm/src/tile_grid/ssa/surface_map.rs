//! Logical → physical surface binding for the dispatcher.
//!
//! The dispatcher uses this to resolve a `SurfaceRef` from the IR into
//! a concrete `skia::Surface` it can paint into / read from. Bindings
//! are created lazily on first write (via `bind_for_write`) and torn
//! down on kill (`release`).
//!
//! `SurfaceRef::target()` is a **sentinel** — it's never bound in this
//! map. Steps writing to / reading from Target are special-cased by
//! the `DispatchSink` impl, which routes them to the renderer's
//! externally-owned accumulator (`Surfaces.target`). Keeping Target
//! out of the map avoids fighting Skia's non-`Clone` surfaces.
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
    /// Active bindings — one per live non-Target `SurfaceRef`.
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

    /// Acquire a fresh backing for `ref` at the given size. Panics in
    /// debug builds if the ref is already bound — the SSA invariant
    /// the validator enforces is that each non-Target ref is written
    /// exactly once.
    ///
    /// `Target` is rejected here in debug builds — it's a sentinel
    /// that the sink handles directly, not a poolable surface.
    pub fn bind_for_write(
        &mut self,
        r: SurfaceRef,
        width: i32,
        height: i32,
        label: &str,
    ) -> Result<&mut skia::Surface> {
        debug_assert!(
            !r.is_target(),
            "SurfaceMap should never bind Target — it's a sentinel"
        );
        debug_assert!(
            !self.bindings.contains_key(&r),
            "SSA violation: rebinding {:?} (already bound)",
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

    /// Read access to the surface backing `ref`. Returns `None` for
    /// `Target` (use the renderer's `Surfaces.target` directly) and
    /// for unbound refs (validator should have caught this earlier).
    pub fn get(&self, r: SurfaceRef) -> Option<&skia::Surface> {
        self.bindings.get(&r).map(|b| &b.surface)
    }

    /// Mutable access. Same caveat as `get`.
    pub fn get_mut(&mut self, r: SurfaceRef) -> Option<&mut skia::Surface> {
        self.bindings.get_mut(&r).map(|b| &mut b.surface)
    }

    /// Take a surface out of the map without releasing it to the pool.
    /// Used by the `ProductionSink`'s adapter pattern: it pulls the
    /// pooled surface out, temporarily installs it in `Surfaces.current`
    /// for the legacy render call, then puts it back via `put_back`.
    pub fn take(&mut self, r: SurfaceRef) -> Option<Binding> {
        debug_assert!(
            !r.is_target(),
            "Target is a sentinel — never present in the map"
        );
        self.bindings.remove(&r)
    }

    /// Inverse of `take` — put a binding back into the map under the
    /// given ref. Called after the legacy render adapter finishes.
    pub fn put_back(&mut self, r: SurfaceRef, binding: Binding) {
        debug_assert!(!r.is_target());
        self.bindings.insert(r, binding);
    }

    /// Drop the binding for `ref` and return its surface to the
    /// allocator pool. No-op for `Target` (not in the map).
    pub fn release(&mut self, r: SurfaceRef) {
        if r.is_target() {
            return;
        }
        if let Some(binding) = self.bindings.remove(&r) {
            self.allocator
                .release(binding.surface, binding.width, binding.height);
        }
    }

    /// Number of currently-bound refs. Used by tests and by the
    /// dispatcher's end-of-schedule invariant check.
    pub fn live_count(&self) -> usize {
        self.bindings.len()
    }

    /// True if `ref` has a live binding. `Target` always returns true
    /// — it's the externally-owned accumulator, perpetually available.
    pub fn is_bound(&self, r: SurfaceRef) -> bool {
        if r.is_target() {
            return true;
        }
        self.bindings.contains_key(&r)
    }

    /// Drain at end of schedule. Every remaining binding is returned
    /// to the allocator pool. The validator should have ensured no
    /// leaks, but we drain defensively.
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
