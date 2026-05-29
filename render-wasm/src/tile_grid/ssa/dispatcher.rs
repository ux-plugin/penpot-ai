//! Flat-loop step interpreter — the SSA IR's run-time.
//!
//! Replaces `run_schedule`'s ~700-line match over `RenderStep` plus the
//! implicit `Surfaces.current` / `scope_allocations` / `glass_backdrop_cache`
//! global state. Each step is self-contained: the dispatcher walks the
//! schedule in order, fires lifecycle hooks (`acquire` / `release`) on
//! the `DispatchSink`, then routes the step to a per-variant handler.
//! The sink owns the actual surface management and rendering; the
//! dispatcher just sequences.
//!
//! This factoring keeps the dispatcher independent of where surfaces
//! and GPU state are held — production code routes them through a sink
//! that wraps `RenderState`; tests route them through a `DispatchTrace`
//! that records events instead.

use super::step::Step;
use super::surface_ref::SurfaceRef;
use super::validator::IrValidator;
use crate::error::Result;
use crate::tiles::Tile;

/// Per-step trace record. Tests use this to verify the dispatcher
/// visited steps in the right order with the right operand resolutions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceEvent {
    Acquire {
        r: SurfaceRef,
        size: (i32, i32),
    },
    Release(SurfaceRef),
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
    ClearTileCacheRegion {
        tile: Tile,
    },
    BeginLayer {
        shape_idx: u64,
        write_to: SurfaceRef,
    },
    EndLayer {
        shape_idx: u64,
        write_to: SurfaceRef,
    },
    EraseSurface(SurfaceRef),
}

/// Sink that owns surface management + rendering. The dispatcher
/// sequences calls into this trait; the implementation decides how to
/// back logical refs with physical surfaces and how to execute each
/// step.
///
/// `acquire` fires before any step that writes to a fresh ref;
/// `release` fires after a step that kills a ref (explicit
/// `EraseSurface` or `Composite { erase_after: true }`). Production
/// sinks back these with a `SurfaceMap` / `SurfaceAllocator` pair;
/// the test sink (`DispatchTrace`) just records.
pub trait DispatchSink {
    /// Default size hint when the dispatcher needs to back a logical
    /// ref before knowing its true size. Per-step sizing arrives in
    /// follow-up work via metadata on the step (rect / extent fields).
    fn default_tile_size(&self) -> (i32, i32);

    /// Acquire physical backing for `r`. May be called once per
    /// fresh-write ref. The dispatcher guarantees it won't call
    /// `acquire(r)` again for the same `r` without an intervening
    /// `release(r)`.
    fn acquire(&mut self, r: SurfaceRef, size: (i32, i32)) -> Result<()>;

    /// Release the binding for `r`. May be called once after `acquire`,
    /// at the step where liveness ends.
    fn release(&mut self, r: SurfaceRef);

    /// Per-variant handlers. The default impls are no-ops, suitable
    /// for the test sink. Production sinks override these.
    fn paint(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn snapshot(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn compose_backdrop(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn paint_gather(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn composite(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn write_tile_cache(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn clear_tile_cache_region(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn begin_layer(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }
    fn end_layer(&mut self, _step: &Step) -> Result<()> {
        Ok(())
    }

    /// Notification of each `TraceEvent` — production sinks override
    /// to feed `perf_trace`; tests collect them into a vec.
    fn on_event(&mut self, _event: TraceEvent) {}
}

/// Test sink: records events, holds no surfaces. Used by the
/// dispatcher unit tests to verify operand resolution.
#[derive(Debug, Default)]
pub struct DispatchTrace {
    pub events: Vec<TraceEvent>,
    pub default_size: (i32, i32),
}

impl DispatchTrace {
    pub fn new() -> Self {
        Self {
            default_size: (256, 256),
            ..Default::default()
        }
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }
}

impl DispatchSink for DispatchTrace {
    fn default_tile_size(&self) -> (i32, i32) {
        self.default_size
    }

    fn acquire(&mut self, _r: SurfaceRef, _size: (i32, i32)) -> Result<()> {
        Ok(())
    }

    fn release(&mut self, _r: SurfaceRef) {}

    fn on_event(&mut self, event: TraceEvent) {
        self.events.push(event);
    }
}

/// The dispatcher proper. Walks the schedule, fires lifecycle hooks
/// and per-variant calls on the sink.
pub struct Dispatcher<'b, S: DispatchSink> {
    pub sink: &'b mut S,
}

impl<'b, S: DispatchSink> Dispatcher<'b, S> {
    pub fn new(sink: &'b mut S) -> Self {
        Self { sink }
    }

    /// Execute a full schedule. Validates the schedule in debug builds
    /// first, then walks it in order.
    pub fn execute(&mut self, schedule: &[Step]) -> Result<()> {
        IrValidator::debug_assert(schedule);

        for step in schedule {
            self.dispatch_one(step)?;
        }

        Ok(())
    }

    fn dispatch_one(&mut self, step: &Step) -> Result<()> {
        let size = self.sink.default_tile_size();
        match step {
            Step::Paint {
                shape,
                effects,
                write_to,
                ..
            } => {
                for r in write_to {
                    if !r.is_target() {
                        self.sink.acquire(*r, size)?;
                        self.sink.on_event(TraceEvent::Acquire { r: *r, size });
                    }
                }
                self.sink.on_event(TraceEvent::Paint {
                    shape_idx: uuid_as_u64(*shape),
                    write_to: write_to.clone(),
                    effect_count: effects.len(),
                });
                self.sink.paint(step)?;
            }
            Step::Snapshot { from, write_to, .. } => {
                let _ = from; // sink's snapshot handler reads from the map
                if !write_to.is_target() {
                    self.sink.acquire(*write_to, size)?;
                    self.sink.on_event(TraceEvent::Acquire {
                        r: *write_to,
                        size,
                    });
                }
                self.sink.on_event(TraceEvent::Snapshot {
                    from: *from,
                    write_to: *write_to,
                });
                self.sink.snapshot(step)?;
            }
            Step::ComposeBackdrop {
                shape,
                read_from,
                write_to,
                backdrop_size,
                ..
            } => {
                // Use the step's per-instance size (extent in device
                // pixels) instead of the default tile size — the
                // backdrop has to fit the full world-space sample rect,
                // which grows with zoom.
                let bsize = *backdrop_size;
                if !write_to.is_target() {
                    self.sink.acquire(*write_to, bsize)?;
                    self.sink.on_event(TraceEvent::Acquire {
                        r: *write_to,
                        size: bsize,
                    });
                }
                self.sink.on_event(TraceEvent::ComposeBackdrop {
                    shape_idx: uuid_as_u64(*shape),
                    read_from: read_from.clone(),
                    write_to: *write_to,
                });
                self.sink.compose_backdrop(step)?;
            }
            Step::PaintGather {
                shape,
                backdrop,
                effects,
                write_to,
                ..
            } => {
                if !write_to.is_target() {
                    self.sink.acquire(*write_to, size)?;
                    self.sink.on_event(TraceEvent::Acquire {
                        r: *write_to,
                        size,
                    });
                }
                self.sink.on_event(TraceEvent::PaintGather {
                    shape_idx: uuid_as_u64(*shape),
                    backdrop: *backdrop,
                    write_to: *write_to,
                    effect_count: effects.len(),
                });
                self.sink.paint_gather(step)?;
            }
            Step::Composite {
                from,
                to,
                erase_after,
                ..
            } => {
                self.sink.on_event(TraceEvent::Composite {
                    from: *from,
                    to: *to,
                    erase_after: *erase_after,
                });
                self.sink.composite(step)?;
                if *erase_after {
                    self.sink.release(*from);
                    self.sink.on_event(TraceEvent::Release(*from));
                }
            }
            Step::WriteTileCache { from, tile } => {
                self.sink.on_event(TraceEvent::WriteTileCache {
                    from: *from,
                    tile: *tile,
                });
                self.sink.write_tile_cache(step)?;
            }
            Step::ClearTileCacheRegion { tile, .. } => {
                self.sink
                    .on_event(TraceEvent::ClearTileCacheRegion { tile: *tile });
                self.sink.clear_tile_cache_region(step)?;
            }
            Step::BeginLayer {
                shape, write_to, ..
            } => {
                if !write_to.is_target() {
                    self.sink.acquire(*write_to, size)?;
                }
                self.sink.on_event(TraceEvent::BeginLayer {
                    shape_idx: uuid_as_u64(*shape),
                    write_to: *write_to,
                });
                self.sink.begin_layer(step)?;
            }
            Step::EndLayer { shape, write_to } => {
                self.sink.on_event(TraceEvent::EndLayer {
                    shape_idx: uuid_as_u64(*shape),
                    write_to: *write_to,
                });
                self.sink.end_layer(step)?;
            }
            Step::EraseSurface(r) => {
                self.sink.on_event(TraceEvent::EraseSurface(*r));
                self.sink.release(*r);
                self.sink.on_event(TraceEvent::Release(*r));
            }
        }
        Ok(())
    }
}

fn uuid_as_u64(uuid: crate::uuid::Uuid) -> u64 {
    let bytes: [u8; 16] = uuid.into();
    u64::from_le_bytes([
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ])
}
