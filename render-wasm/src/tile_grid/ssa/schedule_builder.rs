//! Translate `TileGrid` band data into SSA `Step` nodes.
//!
//! Reuses the legacy `TileGrid` for tile/band geometry, shape membership
//! per tile, and gather-barrier band splits (per the plan, that machinery
//! stays). The builder's job is the translation layer:
//!
//!   `TileGrid::get_shapes_at(tile)` → SSA `Step`s for that tile
//!
//! ## Emission shape
//!
//! Two phases per build call:
//!
//! 1. **Body phase** — for every tile, walk its shapes in paint order;
//!    emit a `Paint` step per shape into `TileOutput(tile)`. Multiple
//!    Paints into the same `TileOutput` is allowed (paint accumulation —
//!    the validator special-cases ScopeOf/TileOutput/Target).
//!
//! 2. **Gather phase** — for every gather shape touching the visible
//!    tile range, compute the world-space sample extent, expand to a
//!    tile rect, emit one `Snapshot(TileOutput(source_tile))` per
//!    source tile + one `ComposeBackdrop` fusing them + one
//!    `PaintGather` writing into the gather's destination tile's
//!    `TileOutput`. The Snapshot reads happen-before the gather's
//!    write via the natural emit order (body phase runs first).
//!
//! 3. **Finalize phase** — per tile: `WriteTileCache(TileOutput)` +
//!    `Composite(TileOutput → Target, erase_after: true)`.
//!
//! ## Coverage state
//!
//! - **Flat / nested-no-fx** — implemented (body + finalize phases).
//! - **Gather (glass / bg-blur)** — implemented (gather phase emits
//!   Snapshot + ComposeBackdrop + PaintGather; ProductionSink handlers
//!   still TODO for snapshot/compose/paint_gather variants).
//! - **Scoped containers** — TODO. The plan calls for per-tile
//!   `ScopeOf` surfaces with Composite-fold to parent; for flat
//!   scenes the current TileOutput-only emission is correct. Scope
//!   emission lands after gather scenes hit pixel-parity.
//! - **Scatter / local blur** — TODO. Will emit a `RasterEffectOutput`
//!   ref produced once per shape and consumed per-tile.

use skia_safe::{Point, Rect};

use super::super::{EffectKey, GatherFx, ShapeEntry, TileGrid};
use super::step::{LayerPaint, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};
use crate::shapes::Shape;
use crate::state::ShapesPoolRef;
use crate::tiles::{self, Tile};
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
    pub shapes: ShapesPoolRef<'a>,
    /// The legacy tile grid — owns the spatial index and per-tile shape
    /// lists. Read-only here.
    pub tile_grid: &'a TileGrid,
    /// Tiles the builder should emit steps for. Typically the visible
    /// rect from `TileViewbox`.
    pub tiles: &'a [Tile],
    /// World-space tile origin computation.
    pub world_origin_for: &'a dyn Fn(Tile) -> Point,
    /// World-space tile clip rect for the given tile.
    pub clip_rect_for: &'a dyn Fn(Tile) -> Rect,
    /// Tile-output dimensions.
    pub tile_size: (i32, i32),
    /// World viewbox scale. Needed for gather sample-rect calculation
    /// (the legacy `compute_gather_sample_rect` takes scale).
    pub scale: f32,
}

/// The builder itself.
pub struct ScheduleBuilder {
    schedule: Schedule,
    emitted_shape_bodies: rustc_hash::FxHashSet<(Uuid, Tile)>,
    /// Track gather shapes we've already emitted neighborhood-snapshot
    /// + ComposeBackdrop + PaintGather for. Each gather emits once per
    /// frame regardless of how many tiles it touches.
    emitted_gather_shapes: rustc_hash::FxHashSet<Uuid>,
}

impl ScheduleBuilder {
    pub fn new() -> Self {
        Self {
            schedule: Schedule::new(),
            emitted_shape_bodies: rustc_hash::FxHashSet::default(),
            emitted_gather_shapes: rustc_hash::FxHashSet::default(),
        }
    }

    /// Entry point — build the schedule from input.
    pub fn build(mut self, inputs: &ScheduleInputs<'_>) -> Schedule {
        // Phase 1 — body Paints, per tile.
        for &tile in inputs.tiles {
            self.emit_tile_bodies(tile, inputs);
        }
        // Phase 2 — gather neighborhoods. Emitted in a separate pass
        // so all source tiles' TileOutputs are written before any
        // gather reads them. (The natural per-tile body order isn't
        // dependency-correct for gathers — a gather in tile T00 may
        // need to read TileOutput(T10), which isn't written until
        // we get to T10 in the body phase. Doing all bodies first
        // breaks the cycle.)
        for &tile in inputs.tiles {
            self.emit_tile_gathers(tile, inputs);
        }
        // Phase 3 — per-tile finalize: cache write + composite to Target.
        for &tile in inputs.tiles {
            self.emit_tile_finalize(tile, inputs);
        }
        self.schedule
    }

    /// Phase 1: walk a tile's shapes, emit Paint steps.
    fn emit_tile_bodies(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let entries = match inputs.tile_grid.get_shapes_at(tile) {
            Some(e) if !e.is_empty() => e,
            _ => return,
        };

        let world_origin = (inputs.world_origin_for)(tile);
        let clip_rect = (inputs.clip_rect_for)(tile);
        let tile_out = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);

        for entry in entries {
            self.emit_shape_body(
                entry,
                inputs.shapes,
                tile,
                tile_out,
                clip_rect,
                world_origin,
            );
        }
    }

    /// Phase 2: walk a tile's shapes, emit gather neighborhood steps
    /// for any shape with a gather effect (glass / bg_blur) anchored
    /// at this tile. The neighborhood includes every tile the gather's
    /// world-space sample extent intersects.
    fn emit_tile_gathers(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let entries = match inputs.tile_grid.get_shapes_at(tile) {
            Some(e) if !e.is_empty() => e,
            _ => return,
        };

        for entry in entries {
            if !entry.has_gather {
                continue;
            }
            // De-dupe — a gather shape touches multiple tiles, but
            // we emit its neighborhood/backdrop/PaintGather exactly
            // once. We anchor the emission at the first tile we
            // encounter that hosts the shape.
            if !self.emitted_gather_shapes.insert(entry.id) {
                continue;
            }
            let Some(shape) = inputs.shapes.get(&entry.id) else {
                continue;
            };
            let (gather_effects, _body) =
                super::super::paint_plan_for_shape(shape);
            if gather_effects.is_empty() {
                continue;
            }
            self.emit_gather_neighborhood(
                shape,
                tile,
                &gather_effects,
                inputs,
            );
        }
    }

    /// Phase 3: per-tile finalize — cache write + composite to Target.
    fn emit_tile_finalize(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let entries = match inputs.tile_grid.get_shapes_at(tile) {
            Some(e) if !e.is_empty() => e,
            _ => return,
        };
        // Only finalize tiles we actually painted into. (A tile in
        // the visible range with no shapes was already skipped above.)
        let _ = entries;

        let clip_rect = (inputs.clip_rect_for)(tile);
        let tile_out = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
        let target = SurfaceRef::target();

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
            None => return false,
        };
        let (_gather, body) = super::super::paint_plan_for_shape(shape);
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

    /// Emit the gather neighborhood for one gather shape.
    ///
    /// Algorithm:
    ///   1. Compute the world-space sample rect via the legacy
    ///      `TileGrid::compute_gather_sample_rect`.
    ///   2. Map to a tile rect via `tiles::get_tiles_for_rect`.
    ///   3. For each source tile that has been emitted into (i.e.
    ///      has a `TileOutput` written by Phase 1), emit one
    ///      `Snapshot`. The TileOutput ref is per-tile and was
    ///      written during the body phase.
    ///   4. Emit a `ComposeBackdrop` fusing the snapshots.
    ///   5. Emit a `PaintGather` writing into the anchor tile's
    ///      TileOutput.
    fn emit_gather_neighborhood(
        &mut self,
        shape: &Shape,
        anchor_tile: Tile,
        effects: &[GatherFx],
        inputs: &ScheduleInputs<'_>,
    ) {
        let sample_rect = inputs.tile_grid.compute_gather_sample_rect(
            shape,
            inputs.shapes,
            inputs.scale,
        );
        let tile_size = tiles::get_tile_size(inputs.scale);
        let tile_rect = tiles::get_tiles_for_rect(sample_rect, tile_size);

        // 1. Collect snapshot source tiles. We snapshot from every
        // source tile that had body content emitted (Phase 1). The
        // dedup map tracks (shape, tile) so we can ask "did we paint
        // anything into source_tile during Phase 1".
        let mut snapshot_refs: Vec<SurfaceRef> = Vec::new();
        for ty in tile_rect.y1()..=tile_rect.y2() {
            for tx in tile_rect.x1()..=tile_rect.x2() {
                let source_tile = Tile(tx, ty);
                if !self.tile_has_body_content(source_tile) {
                    continue;
                }
                let snap_ref = SurfaceRef::tile_ref(
                    SurfaceRole::Snapshot {
                        for_shape: shape.id,
                        source_tile,
                    },
                    source_tile,
                );
                let source_tile_out =
                    SurfaceRef::tile_ref(SurfaceRole::TileOutput, source_tile);

                // Snapshot the entire tile's content. The gather
                // shader clips to its own extent inside the backdrop.
                self.schedule.steps.push(Step::Snapshot {
                    from: source_tile_out,
                    rect: skia_safe::IRect::from_xywh(0, 0, inputs.tile_size.0, inputs.tile_size.1),
                    write_to: snap_ref,
                });
                snapshot_refs.push(snap_ref);
            }
        }

        if snapshot_refs.is_empty() {
            // Nothing to backdrop — skip. The gather's body paint
            // (Phase 1) still happens, producing transparent output.
            return;
        }

        // 2. ComposeBackdrop fuses the snapshots into one backdrop.
        let backdrop_ref =
            SurfaceRef::tile_ref(SurfaceRole::Backdrop(shape.id), anchor_tile);
        self.schedule.steps.push(Step::ComposeBackdrop {
            shape: shape.id,
            read_from: snapshot_refs.clone(),
            extent: sample_rect,
            write_to: backdrop_ref,
        });

        // 3. PaintGather writes into the anchor tile's TileOutput.
        let anchor_tile_out =
            SurfaceRef::tile_ref(SurfaceRole::TileOutput, anchor_tile);
        self.schedule.steps.push(Step::PaintGather {
            shape: shape.id,
            backdrop: backdrop_ref,
            effects: effects.to_vec(),
            write_to: anchor_tile_out,
        });

        // 4. Erase snapshots + backdrop — they've served their
        // purpose. (Liveness pass would derive this too; explicit
        // erases here let the dispatcher free pool surfaces sooner.)
        for snap in snapshot_refs {
            self.schedule.steps.push(Step::EraseSurface(snap));
        }
        self.schedule.steps.push(Step::EraseSurface(backdrop_ref));
    }

    /// True if Phase 1 emitted any body Paint into `tile`'s TileOutput.
    /// Walks `emitted_shape_bodies` looking for a (_, tile) entry.
    /// O(N) — fine since this only fires from gather emission, which
    /// is rare relative to body emission.
    fn tile_has_body_content(&self, tile: Tile) -> bool {
        self.emitted_shape_bodies.iter().any(|(_, t)| *t == tile)
    }
}

impl Default for ScheduleBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Identity composite paint — opacity 1.0, src-over, no frame-clip blur.
fn identity_layer_paint() -> LayerPaint {
    LayerPaint {
        opacity: 1.0,
        blend_mode: skia_safe::BlendMode::SrcOver,
        frame_blur_sigma_dev: None,
    }
}

// Reference `EffectKey` so the unused-import lint doesn't fire on
// builds that don't reach the legacy paint plan call.
#[allow(dead_code)]
const _: Option<EffectKey> = None;
