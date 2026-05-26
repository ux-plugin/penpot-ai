//! Cutover entry point — the single function that the renderer will
//! call instead of `run_schedule` once the cutover wiring lands.
//!
//! Wires the four SSA passes (build / validate / liveness / dispatch)
//! into one function. Gated behind `feature = "ssa-ir"` so it doesn't
//! compete with legacy code paths for symbols.

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
use crate::render::v2::RenderState;
use crate::tiles::Tile;

/// All inputs the SSA render path needs.
pub struct RenderArgs<'a> {
    /// Mutable reference to the legacy RenderState. ProductionSink
    /// reaches into `state.gpu_state`, `state.surfaces`,
    /// `state.tile_viewbox`, `state.viewbox`, `state.background_color`,
    /// and calls `state.scheduler_render_effects(...)` for the
    /// per-effect dispatch bridge.
    pub state: &'a mut RenderState,
    /// Cross-frame surface pool. Caller owns; the SSA path borrows.
    pub allocator: &'a mut SurfaceAllocator,
    /// Shape pool reference. Passed separately because the legacy
    /// `scheduler_render_effects` takes it as an argument (not stored
    /// on RenderState).
    pub shapes: crate::state::ShapesPoolRef<'a>,
    /// Tile grid (read-only; the SSA builder doesn't mutate it).
    pub tile_grid: &'a super::super::TileGrid,
    pub tiles: Vec<Tile>,
    pub tile_size: (i32, i32),
    /// Viewbox zoom — gather sample-rect calculation.
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
        state,
        allocator,
        shapes,
        tile_grid,
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

    // 2. Validate (debug builds only).
    IrValidator::debug_assert(&steps);

    // 3. Dep-graph sanity (debug-only).
    debug_assert!(
        DepGraph::build(&steps).is_topologically_valid(steps.len()),
        "SSA schedule emitted out of dep order"
    );

    // 4. Liveness.
    let liveness = LivenessPass::run(&steps);
    let liveness_peak = liveness.peak_concurrent_live(steps.len());

    // 5. Dispatch via ProductionSink.
    let (acquires, releases) = {
        let mut sink = ProductionSink::new(allocator, state, shapes, tile_size);
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
