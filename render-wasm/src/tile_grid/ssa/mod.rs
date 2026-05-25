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
mod step;
mod surface_ref;
mod validator;

#[cfg(test)]
mod tests;

pub use allocator::{AllocatorStats, SurfaceAllocator};
pub use step::Step;
pub use surface_ref::{SizeClass, SurfaceRef, SurfaceRole};
pub use validator::{IrValidator, ValidationError};
