//! Cutover entry point — the single function that the renderer will
//! call instead of `run_schedule` once the cutover wiring lands.
//!
//! Wires the four SSA passes (build / validate / liveness / dispatch)
//! into one function. Gated behind `feature = "ssa-ir"` so it doesn't
//! compete with legacy code paths for symbols.
//!
//! ## State of the cutover
//!
//! - Flat-scene path is fully wired here through `ProductionSink`.
//! - Gather / scope / scatter scenes route through ProductionSink's
//!   default no-op handlers — gather output won't appear, the rest of
//!   the tile renders. The gap closes with #16 (gather neighborhood
//!   emission) and the scope-emission follow-up.
//! - **The legacy deletes are still deferred until pixel-parity is
//!   proven.** Wiring this entry point into `v2.rs` happens in the
//!   same commit that proves parity, atomic with the deletes.

#![cfg(feature = "ssa-ir")]

use skia_safe::{Point, Rect};

use super::allocator::SurfaceAllocator;
use super::dep_graph::DepGraph;
use super::dispatcher::Dispatcher;
use super::liveness::LivenessPass;
use super::production_sink::ProductionSink;
use super::schedule_builder::{Schedule, ScheduleBuilder, ScheduleInputs};
use super::validator::IrValidator;
use crate::error::Result;
use crate::render::gpu_state::GpuState;
use crate::render::surfaces::Surfaces;
use crate::tiles::{Tile, TileViewbox};
use crate::view::Viewbox;

/// All inputs the SSA render path needs.
pub struct RenderArgs<'a> {
    pub gpu: &'a mut GpuState,
    pub allocator: &'a mut SurfaceAllocator,
    pub surfaces: &'a mut Surfaces,
    pub shapes: crate::state::ShapesPoolRef<'a>,
    pub tile_grid: &'a super::super::TileGrid,
    pub tile_viewbox: &'a TileViewbox,
    pub viewbox: &'a Viewbox,
    pub tiles: Vec<Tile>,
    pub tile_size: (i32, i32),
    /// Viewbox zoom — feeds gather sample-rect computation.
    pub scale: f32,
    pub world_origin_for: Box<dyn Fn(Tile) -> Point + 'a>,
    pub clip_rect_for: Box<dyn Fn(Tile) -> Rect + 'a>,
}

/// Output of one `render_via_ssa` call. Reported back to the caller
/// for `perf_trace` instrumentation.
pub struct RenderOutput {
    pub schedule_len: usize,
    pub liveness_peak: usize,
    pub acquires: u64,
    pub releases: u64,
}

/// Build → validate → liveness → dispatch. The single function the
/// future cutover wires in place of `run_schedule`.
pub fn render_via_ssa(args: RenderArgs<'_>) -> Result<RenderOutput> {
    let RenderArgs {
        gpu,
        allocator,
        surfaces,
        shapes,
        tile_grid,
        tile_viewbox,
        viewbox,
        tiles,
        tile_size,
        scale,
        world_origin_for,
        clip_rect_for,
    } = args;

    // 1. Build the schedule.
    let inputs = ScheduleInputs {
        shapes,
        tile_grid,
        tiles: &tiles,
        world_origin_for: world_origin_for.as_ref(),
        clip_rect_for: clip_rect_for.as_ref(),
        tile_size,
        scale,
    };
    let Schedule { steps } = ScheduleBuilder::new().build(&inputs);

    // 2. Validate (debug builds only — production trusts the builder
    // because every emit site is unit-tested).
    IrValidator::debug_assert(&steps);

    // 3. Dep-graph sanity (debug-only).
    debug_assert!(
        DepGraph::build(&steps).is_topologically_valid(steps.len()),
        "SSA schedule emitted out of dep order"
    );

    // 4. Liveness — derives implicit kill points. Reported for
    // pool-cap tuning.
    let liveness = LivenessPass::run(&steps);
    let liveness_peak = liveness.peak_concurrent_live(steps.len());

    // 5. Dispatch.
    let (acquires, releases) = {
        let mut sink = ProductionSink::new(
            allocator,
            gpu,
            surfaces,
            shapes,
            tile_viewbox,
            viewbox,
            tile_size,
        );
        Dispatcher::new(&mut sink).execute(&steps)?;
        let acq = sink.acquire_count();
        let rel = sink.release_count();
        sink.finish();
        (acq, rel)
    };

    Ok(RenderOutput {
        schedule_len: steps.len(),
        liveness_peak,
        acquires,
        releases,
    })
}
