//! Renderer entry point — the single function the renderer calls per
//! frame. Wires the four SSA passes (build / validate / liveness /
//! dispatch) into one function.

use skia_safe::{Point, Rect};

use super::allocator::SurfaceAllocator;
use super::dep_graph::DepGraph;
use super::dispatcher::Dispatcher;
use super::liveness::LivenessPass;
use super::production_sink::ProductionSink;
use super::schedule_builder::{Schedule, ScheduleBuilder, ScheduleInputs};
use super::validator::IrValidator;
use crate::error::Result;
use crate::render::RenderState;
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
    // `tile_grid` lives at `state.tile_grid`; passing it as a separate
    // field would require an immutable borrow of self alongside the
    // mutable `state: self`, which the borrow checker can't accept at
    // the call site. `render_via_ssa` reads it through `state` in the
    // build phase, then re-borrows `state` mutably in the dispatch phase.
    pub tiles: Vec<Tile>,
    pub tile_size: (i32, i32),
    /// Source rect for tile snapshots (the content region within the
    /// margin-padded pool surface). See `ScheduleInputs::content_snapshot_rect`.
    pub content_snapshot_rect: skia_safe::IRect,
    /// Viewbox zoom — gather sample-rect calculation.
    pub scale: f32,
    /// Device-pixel origin of the viewbox on the Target surface —
    /// `(viewbox.left * scale, viewbox.top * scale)`. Passed through
    /// to `ScheduleInputs` so gather emission can compute Target-coord
    /// snapshot rects.
    pub viewbox_device_origin: Point,
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
        tiles,
        tile_size,
        content_snapshot_rect,
        scale,
        viewbox_device_origin,
        world_origin_for,
        clip_rect_for,
    } = args;

    // 0. Clear the Target surface to bg color. Legacy `run_schedule`
    //    handles this implicitly via `FinalizeBand{LastBg}` for empty
    //    tiles and per-tile compositing; the SSA path has neither —
    //    `ClearTileCacheRegion` only wipes the cross-frame cache, not
    //    Target, and per-tile `Composite` uses `SrcOver` `draw_image_rect`
    //    which doesn't overwrite stale pixels where the new tile content
    //    is transparent. Without this clear, tiles a shape moved AWAY
    //    from keep their old Target pixels → visible ghost/flicker
    //    while dragging or animating.
    {
        let bg = state.background_color;
        state.surfaces.target_canvas_clear(bg);
    }

    // 1. Build the schedule. `tile_grid` is borrowed from `state` only
    //    for this phase — NLL drops the borrow before we re-borrow
    //    state mutably for dispatch in phase 5.
    let steps = {
        let tile_grid = &state.tile_grid;
        let inputs = ScheduleInputs {
            shapes,
            tile_grid,
            tiles: &tiles,
            world_origin_for: world_origin_for.as_ref(),
            clip_rect_for: clip_rect_for.as_ref(),
            tile_size,
            content_snapshot_rect,
            scale,
            viewbox_device_origin,
        };
        let Schedule { steps } = ScheduleBuilder::new().build(&inputs);
        steps
    };

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

    // 5. Dispatch via ProductionSink. `state` is re-borrowed mutably
    //    here — the phase-1 immutable borrow on `state.tile_grid`
    //    has ended.
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
