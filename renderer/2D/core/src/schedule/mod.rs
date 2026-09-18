//! The render scheduler — backend-neutral (the "one pipeline", not per-effect special cases).
//!
//! A frame becomes a flat list of [`Step`]s over logical [`SurfaceRef`]s: everything is a surface (a
//! tile's output, a shape's effect surface, a gather's backdrop, the final target), and steps paint
//! into and composite among them, interleaved in z-order. This is the render-wasm SSA scheduler,
//! adapted to Vello's neutral model and tile policy — the same schedule both backends can execute
//! (render-vello supplies a GPU production sink; the tests here run against the pure IR).
//!
//! Ported module-for-module from `render-wasm/src/tile_grid/ssa/`:
//! - [`surface_ref`] — logical surface identity ([`SurfaceRef`], [`SurfaceRole`], [`SizeClass`]).
//! - [`step`] — the flat [`Step`] IR with `reads`/`writes`/`rewrites`/`kills`.
//! - [`dep_graph`] — producer→consumer graph + topological sort.
//! - [`builder`] — the single-pass z-order walk that emits the schedule.

pub mod builder;
pub mod dep_graph;
pub mod flatten;
pub mod gather_plan;
pub mod step;
pub mod surface_ref;

pub use builder::{
    affected_page_rect, build, build_visible, first_write_paints, gather_dirty_expansion,
    page_bounds, Schedule,
};
pub use dep_graph::DepGraph;
pub use gather_plan::{analyze_gathers, EffectKey, GatherInfo, GatherPlan};
pub use step::{LayerPaint, PaintOp, Step};
pub use surface_ref::{SizeClass, SurfaceRef, SurfaceRole};

#[cfg(test)]
mod tests;
