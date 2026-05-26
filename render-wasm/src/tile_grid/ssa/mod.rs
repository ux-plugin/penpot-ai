//! SSA Surface IR.
//!
//! Flat per-tile schedule with explicit `readFrom`/`writeTo` operands.
//! Replaces the legacy bracket-based RenderStep model (SetTileBand /
//! FinalizeBand / Enter / Exit / BeginLayer / EndLayer / PushScope /
//! PopScope / BuildCache / FreeCache) with a small set of self-contained
//! ops, each carrying its own tile context and operand list. Logical
//! surfaces (`SurfaceRef`) are pooled to physical Skia surfaces by the
//! `SurfaceAllocator` based on liveness.
//!
//! See `docs/ssa-surface-ir-plan.md` for the full design and migration
//! strategy. See `docs/ssa-surface-ir-correctness-checklist.md` for the
//! behaviors the rewrite must preserve.
//!
//! ## Module layout
//!
//! - `surface_ref` — logical surface identity (`SurfaceRef`, `SurfaceRole`,
//!   `SizeClass`)
//! - `step`        — the flat `Step` enum (operand-only; effect details
//!   are filled in by the dispatcher in Checkpoint B)
//! - `allocator`   — free-list `SurfaceAllocator` keyed by `(width, height)`
//! - `validator`   — `IrValidator` for SSA invariants (debug-only)
//! - `tests`       — synthetic schedules exercising the above
//!
//! Components arriving in later checkpoints (`Dispatcher`,
//! `ScheduleBuilder`, `DepGraph`, `LivenessPass`) will be added under
//! this module without disturbing the foundations laid here.

// Checkpoint A delivers the data types + invariant checker + pool only;
// no consumer wires into them yet. The `dead_code`/`unused_imports`
// suppression below clears the chatter until Checkpoint C lights the
// path up. Removed in C as the schedule builder + dispatcher pull
// from these re-exports.
#![allow(dead_code, unused_imports)]

mod allocator;
mod dep_graph;
mod dispatcher;
#[cfg(feature = "ssa-ir")]
mod entry;
mod liveness;
mod schedule_builder;
mod step;
mod surface_map;
mod surface_ref;
mod validator;

#[cfg(feature = "ssa-ir")]
pub use entry::{render_via_ssa, RenderArgs, RenderOutput};

#[cfg(test)]
mod tests;

pub use allocator::{AllocatorStats, SurfaceAllocator};
pub use dep_graph::DepGraph;
pub use dispatcher::{DispatchSink, DispatchTrace, Dispatcher, TraceEvent};
pub use liveness::{LiveInterval, LivenessPass};
pub use schedule_builder::{EffectBody, Schedule, ScheduleBuilder, ScheduleInputs};
pub use step::{EffectKey, GatherFx, LayerPaint, Step};
pub use surface_map::SurfaceMap;
pub use surface_ref::{SizeClass, SurfaceRef, SurfaceRole};
pub use validator::{compute_liveness, IrValidator, ValidationError};
