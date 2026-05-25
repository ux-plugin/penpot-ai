//! Flat-loop step interpreter — the SSA IR's run-time.
//!
//! Replaces `run_schedule`'s ~700-line match over `RenderStep` plus the
//! implicit `Surfaces.current`/`scope_allocations`/`glass_backdrop_cache`
//! global state. Each step is self-contained: the dispatcher resolves
//! operands through `SurfaceMap`/`SurfaceAllocator`, calls the per-variant
//! handler, and updates the binding set. No scope stack, no current-tile
//! flag, no implicit cache lookups.
//!
//! Checkpoint B delivers the dispatch skeleton with **stub** per-variant
//! handlers. Each handler:
//!
//! - Resolves operands (creating bindings for `write_to`, asserting
//!   bindings exist for `read_from`)
//! - Records what it would have done into a `DispatchTrace` (if one
//!   is attached) so tests can verify operand resolution without GL
//! - Returns Ok(())
//!
//! Real rendering lands in Checkpoint C when `ScheduleBuilder` is
//! wired up; the handlers will dispatch to existing `render::*`
//! functions at that point.

use skia_safe as skia;

use super::allocator::SurfaceAllocator;
use super::step::{EffectKey, GatherFx, LayerPaint, Step};
use super::surface_map::SurfaceMap;
use super::surface_ref::SurfaceRef;
use super::validator::IrValidator;
use crate::error::Result;
use crate::render::gpu_state::GpuState;
use crate::tiles::Tile;

/// Per-step trace record. Tests use this to verify the dispatcher
/// visited steps in the right order with the right operand resolutions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceEvent {
    Paint {
        shape_idx: u64,
        write_to: Vec<SurfaceRef>,
        effect_count: usize,
    },
    Snapshot {
        from: SurfaceRef,
        write_to: SurfaceRef,
    },
    ComposeBackdrop {
        shape_idx: u64,
        read_from: Vec<SurfaceRef>,
        write_to: SurfaceRef,
    },
    PaintGather {
        shape_idx: u64,
        backdrop: SurfaceRef,
        write_to: SurfaceRef,
        effect_count: usize,
    },
    Composite {
        from: SurfaceRef,
        to: SurfaceRef,
        erase_after: bool,
    },
    WriteTileCache {
        from: SurfaceRef,
        tile: Tile,
    },
    EraseSurface(SurfaceRef),
    /// Logged when a step's `write_to` operand triggered a new binding.
    /// Used by allocator tests to verify hit/miss patterns.
    Bind {
        r: SurfaceRef,
        size: (i32, i32),
    },
    /// Logged when a step ended a binding (explicit erase, fold-in
    /// erase_after, or implicit liveness kill).
    Unbind { r: SurfaceRef },
}

/// Sink that the dispatcher writes operations to. Tests use
/// `DispatchTrace`; production wraps the real render functions.
pub trait DispatchSink {
    fn on_event(&mut self, event: TraceEvent);

    /// Per-variant hooks. Default impls call `on_event` so simple
    /// sinks only need to override that one method. Real-render
    /// sinks override these to call into `render::{glass, gather,
    /// scatter, shape_body, ...}`.
    fn paint(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
    fn snapshot(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
    fn compose_backdrop(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
    fn paint_gather(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
    fn composite(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
    fn write_tile_cache(&mut self, _step: &Step, _map: &mut SurfaceMap) -> Result<()> {
        Ok(())
    }
}

/// Test sink that records every dispatched event.
#[derive(Debug, Default)]
pub struct DispatchTrace {
    pub events: Vec<TraceEvent>,
}

impl DispatchTrace {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }
}

impl DispatchSink for DispatchTrace {
    fn on_event(&mut self, event: TraceEvent) {
        self.events.push(event);
    }
}

/// The dispatcher proper.
pub struct Dispatcher<'a, 'b, S: DispatchSink> {
    pub allocator: &'a mut SurfaceAllocator,
    pub gpu: &'a mut GpuState,
    pub sink: &'b mut S,
    /// Default tile-sized surface dimensions. Used when a write-to
    /// ref doesn't otherwise indicate a size (e.g. ScopeOf in a
    /// per-tile context). Set by the caller per-frame from the tile
    /// geometry. `(width, height)`.
    pub default_tile_size: (i32, i32),
}

impl<'a, 'b, S: DispatchSink> Dispatcher<'a, 'b, S> {
    pub fn new(
        allocator: &'a mut SurfaceAllocator,
        gpu: &'a mut GpuState,
        sink: &'b mut S,
        default_tile_size: (i32, i32),
    ) -> Self {
        Self {
            allocator,
            gpu,
            sink,
            default_tile_size,
        }
    }

    /// Execute a full schedule. Validates the schedule in debug builds
    /// first, then walks it in order, resolving operands and calling
    /// per-variant handlers. `map` must be pre-bound with Target.
    pub fn execute(&mut self, schedule: &[Step], map: &mut SurfaceMap) -> Result<()> {
        IrValidator::debug_assert(schedule);

        for (idx, step) in schedule.iter().enumerate() {
            self.dispatch_one(idx, step, map)?;
        }

        Ok(())
    }

    fn dispatch_one(&mut self, _idx: usize, step: &Step, map: &mut SurfaceMap) -> Result<()> {
        match step {
            Step::Paint {
                shape,
                effects,
                write_to,
                ..
            } => {
                // Acquire bindings for every write target.
                for r in write_to {
                    self.bind_if_missing(*r, map)?;
                }
                self.sink.on_event(TraceEvent::Paint {
                    shape_idx: uuid_as_u64(*shape),
                    write_to: write_to.clone(),
                    effect_count: effects.len(),
                });
                self.sink.paint(step, map)?;
            }
            Step::Snapshot { from, write_to, .. } => {
                debug_assert!(
                    map.is_bound(*from),
                    "Snapshot reads unbound {:?}",
                    from
                );
                self.bind_if_missing(*write_to, map)?;
                self.sink.on_event(TraceEvent::Snapshot {
                    from: *from,
                    write_to: *write_to,
                });
                self.sink.snapshot(step, map)?;
            }
            Step::ComposeBackdrop {
                shape,
                read_from,
                write_to,
                ..
            } => {
                for r in read_from {
                    debug_assert!(
                        map.is_bound(*r),
                        "ComposeBackdrop reads unbound {:?}",
                        r
                    );
                }
                self.bind_if_missing(*write_to, map)?;
                self.sink.on_event(TraceEvent::ComposeBackdrop {
                    shape_idx: uuid_as_u64(*shape),
                    read_from: read_from.clone(),
                    write_to: *write_to,
                });
                self.sink.compose_backdrop(step, map)?;
            }
            Step::PaintGather {
                shape,
                backdrop,
                effects,
                write_to,
                ..
            } => {
                debug_assert!(
                    map.is_bound(*backdrop),
                    "PaintGather reads unbound backdrop {:?}",
                    backdrop
                );
                self.bind_if_missing(*write_to, map)?;
                self.sink.on_event(TraceEvent::PaintGather {
                    shape_idx: uuid_as_u64(*shape),
                    backdrop: *backdrop,
                    write_to: *write_to,
                    effect_count: effects.len(),
                });
                self.sink.paint_gather(step, map)?;
            }
            Step::Composite {
                from,
                to,
                erase_after,
                ..
            } => {
                debug_assert!(
                    map.is_bound(*from),
                    "Composite reads unbound from {:?}",
                    from
                );
                debug_assert!(
                    map.is_bound(*to),
                    "Composite reads unbound to {:?}",
                    to
                );
                self.sink.on_event(TraceEvent::Composite {
                    from: *from,
                    to: *to,
                    erase_after: *erase_after,
                });
                self.sink.composite(step, map)?;
                if *erase_after {
                    self.sink.on_event(TraceEvent::Unbind { r: *from });
                    map.release(*from);
                }
            }
            Step::WriteTileCache { from, tile } => {
                debug_assert!(
                    map.is_bound(*from),
                    "WriteTileCache reads unbound from {:?}",
                    from
                );
                self.sink.on_event(TraceEvent::WriteTileCache {
                    from: *from,
                    tile: *tile,
                });
                self.sink.write_tile_cache(step, map)?;
            }
            Step::EraseSurface(r) => {
                self.sink.on_event(TraceEvent::EraseSurface(*r));
                self.sink.on_event(TraceEvent::Unbind { r: *r });
                map.release(*r);
            }
        }
        Ok(())
    }

    /// Acquire a binding for `r` if it's not already bound. Size is
    /// inferred from the ref's role + dispatcher's default tile size.
    /// Checkpoint C will replace this with proper size derivation from
    /// the schedule's metadata (per-step `clip_rect`/`extent`).
    fn bind_if_missing(&mut self, r: SurfaceRef, map: &mut SurfaceMap) -> Result<()> {
        if map.is_bound(r) {
            return Ok(());
        }
        let (w, h) = self.default_tile_size;
        let label = role_label(r);
        map.bind_for_write(r, w, h, label)?;
        self.sink.on_event(TraceEvent::Bind { r, size: (w, h) });
        Ok(())
    }
}

fn role_label(r: SurfaceRef) -> &'static str {
    use super::surface_ref::SurfaceRole;
    match r.role {
        SurfaceRole::ScopeOf(_) => "ssa-scope",
        SurfaceRole::Snapshot { .. } => "ssa-snapshot",
        SurfaceRole::Backdrop(_) => "ssa-backdrop",
        SurfaceRole::RasterEffectOutput(_) => "ssa-raster",
        SurfaceRole::TileOutput => "ssa-tile-output",
        SurfaceRole::Target => "ssa-target",
    }
}

fn uuid_as_u64(uuid: crate::uuid::Uuid) -> u64 {
    // Stable trace key — low 64 bits of the UUID. Tests compare these
    // against fixture values so they need to be deterministic.
    let bytes: [u8; 16] = uuid.into();
    u64::from_le_bytes([
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ])
}

// Allow unused imports for Checkpoint B — `EffectKey`, `LayerPaint`,
// `GatherFx` aren't read in the stub handlers yet but the dispatcher
// will pull them out of `Step` variants in Checkpoint C.
#[allow(dead_code)]
fn _suppress_unused() {
    let _: EffectKey;
    let _: LayerPaint;
    let _: GatherFx;
    let _: skia::Surface;
}
