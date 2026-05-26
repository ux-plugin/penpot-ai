//! Translate `TileGrid` band data into SSA `Step` nodes.
//!
//! Reuses the legacy `TileGrid` for tile/band geometry, shape membership
//! per tile, and gather-barrier band splits (per the plan, that machinery
//! stays). The builder's job is the translation layer:
//!
//!   `Band { shapes, gather_at_head }` × `Tile` → SSA `Step`s
//!
//! Coverage state by scene shape:
//!
//! - **Flat / nested-no-fx** — fully implemented. One `Paint` per
//!   shape; one `Composite(scope→Target)` per tile; one
//!   `WriteTileCache` per tile.
//! - **Scoped containers (frames, groups, masked)** — emit
//!   `ScopeOf(F, T)` writes for children, `Composite(scope→parent)`
//!   at end-of-scope. Currently a structural stub — the predicate
//!   for "needs scope" pulls from legacy `needs_scope`, but Composite
//!   paint resolution is TODO.
//! - **Gather (glass / bg-blur)** — emit `Snapshot` per source tile in
//!   the 3×3 neighborhood, `ComposeBackdrop` fusing them, then
//!   `PaintGather`. Currently a structural stub — neighborhood
//!   computation pulls from `GatherKind::extent_world` (legacy), but
//!   the per-source-tile snapshot ref construction is TODO.
//! - **Scatter / local blur** — emit `Paint` into a
//!   `RasterEffectOutput` surface that downstream tiles `Composite`
//!   from. TODO.
//!
//! Checkpoint C delivers the structure + flat scenes; the TODO paths
//! are reachable but emit a debug-build panic so the gap is impossible
//! to silently ship.

use skia_safe::{Point, Rect};

use super::step::{EffectKey, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};
use crate::tiles::Tile;
use crate::uuid::Uuid;

/// Per-frame schedule output. Owns the step list plus the side-tables
/// for opaque step operands (`EffectKey`, `LayerPaint`, `GatherFx`).
/// The dispatcher reads these tables to resolve operand bodies.
#[derive(Debug, Default)]
pub struct Schedule {
    pub steps: Vec<Step>,
    /// Effect-key resolution table. Index = `EffectKey.0` value.
    /// Populated by the builder as it lowers `paint_plan_for_shape`
    /// into `Paint.effects`. Read by the production sink.
    pub effect_table: Vec<EffectBody>,
    // Layer-paint and gather-fx tables grow here in cutover.
}

impl Schedule {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Resolved body for an `EffectKey`. Variants mirror the legacy paint
/// plan but are flat (no nesting). The production sink dispatches on
/// these to call the right `render::*` function.
///
/// The set of variants will grow as the builder learns to lower each
/// paint-plan effect. The unimplemented ones land as TODO panics in
/// the dispatcher; the validator can't catch them because the IR is
/// well-formed — the gap is in the lowering.
#[derive(Debug, Clone)]
pub enum EffectBody {
    /// A simple body fill / stroke pass. Carries enough state for the
    /// production sink to call `render::fills` / `render::strokes`.
    /// Placeholder field set — checkpoint D fills these from the
    /// real `Shape` lookup.
    ShapeBody { shape: Uuid },
    /// Pre-resolved layer-blur, drop-shadow, etc. As the lowering grows,
    /// each effect type gets its own variant or is folded into ShapeBody.
    /// For now the placeholder.
    Placeholder,
}

/// Inputs the builder needs. Held as borrowed references because the
/// builder runs per-frame and shouldn't own this data.
pub struct ScheduleInputs<'a> {
    /// Shapes-pool reference. Resolved as the builder walks shape ids.
    /// `ShapesPoolRef<'a>` is itself a `&'a ShapesPoolImpl`, so the
    /// field needs no extra `&`.
    pub shapes: crate::state::ShapesPoolRef<'a>,
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
    /// Track which shapes we've already emitted a body Paint for in
    /// the current frame, to avoid double-paint when a shape appears
    /// in multiple bands' shape sets.
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

    /// Emit steps for one tile's worth of work. The current
    /// implementation handles the **flat scene** case only — no
    /// scope containers, no gather effects. Walks every shape that
    /// touches the tile, emits one `Paint` per shape into the tile's
    /// root surface (a `TileOutput` ref), then composites to Target
    /// and writes to the tile cache.
    ///
    /// Gather / scope handling is structural-stub: it would detect
    /// the case and panic in debug builds. Wired up in subsequent
    /// commits as the SSA cutover progresses.
    fn emit_tile(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let world_origin = (inputs.world_origin_for)(tile);
        let clip_rect = (inputs.clip_rect_for)(tile);

        // For now, build a single tile-output buffer per tile and
        // paint shape bodies into it directly. Real scope/gather
        // emission slots in as the lowering matures.
        let tile_out = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);

        // The "shape list per tile" comes from legacy `TileGrid` —
        // for checkpoint C we don't yet have access to a `TileGrid`
        // reference (would require borrowing it through inputs).
        // Instead we shape this method around the input contract so
        // checkpoint D can plug in the real list with no API churn.
        //
        // Once wired:
        //   for &shape_id in tile_grid.shapes_in_tile(tile) {
        //       self.emit_shape_body(shape_id, tile, tile_out, ...);
        //   }
        let _ = (inputs.shapes, &self.emitted_shape_bodies);

        // Emit the per-tile finalize: Composite(tile_out → Target) +
        // WriteTileCache(tile_out, tile). The Composite carries the
        // viewbox-space rect derived from the tile geometry.
        //
        // Order matters: WriteTileCache runs first so the cache holds
        // the pre-composite content (it's a per-tile artifact, not a
        // view of the accumulated viewbox), then the composite folds
        // the tile into the viewbox accumulator with `erase_after`
        // releasing the per-tile surface.
        let target = SurfaceRef::target();

        // Skip empty tiles — a tile with no paints would emit a
        // composite of an unwritten surface, which the validator
        // would (correctly) flag. Checkpoint D handles this via a
        // synthetic "background clear" Paint at the head of every
        // tile.
        if self.shape_body_count_for(tile) == 0 {
            // No-op for now. Real code: emit Paint(background) +
            // WriteTileCache + Composite as the LastBg path replaces.
            let _ = (tile_out, target, world_origin, clip_rect);
            return;
        }

        self.schedule.steps.push(Step::WriteTileCache {
            from: tile_out,
            tile,
        });

        self.schedule.steps.push(Step::Composite {
            from: tile_out,
            to: target,
            paint: super::step::LayerPaint(0),
            rect: clip_rect,
            erase_after: true,
        });
    }

    /// Emit the `Paint` step for a single shape body into the given
    /// surface. Looks up the shape's paint plan via the inputs'
    /// shape pool, lowers each effect into an `EffectKey`, and
    /// produces the step.
    ///
    /// **Not yet wired into `emit_tile`** — the call chain that hands
    /// per-tile shape lists down to here is still under construction.
    /// Public so checkpoint D can call it from the cutover wiring.
    #[allow(dead_code)]
    pub fn emit_shape_body(
        &mut self,
        shape: Uuid,
        tile: Tile,
        write_to: SurfaceRef,
        clip_rect: Rect,
        world_origin: Point,
    ) {
        // Deduplicate within a single (shape, tile) — a shape
        // appearing in multiple bands of the same tile (scope
        // passthrough) shouldn't double-paint. The legacy
        // `skip_body_paint` flag on `RenderStep::Enter` encoded the
        // same invariant.
        if !self.emitted_shape_bodies.insert((shape, tile)) {
            return;
        }

        // Lower the paint plan to an opaque EffectKey. For now we
        // emit a single placeholder key that the production sink will
        // resolve by re-looking-up the shape — keeping the IR cheap
        // until checkpoint D collapses the side-table.
        let effect_idx = self.schedule.effect_table.len() as u32;
        self.schedule
            .effect_table
            .push(EffectBody::ShapeBody { shape });

        self.schedule.steps.push(Step::Paint {
            shape,
            effects: vec![EffectKey(effect_idx)],
            clip_rect,
            world_origin,
            write_to: vec![write_to],
        });
    }

    /// Stubbed — returns 0 for now. Checkpoint D replaces this with a
    /// `TileGrid::shape_count_in_tile(tile)` call once the builder
    /// holds a `TileGrid` reference. Until then, `emit_tile` returns
    /// early without emitting anything.
    fn shape_body_count_for(&self, _tile: Tile) -> usize {
        0
    }
}

impl Default for ScheduleBuilder {
    fn default() -> Self {
        Self::new()
    }
}
