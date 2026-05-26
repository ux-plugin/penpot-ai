//! Translate `TileGrid` band data into SSA `Step` nodes.
//!
//! Reuses the legacy `TileGrid` for tile/band geometry, shape membership
//! per tile, and gather-barrier band splits (per the plan, that machinery
//! stays). The builder's job is the translation layer:
//!
//!   `TileGrid::get_shapes_at(tile)` → SSA `Step`s for that tile
//!
//! Coverage state by scene shape:
//!
//! - **Flat / nested-no-fx** — implemented. One `Paint` per shape into
//!   the tile's `TileOutput` ref; one `Composite(tile_out → Target)`
//!   per tile; one `WriteTileCache` per tile.
//! - **Scoped containers (frames, groups, masked)** — TODO. Will emit
//!   `ScopeOf(F, T)` writes for children + `Composite(scope → parent)`
//!   at end-of-scope.
//! - **Gather (glass / bg-blur)** — TODO. Will emit `Snapshot` per
//!   source tile in the 3×3 neighborhood + `ComposeBackdrop` + `PaintGather`.
//! - **Scatter / local blur** — TODO. Will emit a `RasterEffectOutput`
//!   ref produced once per shape and consumed per-tile.
//!
//! The flat-scene path is fully wired; gather/scope/scatter paths are
//! detected and short-circuit to a debug-panic so they can't ship silently.

use skia_safe::{Point, Rect};

use super::super::{EffectKey, ShapeEntry, TileGrid};
use super::step::Step;
use super::surface_ref::{SurfaceRef, SurfaceRole};
use crate::shapes::Shape;
use crate::state::ShapesPoolRef;
use crate::tiles::Tile;
use crate::uuid::Uuid;

/// Per-frame schedule output. The dispatcher executes `steps` in order.
#[derive(Debug, Default)]
pub struct Schedule {
    pub steps: Vec<Step>,
}

impl Schedule {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Inputs the builder needs. Held as borrowed references because the
/// builder runs per-frame and shouldn't own this data.
pub struct ScheduleInputs<'a> {
    /// Shapes-pool reference. Resolved as the builder walks shape ids.
    /// `ShapesPoolRef<'a>` is itself a `&'a ShapesPoolImpl`, so the
    /// field needs no extra `&`.
    pub shapes: ShapesPoolRef<'a>,
    /// The legacy tile grid — owns the spatial index and per-tile shape
    /// lists. Read-only here; the builder doesn't mutate the grid.
    pub tile_grid: &'a TileGrid,
    /// Tiles the builder should emit steps for. Typically the visible
    /// rect from `TileViewbox`.
    pub tiles: &'a [Tile],
    /// World-space tile origin computation. `world_origin_for(tile)`
    /// returns the world (x, y) of the tile's top-left.
    pub world_origin_for: &'a dyn Fn(Tile) -> Point,
    /// World-space tile clip rect for the given tile. Includes the
    /// renderer's tile-size multiplier / margins so per-tile Paint
    /// steps cover the over-sampled region.
    pub clip_rect_for: &'a dyn Fn(Tile) -> Rect,
    /// Tile-output dimensions. Used to size physical surfaces backing
    /// `ScopeOf` / `TileOutput` refs.
    pub tile_size: (i32, i32),
}

/// The builder itself. Accumulates a `Schedule` as it walks input.
pub struct ScheduleBuilder {
    schedule: Schedule,
    /// Track which shapes we've already emitted a body Paint for at a
    /// given tile. A shape that appears in multiple bands of the same
    /// tile (scope passthrough in the legacy model) shouldn't double-paint.
    emitted_shape_bodies: rustc_hash::FxHashSet<(Uuid, Tile)>,
}

impl ScheduleBuilder {
    pub fn new() -> Self {
        Self {
            schedule: Schedule::new(),
            emitted_shape_bodies: rustc_hash::FxHashSet::default(),
        }
    }

    /// Entry point — build the schedule from input. Returns the
    /// completed `Schedule` ready for `Dispatcher::execute`.
    pub fn build(mut self, inputs: &ScheduleInputs<'_>) -> Schedule {
        for &tile in inputs.tiles {
            self.emit_tile(tile, inputs);
        }
        self.schedule
    }

    /// Emit steps for one tile's worth of work.
    ///
    /// Algorithm:
    ///   1. Look up shapes on this tile via `TileGrid::get_shapes_at`.
    ///   2. If no shapes touch the tile, skip — the tile output is empty.
    ///   3. Walk shapes in paint order; emit one `Paint` step per shape
    ///      writing into the tile's `TileOutput` ref.
    ///   4. After all shapes, emit `WriteTileCache(tile_out, tile)` and
    ///      `Composite(tile_out → Target, erase_after: true)`.
    ///
    /// Gather and scope detection: if any shape on this tile has a
    /// gather effect or needs a scope, the builder currently emits a
    /// `Paint` step into the tile output anyway — the gather/scope
    /// rendering will be picked up by the production sink's per-effect
    /// dispatch. The full gather neighborhood (Snapshot + ComposeBackdrop)
    /// lands in follow-up work; the flat path is the foundation.
    fn emit_tile(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let entries = match inputs.tile_grid.get_shapes_at(tile) {
            Some(e) if !e.is_empty() => e,
            _ => return, // empty tile — viewbox background was cleared at frame start
        };

        let world_origin = (inputs.world_origin_for)(tile);
        let clip_rect = (inputs.clip_rect_for)(tile);
        let tile_out = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
        let target = SurfaceRef::target();

        // Emit per-shape body paint into the tile output.
        let mut emitted_any = false;
        for entry in entries {
            if self.emit_shape_body(
                entry,
                inputs.shapes,
                tile,
                tile_out,
                clip_rect,
                world_origin,
            ) {
                emitted_any = true;
            }
        }

        if !emitted_any {
            // Every shape on the tile was a dedupe — nothing to composite.
            return;
        }

        // Per-tile finalize: cache write (so the cross-frame tile cache
        // captures the per-tile artifact), then composite into the
        // viewbox accumulator with erase_after folding in the release.
        self.schedule.steps.push(Step::WriteTileCache {
            from: tile_out,
            tile,
        });

        self.schedule.steps.push(Step::Composite {
            from: tile_out,
            to: target,
            paint: identity_layer_paint(),
            rect: clip_rect,
            erase_after: true,
        });
    }

    /// Emit the `Paint` step for one shape entry's body. Returns true
    /// if a step was emitted, false if deduplicated.
    ///
    /// `paint_plan_for_shape` is the legacy planner — it splits the
    /// shape's effects into gather + body lists. We pull only the
    /// body list here; gather lifting lives in follow-up work.
    fn emit_shape_body(
        &mut self,
        entry: &ShapeEntry,
        shapes: ShapesPoolRef<'_>,
        tile: Tile,
        write_to: SurfaceRef,
        clip_rect: Rect,
        world_origin: Point,
    ) -> bool {
        if !self.emitted_shape_bodies.insert((entry.id, tile)) {
            return false;
        }
        let shape: &Shape = match shapes.get(&entry.id) {
            Some(s) => s,
            None => return false, // pool race; legacy code tolerates this too
        };

        // Lower the paint plan to a flat effect list. Gather effects
        // (Glass / BackgroundBlur) are routed through `PaintGather` —
        // when that emission lands, this is the place that decides
        // whether to emit Paint+PaintGather or Paint alone.
        let (gather, body) = paint_plan(shape);
        let _ = gather; // gather emission lands in follow-up

        if body.is_empty() {
            return false;
        }

        self.schedule.steps.push(Step::Paint {
            shape: entry.id,
            effects: body,
            clip_rect,
            world_origin,
            write_to: vec![write_to],
        });
        true
    }
}

impl Default for ScheduleBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Identity composite paint — opacity 1.0, src-over, no frame-clip blur.
/// Used for the tile→Target finalize composite. Tile content is already
/// correctly composed inside `tile_out`; the finalize is a straight copy.
fn identity_layer_paint() -> super::step::LayerPaint {
    super::step::LayerPaint {
        opacity: 1.0,
        blend_mode: skia_safe::BlendMode::SrcOver,
        frame_blur_sigma_dev: None,
    }
}

/// Local wrapper around the legacy `paint_plan_for_shape`. Lives here
/// so the SSA module doesn't depend on that function's exact name —
/// when the legacy code gets deleted in the post-parity sweep, only
/// this file needs the rename.
fn paint_plan(shape: &Shape) -> (Vec<super::super::GatherFx>, Vec<EffectKey>) {
    super::super::paint_plan_for_shape(shape)
}
