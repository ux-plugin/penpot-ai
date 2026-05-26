//! Logical → physical surface binding for the dispatcher.
//!
//! The dispatcher uses this to resolve a `SurfaceRef` from the IR into
//! a concrete `skia::Surface` it can paint into / read from. Bindings
//! are created lazily on first write (via `bind_for_write_with`) and
//! torn down on kill (`release_with`).
//!
//! Pure-data: holds bindings only, no borrows. Callers thread the
//! `SurfaceAllocator` + `GpuState` through each operation. This keeps
//! the map compatible with `&mut RenderState`-holding sinks — the
//! sink reaches into `state.gpu_state` for the gpu borrow per call,
//! and the borrow checker happily accepts the disjoint-field access.
//!
//! `SurfaceRef::target()` is a **sentinel** — it's never bound in this
//! map. Steps writing to / reading from Target are special-cased by
//! the `DispatchSink` impl, which routes them to the renderer's
//! externally-owned accumulator (`Surfaces.target`).
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

/// Per-schedule surface map. Pure data — no borrows. The `'a` parameter
/// is vestigial (kept so changing it would be a breaking API change
/// that's easy to spot in `git log`); the map itself doesn't borrow
/// anything.
pub struct SurfaceMap<'a> {
    bindings: FxHashMap<SurfaceRef, Binding>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> SurfaceMap<'a> {
    /// Old constructor — kept for back-compat with code that still
    /// passes refs. Ignores the refs.
    pub fn new(_allocator: &'a mut SurfaceAllocator, _gpu: &'a mut GpuState) -> Self {
        Self::new_data_only()
    }

    /// Construct an empty map.
    pub fn new_data_only() -> Self {
        Self {
            bindings: FxHashMap::default(),
            _marker: std::marker::PhantomData,
        }
    }

    /// Acquire a fresh backing for `ref` at the given size. Panics in
    /// debug builds if the ref is already bound — the SSA invariant
    /// the validator enforces is that each non-Target ref is written
    /// exactly once.
    pub fn bind_for_write_with(
        &mut self,
        r: SurfaceRef,
        width: i32,
        height: i32,
        label: &str,
        allocator: &mut SurfaceAllocator,
        gpu: &mut GpuState,
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
        let surface = allocator.acquire(width, height, gpu, label)?;
        let binding = Binding {
            surface,
            width,
            height,
        };
        self.bindings.insert(r, binding);
        Ok(&mut self.bindings.get_mut(&r).unwrap().surface)
    }

    /// Read access to the surface backing `ref`.
    pub fn get(&self, r: SurfaceRef) -> Option<&skia::Surface> {
        self.bindings.get(&r).map(|b| &b.surface)
    }

    /// Mutable access.
    pub fn get_mut(&mut self, r: SurfaceRef) -> Option<&mut skia::Surface> {
        self.bindings.get_mut(&r).map(|b| &mut b.surface)
    }

    /// Take a binding out of the map without releasing it.
    pub fn take(&mut self, r: SurfaceRef) -> Option<Binding> {
        debug_assert!(!r.is_target());
        self.bindings.remove(&r)
    }

    /// Inverse of `take` — put a binding back into the map.
    pub fn put_back(&mut self, r: SurfaceRef, binding: Binding) {
        debug_assert!(!r.is_target());
        self.bindings.insert(r, binding);
    }

    /// Drop the binding for `ref` and return its surface to the
    /// allocator pool.
    pub fn release_with(&mut self, r: SurfaceRef, allocator: &mut SurfaceAllocator) {
        if r.is_target() {
            return;
        }
        if let Some(binding) = self.bindings.remove(&r) {
            allocator.release(binding.surface, binding.width, binding.height);
        }
    }

    /// Number of currently-bound refs.
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
    /// to the allocator pool.
    pub fn drain_with(&mut self, allocator: &mut SurfaceAllocator) {
        let refs: Vec<SurfaceRef> = self.bindings.keys().copied().collect();
        for r in refs {
            self.release_with(r, allocator);
        }
    }
}

impl<'a> Drop for SurfaceMap<'a> {
    fn drop(&mut self) {
        // If the map drops with live bindings, the surfaces inside drop
        // (orphaned from the pool — they'll be re-created on next use).
        // Production paths call `drain_with` before drop; this is a
        // safety net for panics.
    }
}
