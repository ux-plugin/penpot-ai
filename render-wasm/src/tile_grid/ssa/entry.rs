//! Cutover entry point — the single function that the renderer will
//! call instead of `run_schedule` once Checkpoint D lands fully.
//!
//! This file is the **scaffold** for the cutover. It wires together
//! the four SSA passes (build / validate / liveness / dispatch) into
//! one function. The body is gated behind `feature = "ssa-ir"` so it
//! doesn't compete with legacy code paths for symbols.
//!
//! ## State of the cutover
//!
//! - The schedule-builder body work (real per-tile shape emission,
//!   gather neighborhood, scope handling, scatter/local-blur,
//!   `ProductionSink` calling `render::*`) is the substantial
//!   remaining work between Checkpoint C and a flippable cutover.
//!   Until that's done, `render_via_ssa` will produce a structurally-
//!   valid but empty schedule for every scene — the canvas would
//!   render blank.
//! - **The legacy deletes (originally Checkpoint D's main payload) are
//!   deferred until pixel-parity is proven.** Per the plan's exit
//!   criterion: "Every scene in test/visual/cells.ts pixel-matches
//!   its baseline under SSA_IR=1." We can't satisfy that without the
//!   builder body. Deleting legacy now would orphan the renderer.
//! - The cutover **wiring** (cfg-gated call site in the orchestrator)
//!   is intentionally NOT added here either — it would route real
//!   frames through `render_via_ssa` whose stub returns empty
//!   schedules. Wiring happens in the same commit that proves
//!   parity, atomic with the legacy deletes.
//!
//! ## What this file gives the next iteration
//!
//! 1. A typed call site future work fills in — every input the SSA
//!    path needs is named in `RenderArgs`.
//! 2. A pre-baked pass ordering with the validator + dep-graph sanity
//!    check + liveness computation already wired. Future work only
//!    needs to write the builder body and the production sink.
//! 3. A clear surface area for the cfg-gated cutover when the time
//!    comes — `render_via_ssa(args)` is what the orchestrator will
//!    call from `v2.rs`.

#![cfg(feature = "ssa-ir")]

use skia_safe::{Point, Rect};

use super::allocator::SurfaceAllocator;
use super::dep_graph::DepGraph;
use super::dispatcher::{DispatchSink, Dispatcher};
use super::liveness::LivenessPass;
use super::schedule_builder::{Schedule, ScheduleBuilder, ScheduleInputs};
use super::surface_map::SurfaceMap;
use super::validator::IrValidator;
use crate::error::Result;
use crate::render::gpu_state::GpuState;
use crate::tiles::Tile;

/// All inputs the SSA render path needs. Mirrors the legacy
/// `run_schedule` argument set but with the SSA-specific bits
/// (`allocator`, `default_tile_size`) added.
pub struct RenderArgs<'a> {
    pub gpu: &'a mut GpuState,
    pub allocator: &'a mut SurfaceAllocator,
    pub target_surface: skia_safe::Surface,
    pub target_size: (i32, i32),
    pub shapes: crate::state::ShapesPoolRef<'a>,
    pub tiles: Vec<Tile>,
    pub tile_size: (i32, i32),
    pub world_origin_for: Box<dyn Fn(Tile) -> Point + 'a>,
    pub clip_rect_for: Box<dyn Fn(Tile) -> Rect + 'a>,
}

/// Output of one `render_via_ssa` call. `target_surface` is the
/// (possibly mutated) Target the caller should hand back to
/// `Surfaces`. `liveness_peak` and `schedule_len` are reported for
/// `perf_trace` instrumentation.
pub struct RenderOutput {
    pub target_surface: skia_safe::Surface,
    pub schedule_len: usize,
    pub liveness_peak: usize,
}

/// Build → validate → liveness → dispatch. The single function the
/// future cutover wires in place of `run_schedule`.
///
/// `sink` is the per-step renderer — production cutover passes a
/// `ProductionSink` that calls into `render::{glass, gather, ...}`;
/// tests pass `DispatchTrace`.
pub fn render_via_ssa<S: DispatchSink>(
    args: RenderArgs<'_>,
    sink: &mut S,
) -> Result<RenderOutput> {
    let RenderArgs {
        gpu,
        allocator,
        target_surface,
        target_size,
        shapes,
        tiles,
        tile_size,
        world_origin_for,
        clip_rect_for,
    } = args;

    // 1. Build the schedule.
    let inputs = ScheduleInputs {
        shapes,
        tiles: &tiles,
        world_origin_for: world_origin_for.as_ref(),
        clip_rect_for: clip_rect_for.as_ref(),
        tile_size,
    };
    let Schedule {
        steps,
        effect_table: _effect_table,
    } = ScheduleBuilder::new().build(&inputs);

    // 2. Validate (debug builds only — production trusts the builder
    // because every emit site is unit-tested).
    IrValidator::debug_assert(&steps);

    // 3. Dep-graph sanity. In production builds this is essentially
    // free — DepGraph::build is O(N) and the natural-order check is
    // O(edges). Future async dispatcher (Step 3 tuning) will consume
    // the topological order; here it's just a guard.
    debug_assert!(
        DepGraph::build(&steps).is_topologically_valid(steps.len()),
        "SSA schedule emitted out of dep order"
    );

    // 4. Liveness — derives implicit kill points the dispatcher
    // consults after each step. Reported in `RenderOutput` for
    // pool-cap tuning.
    let liveness = LivenessPass::run(&steps);
    let liveness_peak = liveness.peak_concurrent_live(steps.len());

    // 5. Dispatch. Target is bound externally; the map drains other
    // refs on drop. The dispatcher releases per-step using liveness;
    // future work moves that release call into the dispatcher loop
    // body rather than relying on `Composite { erase_after: true }`
    // / explicit `EraseSurface` only.
    let target_surface = {
        let (tw, th) = target_size;
        let mut map = SurfaceMap::new(allocator, gpu);
        map.bind_target(target_surface, tw, th);

        let mut dispatcher = Dispatcher::new(sink, tile_size);
        dispatcher.execute(&steps, &mut map)?;

        // Pull Target back out so the caller can hand it to Surfaces.
        map.take_external_target().expect("Target was bound")
    };

    Ok(RenderOutput {
        target_surface,
        schedule_len: steps.len(),
        liveness_peak,
    })
}
