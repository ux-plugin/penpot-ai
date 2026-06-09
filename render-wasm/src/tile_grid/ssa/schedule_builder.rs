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
//! The build walks the shape tree **once** in z-order. For each shape
//! we visit, we emit steps inline:
//!
//! - **Non-gather body** — a `Paint` step per touched tile (with
//!   optional inline `BeginLayer`/`EndLayer` brackets if the shape has
//!   a `layer_paint`). Multiple Paints into the same `TileOutput` is
//!   allowed (paint accumulation — the validator special-cases
//!   ScopeOf/TileOutput/Target).
//!
//! - **Gather body** — when the shape has gather effects (glass /
//!   background blur): one `Snapshot(TileOutput(src))` per source tile
//!   in the gather's world-space sample extent, one `ComposeBackdrop`
//!   fusing them, then one `PaintGather` per destination tile the
//!   shape touches, then the shape's body Paint. The Snapshots **freeze
//!   at the moment they execute** — so they capture exactly the
//!   below-z-order content visited so far in the tree walk, and not
//!   the gather shape's own body or any peers above it.
//!
//! - **Scope-wrapping container** — for frames / groups with non-trivial
//!   `layer_paint`, swap each tile's current scope to `ScopeOf(shape.id,
//!   tile)`, recurse into children (their Paints land in the scope
//!   buffer), then emit a `Composite { from: ScopeOf, to: parent_scope }`
//!   per tile to fold the layer's accumulated content back into the
//!   parent.
//!
//! After the tree walk, a **finalize phase** runs per tile:
//! `WriteTileCache(TileOutput)` + `Composite(TileOutput → Target,
//! erase_after: true)` for tiles with content, or `ClearTileCacheRegion`
//! for empty tiles (so a previous-frame shape that moved away doesn't
//! ghost).
//!
//! ### Z-order with gather
//!
//! The single-pass walk is the load-bearing piece for gather z-order
//! against peers. The legacy three-phase split (NonGather bodies →
//! gathers → GatherOnly bodies) painted **every** non-gather peer
//! before **any** gather body, so a glass shape always drew on top of
//! its peers regardless of tree position. By emitting gathers and
//! their bodies inline at the right z-position, peer shapes above the
//! gather then paint over the gather's body — matching legacy
//! semantics.
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

use super::super::{EffectKey, GatherFx, ScatterFx, ShapeEntry, TileGrid};
use super::step::{LayerPaint, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};
use crate::shapes::{Shape, Type};
use crate::state::ShapesPoolRef;
use crate::tiles::{self, Tile};
use crate::uuid::Uuid;

/// SSA-only augmentation over `paint_plan_for_shape`. The legacy
/// rule for scatter shapes is "scatter is exclusive" — the scatter
/// scratch internally renders glass/bg_blur/shadows so they all warp
/// together; paint_plan therefore EXCLUDES Glass from gather and
/// drop-shadows from body when `is_scatter`, leaving body=[Blit].
///
/// In SSA we keep gather/body emission separate (no scratch surface),
/// so we re-enable those effects here and rely on `scatter::render_blit`
/// to snapshot the current TileOutput content (which now holds the
/// gather-deposited glass result) *before* opening the displacement
/// save_layer. The snapshot is redrawn inside the layer, so the
/// displacement warps glass + body together — same visible result as
/// the legacy scratch flow, just sequenced across separate SSA steps.
fn paint_plan_for_shape_ssa(
    shape: &Shape,
) -> (Vec<GatherFx>, Vec<EffectKey>) {
    let (mut gather, mut body) = super::super::paint_plan_for_shape(shape);

    let is_scatter = shape
        .texture
        .as_ref()
        .is_some_and(|t| !t.hidden && t.radius > 0.0);
    if !is_scatter {
        return (gather, body);
    }

    // Re-enable glass gather for scatter shapes (paint_plan suppresses it
    // because legacy bakes glass into the scratch).
    let has_glass = shape.glass.as_ref().is_some_and(|g| !g.hidden);
    if has_glass && !gather.iter().any(|g| matches!(g, GatherFx::Glass)) {
        gather.push(GatherFx::Glass);
    }

    // Append DropShadows after Blit so shadows render on top of the
    // displaced silhouette (matches legacy's after-blit shadow pass).
    // Text routes to the glyph-aware shadow path in dispatch.rs.
    if shape.drop_shadows_visible().next().is_some() {
        body.push(EffectKey::Scatter(ScatterFx::DropShadows));
    }

    (gather, body)
}

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
    /// Tile-output **physical** surface dimensions (typically the
    /// margin-padded `extra_tile_dims`, e.g. 1024×1024). Used by the
    /// dispatcher for surface allocation.
    pub tile_size: (i32, i32),
    /// Source rect for tile-snapshot steps (the CONTENT region within
    /// the margin-padded pool surface). Typically
    /// `(margins.w, margins.h, TILE_SIZE, TILE_SIZE)` = (256, 256,
    /// 512, 512). Snapshots strip margins so consumers (gather
    /// backdrop, ComposeBackdrop) work on clean content pixels.
    pub content_snapshot_rect: skia_safe::IRect,
    /// World viewbox scale. Needed for gather sample-rect calculation
    /// (the legacy `compute_gather_sample_rect` takes scale).
    pub scale: f32,
    /// Device-pixel origin of the viewbox on the Target surface —
    /// (`viewbox.left * scale`, `viewbox.top * scale`). Used by gather
    /// emission to compute Target-coord snapshot rects for the
    /// per-source-tile backdrop reads (the gather backdrop snapshots
    /// from Target now, not from per-tile TileOutputs, so the blurred
    /// content reflects what's actually BEHIND the shape — bg + any
    /// previously-composited content — rather than the shape's own
    /// body, which would otherwise produce a ghost-of-itself artifact).
    pub viewbox_device_origin: skia_safe::Point,
}

/// The builder itself.
pub struct ScheduleBuilder {
    schedule: Schedule,
    /// Tracks which `(shape_id, tile)` body Paint steps have actually
    /// been emitted. Used inside `walk_shape` to dedupe per-frame.
    emitted_shape_bodies: rustc_hash::FxHashSet<(Uuid, Tile)>,
    /// Tracks which tiles host any shape this frame. Populated by
    /// `record_tile_body_membership` before the tree walk runs so the
    /// gather emission can skip empty source tiles when collecting
    /// snapshots. Separate from `emitted_shape_bodies` to avoid the
    /// dedup set blocking the actual emission.
    body_tiles: rustc_hash::FxHashSet<Tile>,
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
            body_tiles: rustc_hash::FxHashSet::default(),
            emitted_gather_shapes: rustc_hash::FxHashSet::default(),
        }
    }

    /// Entry point — build the schedule from input.
    ///
    /// Phase order is crucial for gather effects (background blur,
    /// glass) to behave like legacy. The snapshot a gather takes from
    /// `TileOutput` must be FROZEN at a moment when:
    ///   - all below-z-order non-gather bodies have painted
    ///   - the gather shape itself has NOT painted yet
    /// Otherwise the snapshot either contains the gather shape's own
    /// body (→ ghost-of-itself artifact) or is empty (→ no blur visible).
    ///
    /// Five phases:
    ///   1. Body bookkeeping — record body-bearing tiles for gather's
    ///      neighborhood loop.
    ///   2. Non-gather bodies — paint shapes WITHOUT gather effects
    ///      into TileOutputs. After this, TileOutputs hold exactly the
    ///      content a gather should see in its backdrop.
    ///   3. Gather neighborhood — Snapshot TileOutput (frozen at the
    ///      moment after step 2) + ComposeBackdrop + PaintGather. The
    ///      blur lands ON TOP of step 2's content in TileOutput.
    ///   4. Gather bodies — paint each gather shape's own body on top
    ///      of its blurred-backdrop layer.
    ///   5. Finalize — WriteCache + Composite to Target.
    pub fn build(mut self, inputs: &ScheduleInputs<'_>) -> Schedule {
        for &tile in inputs.tiles {
            self.record_tile_body_membership(tile, inputs);
        }
        self.emit_tree_in_z_order(inputs);
        for &tile in inputs.tiles {
            self.emit_tile_finalize(tile, inputs);
        }
        self.schedule
    }

    /// Bookkeeping pre-pass: record which tiles host any shape this
    /// frame. The tree-walk gather emission reads this set to skip
    /// empty source tiles in the snapshot loop — without it, empty
    /// tiles would contribute transparent snapshots that pollute the
    /// fused backdrop. Doesn't emit any Steps.
    fn record_tile_body_membership(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let has_shape = inputs
            .tile_grid
            .get_shapes_at(tile)
            .map_or(false, |e| !e.is_empty());
        if has_shape {
            self.body_tiles.insert(tile);
        }
    }

    /// Entry point of the z-order tree walk. Initializes per-tile
    /// current-scope state and walks the root's children depth-first.
    fn emit_tree_in_z_order(&mut self, inputs: &ScheduleInputs<'_>) {
        let root_id = Uuid::nil();
        let Some(root) = inputs.shapes.get(&root_id) else { return };
        let mut per_tile_scopes: rustc_hash::FxHashMap<Tile, SurfaceRef> = inputs
            .tiles
            .iter()
            .map(|&t| (t, SurfaceRef::tile_ref(SurfaceRole::TileOutput, t)))
            .collect();
        let child_ids: Vec<Uuid> = root.children_ids_iter(false).copied().collect();
        for child_id in &child_ids {
            if let Some(child) = inputs.shapes.get(child_id) {
                self.walk_shape(child, &mut per_tile_scopes, inputs);
            }
        }
    }

    /// Recursive z-order tree walker. See `emit_tree_in_z_order`.
    fn walk_shape(
        &mut self,
        shape: &Shape,
        per_tile_scopes: &mut rustc_hash::FxHashMap<Tile, SurfaceRef>,
        inputs: &ScheduleInputs<'_>,
    ) {
        if shape.hidden {
            return;
        }

        let is_container =
            matches!(shape.shape_type, Type::Frame(_) | Type::Group(_));
        let layer_paint = super::super::layer_paint_for_shape(shape);
        let scope_wrap = is_container && layer_paint.is_some();

        // 1. Swap each tile's current scope to ScopeOf if this is a
        //    scope-wrapping container.
        let saved_scopes: Option<rustc_hash::FxHashMap<Tile, SurfaceRef>> = if scope_wrap {
            let mut saved = rustc_hash::FxHashMap::default();
            let role = SurfaceRole::ScopeOf(shape.id);
            for (tile, scope) in per_tile_scopes.iter_mut() {
                saved.insert(*tile, *scope);
                *scope = SurfaceRef::tile_ref(role, *tile);
            }
            Some(saved)
        } else {
            None
        };

        let (gather_effects, body_effects) = paint_plan_for_shape_ssa(shape);
        let has_gather = !gather_effects.is_empty();

        // 2. Gather emission FIRST — Snapshot freezes neighborhood
        //    TileOutputs at this z-position.
        if has_gather {
            let anchor = inputs
                .tiles
                .iter()
                .copied()
                .find(|t| shape_in_tile(shape.id, *t, inputs.tile_grid))
                .or_else(|| inputs.tiles.first().copied());
            if let Some(anchor_tile) = anchor {
                if self.emitted_gather_shapes.insert(shape.id) {
                    self.emit_gather_neighborhood(
                        shape,
                        anchor_tile,
                        &gather_effects,
                        inputs,
                    );
                }
            }
        }

        // 3. Emit body Paint per tile the shape touches.
        if !body_effects.is_empty() {
            for &tile in inputs.tiles {
                if !shape_in_tile(shape.id, tile, inputs.tile_grid) {
                    continue;
                }
                if !self.emitted_shape_bodies.insert((shape.id, tile)) {
                    continue;
                }
                let current_scope = per_tile_scopes
                    .get(&tile)
                    .copied()
                    .unwrap_or_else(|| {
                        SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile)
                    });
                let world_origin = (inputs.world_origin_for)(tile);
                let clip_rect = (inputs.clip_rect_for)(tile);
                let inline_layer = !is_container && layer_paint.is_some();
                if inline_layer {
                    self.schedule.steps.push(Step::BeginLayer {
                        shape: shape.id,
                        write_to: current_scope,
                        paint: layer_paint.clone().unwrap(),
                    });
                }
                self.schedule.steps.push(Step::Paint {
                    shape: shape.id,
                    effects: body_effects.clone(),
                    clip_rect,
                    world_origin,
                    write_to: vec![current_scope],
                });
                if inline_layer {
                    self.schedule.steps.push(Step::EndLayer {
                        shape: shape.id,
                        write_to: current_scope,
                    });
                }
            }
        }

        // 4. Recurse into children.
        let child_ids: Vec<Uuid> =
            shape.children_ids_iter(false).copied().collect();
        for child_id in &child_ids {
            if let Some(child) = inputs.shapes.get(child_id) {
                self.walk_shape(child, per_tile_scopes, inputs);
            }
        }

        // 5. Close scope: per-tile Composite-fold ScopeOf → saved
        //    parent scope; restore per_tile_scopes.
        if let Some(saved) = saved_scopes {
            let lp = layer_paint
                .expect("scope_wrap implies layer_paint is Some");
            for (tile, saved_scope) in &saved {
                let scope_of = per_tile_scopes
                    .get(tile)
                    .copied()
                    .unwrap_or_else(|| {
                        SurfaceRef::tile_ref(
                            SurfaceRole::ScopeOf(shape.id),
                            *tile,
                        )
                    });
                let clip_rect = (inputs.clip_rect_for)(*tile);
                self.schedule.steps.push(Step::Composite {
                    from: scope_of,
                    to: *saved_scope,
                    paint: lp.clone(),
                    rect: clip_rect,
                    erase_after: true,
                });
                per_tile_scopes.insert(*tile, *saved_scope);
            }
        }
    }

    /// Finalize phase: per-tile cache write + composite to Target. For
    /// *empty* tiles (no shapes this frame) emit a
    /// `ClearTileCacheRegion` so the previous frame's content doesn't
    /// ghost when the shape moves off-tile.
    fn emit_tile_finalize(&mut self, tile: Tile, inputs: &ScheduleInputs<'_>) {
        let clip_rect = (inputs.clip_rect_for)(tile);
        let has_shape = inputs
            .tile_grid
            .get_shapes_at(tile)
            .map_or(false, |e| !e.is_empty());

        if has_shape {
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
        } else {
            // Empty tile: wipe any stale cache content from a previous
            // frame (e.g. the shape used to be here, moved away). Target
            // was already cleared to bg at frame start so we don't need
            // to composite anything.
            self.schedule.steps.push(Step::ClearTileCacheRegion {
                tile,
                rect: clip_rect,
            });
        }
    }

    /// Emit the `Paint` step for one shape entry's body. Returns true
    /// if a step was emitted, false if deduplicated.
    #[allow(dead_code)]
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
        let (_gather, body) = paint_plan_for_shape_ssa(shape);
        if body.is_empty() {
            return false;
        }
        let layer_paint = super::super::layer_paint_for_shape(shape);
        if let Some(layer_paint) = layer_paint {
            self.schedule.steps.push(Step::BeginLayer {
                shape: entry.id,
                write_to,
                paint: layer_paint,
            });
        }
        self.schedule.steps.push(Step::Paint {
            shape: entry.id,
            effects: body,
            clip_rect,
            world_origin,
            write_to: vec![write_to],
        });
        if layer_paint.is_some() {
            self.schedule.steps.push(Step::EndLayer {
                shape: entry.id,
                write_to,
            });
        }
        true
    }

    /// Emit the gather neighborhood for one gather shape.
    ///
    /// Algorithm:
    ///   1. Compute the world-space sample rect via the legacy
    ///      `TileGrid::compute_gather_sample_rect`.
    ///   2. Map to a tile rect via `tiles::get_tiles_for_rect`.
    ///   3. For each source tile that hosts any shape this frame,
    ///      emit one `Snapshot` reading its `TileOutput` *as of the
    ///      current point in the schedule* — which the inline-walk
    ///      design guarantees holds only below-z-order content.
    ///   4. Emit a single `ComposeBackdrop` fusing the snapshots —
    ///      the backdrop is world-space and shared across destinations.
    ///   5. Emit **one `PaintGather` per destination tile** the shape
    ///      covers, all reading from the same backdrop ref. Each writes
    ///      into that tile's TileOutput. Previously this emitted only on
    ///      the anchor tile — debug trace showed glass spanning 4 tiles
    ///      only got the effect on tile (anchor); the other 3 saw the
    ///      shape's body draws but no backdrop. That's the "no blur
    ///      visible anywhere" symptom.
    fn emit_gather_neighborhood(
        &mut self,
        shape: &Shape,
        anchor_tile: Tile,
        effects: &[GatherFx],
        inputs: &ScheduleInputs<'_>,
    ) {
        // Snap the world-space sample rect to integer device pixels so
        // (a) `compose_backdrop`'s snapshot stamp offsets, and
        // (b) the gather renderer's `draw_image` origin
        // both land on integer device pixels regardless of where the
        // shape is in world space. Without snapping, both draw paths
        // use sub-pixel offsets — bilinear filtering then produces a
        // slightly different averaged value at the same WORLD point
        // depending on the shape's exact position. The user-visible
        // symptom is "blur color shifts as I drag the shape" even
        // though the underlying content didn't change.
        let sample_rect = {
            let raw = inputs.tile_grid.compute_gather_sample_rect(
                shape,
                inputs.shapes,
                inputs.scale,
            );
            let s = inputs.scale.max(1e-6);
            let left = (raw.left * s).floor() / s;
            let top = (raw.top * s).floor() / s;
            // Expand right/bottom outward to preserve all of the
            // original sample window — never shrink.
            let right = (raw.right * s).ceil() / s;
            let bottom = (raw.bottom * s).ceil() / s;
            skia_safe::Rect::from_ltrb(left, top, right, bottom)
        };
        let tile_size = tiles::get_tile_size(inputs.scale);
        let tile_rect = tiles::get_tiles_for_rect(sample_rect, tile_size);

        // 1. Collect snapshot source tiles. Snapshot from each source
        // tile's `TileOutput`. The Snapshot step executes RIGHT NOW
        // (gather phase), which sits between non-gather body Paints
        // and gather body Paints, so `TileOutput` at this moment
        // holds exactly the below-z-order content the blur kernel
        // should sample — and crucially NOT the gather shape's own
        // body, which paints in the next phase.
        //
        // The resulting `skia::Image` is an immutable snapshot, so
        // it stays valid even after subsequent steps mutate
        // `TileOutput` (gather-body Paint, finalize composite, etc.).
        // That's the "freeze" property the schedule relies on.
        //
        // Tiles with no body content are skipped — their snapshot
        // would be empty/transparent. `compose_backdrop` pre-fills
        // the backdrop surface with the frame bg color, so skipped
        // tiles still get bg coverage in the fused backdrop.
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

                self.schedule.steps.push(Step::Snapshot {
                    from: source_tile_out,
                    rect: inputs.content_snapshot_rect,
                    write_to: snap_ref,
                });
                snapshot_refs.push(snap_ref);
            }
        }

        // Note: even if `snapshot_refs` is empty, we still emit the
        // ComposeBackdrop+PaintGather steps — `compose_backdrop`
        // will fill the backdrop with bg color and the blur still
        // shows that bg through the shape's clip.

        // 2. ComposeBackdrop fuses the snapshots into one backdrop.
        // Size = extent in device pixels, capped. The default 1024×1024
        // pool tile size isn't enough at high zoom — for extent
        // 385×281 world at scale 3, device size is 1167×854 which
        // overflows 1024 horizontally → right/bottom snapshot stamps
        // clip out → blur fades.
        //
        // Round up to a small multiple (64) so the allocator pool
        // groups close-sized backdrops in one bucket. Cap at 4096 so
        // pathological blurs don't blow GPU memory.
        let backdrop_size = {
            let bw = (sample_rect.width() * inputs.scale).ceil() as i32;
            let bh = (sample_rect.height() * inputs.scale).ceil() as i32;
            let round_up = |x: i32| ((x + 63) / 64) * 64;
            let w = round_up(bw).max(64).min(4096);
            let h = round_up(bh).max(64).min(4096);
            (w, h)
        };
        let backdrop_ref =
            SurfaceRef::tile_ref(SurfaceRole::Backdrop(shape.id), anchor_tile);
        self.schedule.steps.push(Step::ComposeBackdrop {
            shape: shape.id,
            read_from: snapshot_refs.clone(),
            extent: sample_rect,
            backdrop_size,
            write_to: backdrop_ref,
        });

        // 3. PaintGather per destination tile the shape covers.
        // Each PaintGather reads the same backdrop_ref (a world-space
        // snapshot — identical for every destination), writes into its
        // own tile's TileOutput, and is independently clipped at render
        // time by the shape's geometry-clip.
        //
        // Destination tiles = every visible tile whose per-tile shape
        // index includes this shape. Using `shape_in_tile` (reuses the
        // legacy spatial index) keeps the set tight — no off-shape
        // tiles emit unnecessary PaintGathers.
        //
        // De-dupe is handled at the call site (`emitted_gather_shapes`),
        // so this loop runs exactly once per shape per frame.
        let dest_tiles: Vec<Tile> = inputs
            .tiles
            .iter()
            .copied()
            .filter(|t| shape_in_tile(shape.id, *t, inputs.tile_grid))
            .collect();
        // Anchor-tile fallback: if the shape isn't in `inputs.tiles`
        // (off-screen but still scheduled), emit into anchor only so
        // we don't drop the step. Same behavior as before.
        let dest_tiles = if dest_tiles.is_empty() {
            vec![anchor_tile]
        } else {
            dest_tiles
        };
        for dest_tile in &dest_tiles {
            let dest_tile_out =
                SurfaceRef::tile_ref(SurfaceRole::TileOutput, *dest_tile);
            self.schedule.steps.push(Step::PaintGather {
                shape: shape.id,
                backdrop: backdrop_ref,
                effects: effects.to_vec(),
                write_to: dest_tile_out,
            });
        }

        // 4. Erase snapshots + backdrop — they've served their
        // purpose. (Liveness pass would derive this too; explicit
        // erases here let the dispatcher free pool surfaces sooner.)
        // Backdrop erase MUST come after every PaintGather above, so
        // emit it last.
        for snap in snapshot_refs {
            self.schedule.steps.push(Step::EraseSurface(snap));
        }
        self.schedule.steps.push(Step::EraseSurface(backdrop_ref));
    }

    /// True if this tile hosts any shape this frame. Read from
    /// `body_tiles` (populated by `record_tile_body_membership` in the
    /// bookkeeping pre-pass that runs before the tree walk).
    fn tile_has_body_content(&self, tile: Tile) -> bool {
        self.body_tiles.contains(&tile)
    }
}

impl Default for ScheduleBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// O(N_per_tile) lookup: is `shape_id` slated to render in `tile`?
/// Reuses `TileGrid`'s existing per-tile shape index — the same one
/// the old flat-iteration emit used as its membership source.
fn shape_in_tile(shape_id: Uuid, tile: Tile, tile_grid: &TileGrid) -> bool {
    tile_grid
        .get_shapes_at(tile)
        .map_or(false, |entries| entries.iter().any(|e| e.id == shape_id))
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
