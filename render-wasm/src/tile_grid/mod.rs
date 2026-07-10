//! Spatial index over the shape tree.
//!
//! `TileGrid` maps tiles → the shapes that overlap them (and the inverse).
//! It is rebuilt on viewport / scene mutations and consumed per frame by
//! `tile_grid::ssa::ScheduleBuilder`, which lowers it into the
//! single-pass SSA render schedule.

pub mod ssa;

thread_local! {
    /// Cross-frame surface pool used by the SSA renderer. Lives for
    /// the lifetime of the wasm module — pool retention buys zero
    /// per-frame allocation in steady-state animation.
    static SSA_ALLOCATOR: std::cell::RefCell<ssa::SurfaceAllocator> =
        std::cell::RefCell::new(ssa::SurfaceAllocator::new());
}

// Hash map/set used throughout this module are FxHash-backed: small-key
// hashing (Tile = (i32, i32), Uuid) dominates the spatial-index hot path,
// and SipHash (the std default) is ~3-4× slower than FxHash on these tiny
// keys. Aliasing the names so the rest of the module reads like ordinary
// `HashMap` / `HashSet` code.
pub use rustc_hash::FxHashMap as HashMap;
pub use rustc_hash::FxHashSet as HashSet;

use skia_safe as skia;

use crate::error::Result;
use crate::performance;
use crate::render::{RenderState, SurfaceId};
use crate::shapes::{Shape, Type};
use crate::state::{ShapesPoolMutRef, ShapesPoolRef};
use crate::tiles::{self, Tile, TileRect, TileViewbox};
use crate::uuid::Uuid;
use crate::wapi;

// ── Data structures ─────────────────────────────────────────────────────

/// Per-shape metadata stored inline in the spatial index.
/// Only derived data — the full shape is always read from ShapesPool.
#[derive(Debug, Clone)]
pub struct ShapeEntry {
    pub id: Uuid,
    /// Depth-first paint rank (bottom-first), assigned by
    /// `TileGrid::index_shape_recursive` during full rebuild. Entries
    /// constructed by `update_touched` for shapes that already existed
    /// keep their prior value; new shapes get 0 as a placeholder and
    /// trigger a full rebuild to renumber.
    pub paint_order: u32,
}

/// One unit of paint work emitted by the scheduler.
///
/// V2b granularity matches the existing renderer's natural boundaries:
/// each variant maps cleanly to one or two existing per-effect renderer
/// functions. Per-individual fills/strokes/shadows (`Fill(u16)`,
/// `Stroke(u16)`, `Shadow(u16)`) is V3 — it requires splitting
/// `render_shape` into per-aspect functions; the existing API is batched.
/// Top-level effect categorised by sampling/spreading semantics.
///
/// - `Gather` effects sample pixels from *outside* the shape (the
///   backdrop) and paint *inside* the shape's bounds. They depend on a
///   prior `BuildCache(Gather(id))` step that snapshots the backdrop.
/// - `Scatter` effects read the shape's own silhouette/border and spill
///   pixels *outside or inside* those bounds (drop shadows extend out,
///   inner shadows bleed in). Fast mode skips them wholesale.
/// - `Local` effects paint at-shape: fills, strokes, body composite —
///   no cross-bounds sampling or spilling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKey {
    Gather(GatherFx),
    Scatter(ScatterFx),
    Local(LocalFx),
}

/// Effects that sample the backdrop and paint into the shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GatherFx {
    /// `render_background_blur` — modifies `output` in place by blurring
    /// what's already there. Should be first in the effect list so
    /// subsequent effects paint on top of the blurred backdrop.
    BackgroundBlur,
    /// Glass / refraction. Root-level gather shapes consume the
    /// `Cache(Gather(id))` backdrop built by an earlier `BuildCache`
    /// step; nested glass samples Current.
    Glass,
}

/// Effects that read the shape's silhouette and spill outside/inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScatterFx {
    /// All visible drop shadows on the shape, batched into one call to
    /// `render_element_drop_shadows_and_composite`. Must come before
    /// `Local::ShapeBody` so shadows land below fills/strokes.
    DropShadows,
    /// Pre-rendered displaced scatter image, blitted from `Cache(Scatter(id))`
    /// with drop shadows + inner shadows applied to the warped silhouette.
    /// Used in place of `DropShadows` + `ShapeBody` for scatter shapes.
    Blit,
}

/// Effects local to the shape — paint at-shape, no cross-bounds sampling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocalFx {
    /// Fills + strokes + inner shadows + composite, via `render_shape` +
    /// `apply_drawing_to_render_canvas`. Atomic for V2b; future work
    /// splits this into per-aspect effects once the renderer is refactored.
    /// Handles text shapes too — `render_shape` dispatches by `Shape::Type`.
    /// (Inner shadows technically scatter inward but are bundled here
    /// because `render_shape` is atomic in V2b.)
    ShapeBody,
    /// V2c.1 — leaf shape with `shape.blur = LayerBlur(_)`. The
    /// `BuildCache(LocalBlur(id))` step renders the full shape body
    /// (fills + strokes + inner shadows) into a bounded offscreen
    /// surface, applies the blur image filter, and snapshots. The
    /// Paint arm just blits the cached image. Replaces `ShapeBody`
    /// for shapes that qualify (leaf, no inherited blur, non-text).
    LayerBlur,
}

/// Prebuilt save_layer paint for V2c.2 `BeginLayer` steps. Computed once
/// at schedule build time so the dispatcher never re-derives. Schedule
/// rebuilds on scale change so `frame_blur_sigma_dev` in device pixels
/// stays correct for a given rebuild.
#[derive(Debug, Clone, Copy)]
pub struct LayerPaint {
    pub opacity: f32,
    pub blend_mode: skia::BlendMode,
    /// Frame-clip layer-blur sigma in device pixels. `None` for the
    /// common case (no frame-clip layer-blur). V2c.2 keeps masked
    /// groups + frame-clip layer-blur containers on the legacy inline
    /// `render_shape_enter` path; this field is reserved for the
    /// follow-up that lifts those too.
    pub frame_blur_sigma_dev: Option<f32>,
}

/// V2c.2 — predicate for shapes whose save_layer wrapping is hoisted
/// out of `render_shape_enter`/`exit` into top-level `BeginLayer`/
/// `EndLayer` steps. Several categories stay on the legacy inline
/// path (each for a different reason):
/// - masked groups: two-pass content+mask plumbing, complex restore
/// - frame-clip layer-blur: the blur image filter stacks with opacity
///   inside `render_shape_enter`'s save_layer; lifting it would need
///   to thread the blur sigma through `LayerPaint` AND make sure no
///   children cache the wrong stacked layer.
/// - bg_blur / glass shapes: those gather effects mutate the backdrop
///   on Current BEFORE the save_layer for opacity in legacy code.
///   Lifting save_layer to fire before the shape's Paint would put
///   bg_blur and glass inside an empty layer. Defer.
fn shape_qualifies_for_external_layer(shape: &Shape) -> bool {
    if !shape.needs_layer() {
        return false;
    }
    if matches!(&shape.shape_type, Type::Group(g) if g.masked) {
        return false;
    }
    if shape.has_frame_clip_layer_blur() {
        return false;
    }
    if shape.background_blur.is_some_and(|b| !b.hidden) {
        return false;
    }
    if shape.glass.as_ref().is_some_and(|g| !g.hidden) {
        return false;
    }
    true
}

/// V2c.2 — derive the prebuilt `LayerPaint` for a shape that qualifies
/// for external layer wrapping. Returns `None` for shapes outside scope.
pub(crate) fn layer_paint_for_shape(shape: &Shape) -> Option<LayerPaint> {
    if !shape_qualifies_for_external_layer(shape) {
        return None;
    }
    Some(LayerPaint {
        opacity: shape.opacity(),
        blend_mode: shape.blend_mode().into(),
        frame_blur_sigma_dev: None,
    })
}

/// Per-tile spatial index over the shape tree.
///
/// Owned by `RenderState` and rebuilt on viewport/shape changes. The SSA
/// scheduler reads it directly via `get_shapes_at` / `get_tiles_of` —
/// there is no pre-computed render schedule here anymore (that machinery
/// lived under V2 and went away with `RenderStep`). Per-frame step
/// emission happens in `tile_grid::ssa::ScheduleBuilder`.
pub struct TileGrid {
    // ── Spatial index ────────────────────────────────────────────────
    /// Tile → shapes on it, sorted by paint order.
    grid: HashMap<Tile, Vec<ShapeEntry>>,
    /// Shape → tiles it occupies.
    index: HashMap<Uuid, HashSet<Tile>>,
}

/// V2b: build a `Paint` step whose action list reflects the actual visible
/// effects on this shape. Order matters — the dispatcher walks the list
/// in order and each effect paints on top of (or composites against) what
/// previous effects produced.
///
/// Order rationale:
/// - `BackgroundBlur` first — it samples `output`'s existing content; later
///   effects paint over the blurred backdrop.
/// - `Glass` next — also samples backdrop (cached or `output`).
/// - `DropShadows` / `ScatterBlit` next — drops must underlay fills/strokes;
///   for scatter, `ScatterBlit` is the whole-body equivalent and replaces
///   `DropShadows + ShapeBody` (the scatter blit applies its own shadows).
/// - `ShapeBody` last — fills + strokes + inner shadows on top.
pub(crate) fn paint_plan_for_shape(shape: &Shape) -> (Vec<GatherFx>, Vec<EffectKey>) {
    let is_scatter = shape
        .texture
        .as_ref()
        .is_some_and(|t| !t.hidden && t.radius > 0.0);
    let has_glass = shape.glass.as_ref().is_some_and(|g| !g.hidden);
    let has_bg_blur = shape.background_blur.is_some_and(|b| !b.hidden);

    let mut gather: Vec<GatherFx> = Vec::with_capacity(2);
    if has_bg_blur {
        gather.push(GatherFx::BackgroundBlur);
    }
    // Scatter shapes bake the whole body (fills + glass + shadows) into the
    // pre-rendered `Cache(Scatter(id))` image, so a separate Glass gather
    // step would double-apply refraction. Only emit Glass for non-scatter.
    if has_glass && !is_scatter {
        gather.push(GatherFx::Glass);
    }

    let mut body: Vec<EffectKey> = Vec::with_capacity(2);
    if is_scatter {
        body.push(EffectKey::Scatter(ScatterFx::Blit));
    } else {
        // Drop shadows: text shapes route to the glyph-aware
        // `text::render_drop_shadows`, all others to the silhouette
        // path — both via this `DropShadows` step (see dispatch.rs).
        // Emitted before ShapeBody so the shadow lands behind the shape.
        if shape.drop_shadows_visible().next().is_some() {
            body.push(EffectKey::Scatter(ScatterFx::DropShadows));
        }
        if crate::render::local::shape_qualifies_for_layer_blur_cache(shape) {
            body.push(EffectKey::Local(LocalFx::LayerBlur));
        } else {
            body.push(EffectKey::Local(LocalFx::ShapeBody));
        }
    }

    (gather, body)
}

/// Children of `shape` in paint order (bottom-first), honouring flex/grid
/// `order` overrides. Mirrors `render::sort_z_index` but returns bottom-first
/// so a depth-first counter walks shapes in paint sequence.
fn paint_order_children(shape: &Shape, tree: ShapesPoolRef) -> Vec<Uuid> {
    let mut ids = shape.children_ids(false);
    ids.reverse(); // children_ids is topmost-first → flip to bottom-first
    if shape.has_layout() {
        ids.sort_by(|a, b| {
            let za = tree.get(a).map(|s| s.z_index()).unwrap_or(0);
            let zb = tree.get(b).map(|s| s.z_index()).unwrap_or(0);
            za.cmp(&zb) // ascending = bottom-first
        });
    }
    // For masked groups, `children_ids(false)` drops the mask child
    // (Penpot convention: `children[0]` = mask). The SSA mask-group
    // step needs it indexed in the tile grid too so MaskBegin/MaskEnd
    // can pick it up.
    if let Type::Group(group) = shape.shape_type {
        if group.masked {
            if let Some(mask_id) = shape.mask_id() {
                ids.push(*mask_id);
            }
        }
    }
    ids
}

impl TileGrid {
    pub fn new() -> Self {
        TileGrid {
            grid: HashMap::default(),
            index: HashMap::default(),
        }
    }

    // ── Spatial index operations ─────────────────────────────────────

    pub fn get_shapes_at(&self, tile: Tile) -> Option<&[ShapeEntry]> {
        self.grid.get(&tile).map(|v| v.as_slice())
    }

    pub fn get_tiles_of(&self, shape_id: &Uuid) -> Option<&HashSet<Tile>> {
        self.index.get(shape_id)
    }

    pub fn add_shape_at(&mut self, tile: Tile, entry: ShapeEntry) {
        let id = entry.id;
        let entries = self.grid.entry(tile).or_default();
        // Insert in paint-order-sorted position.
        let pos = entries
            .binary_search_by(|e| e.paint_order.cmp(&entry.paint_order))
            .unwrap_or_else(|p| p);
        entries.insert(pos, entry);

        self.index.entry(id).or_default().insert(tile);
    }

    pub fn remove_shape_at(&mut self, tile: Tile, id: Uuid) {
        if let Some(entries) = self.grid.get_mut(&tile) {
            entries.retain(|e| e.id != id);
        }
        if let Some(tiles) = self.index.get_mut(&id) {
            tiles.remove(&tile);
        }
    }

    // ── Full rebuild ────────────────────────────────────────────────

    /// Rebuild the spatial index from the shape tree.
    ///
    /// Walks the tree depth-first, assigns each shape a paint_order, and
    /// indexes it into every tile its `extrect` overlaps within the
    /// interest rect. The SSA scheduler reads this index per frame via
    /// `get_shapes_at` / `get_tiles_of`.
    pub fn rebuild(
        &mut self,
        tree: ShapesPoolRef,
        tile_viewbox: &TileViewbox,
        scale: f32,
    ) {
        performance::begin_measure!("tile_grid_rebuild");

        self.grid.clear();
        self.index.clear();

        let tile_size = tiles::get_tile_size(scale);
        let interest_rect = &tile_viewbox.interest_rect;

        let root_id = Uuid::nil();
        let mut paint_counter: u32 = 0;
        if let Some(root) = tree.get(&root_id) {
            for child_id in paint_order_children(root, tree) {
                self.index_shape_recursive(
                    child_id,
                    tree,
                    tile_size,
                    interest_rect,
                    scale,
                    &mut paint_counter,
                );
            }
        }

        performance::end_measure!("tile_grid_rebuild");
    }

    /// Incremental update: only re-index the touched shapes.
    ///
    /// For the typical drag case the existing paint_order counter is
    /// still valid because tree topology is unchanged. New shapes (no
    /// prior entry) trigger a full renumber via a fresh DFS so the SSA
    /// scheduler's z-order assumptions stay correct.
    pub fn update_touched(
        &mut self,
        touched: &HashSet<Uuid>,
        tree: ShapesPoolRef,
        tile_viewbox: &TileViewbox,
        scale: f32,
    ) -> HashSet<Tile> {
        let tile_size = tiles::get_tile_size(scale);
        let interest_rect = &tile_viewbox.interest_rect;
        let mut affected_tiles = HashSet::default();

        let mut needs_full_renumber = false;

        for &id in touched {
            // Recover paint_order from one of the shape's existing entries
            // before we drop them. All entries for the same shape carry the
            // same paint_order (assigned once in `index_shape_recursive`),
            // so any one works.
            let prev_paint_order: Option<u32> = self
                .index
                .get(&id)
                .and_then(|tiles| tiles.iter().next().copied())
                .and_then(|tile| self.grid.get(&tile).map(|v| (tile, v)))
                .and_then(|(_, entries)| entries.iter().find(|e| e.id == id).map(|e| e.paint_order));

            // Remove from old tiles
            if let Some(old_tiles) = self.index.remove(&id) {
                for tile in &old_tiles {
                    if let Some(entries) = self.grid.get_mut(tile) {
                        entries.retain(|e| e.id != id);
                    }
                    affected_tiles.insert(*tile);
                }
            }

            // Re-add if shape still exists
            if let Some(shape) = tree.get(&id) {
                if id != Uuid::nil() {
                    let extrect = shape.extrect(tree, scale);
                    let shape_tiles = tiles::get_tiles_for_rect(extrect, tile_size);

                    let paint_order = match prev_paint_order {
                        Some(po) => po,
                        None => {
                            needs_full_renumber = true;
                            0
                        }
                    };

                    let ix1 = shape_tiles.x1().max(interest_rect.x1());
                    let iy1 = shape_tiles.y1().max(interest_rect.y1());
                    let ix2 = shape_tiles.x2().min(interest_rect.x2());
                    let iy2 = shape_tiles.y2().min(interest_rect.y2());

                    if ix1 <= ix2 && iy1 <= iy2 {
                        for tx in ix1..=ix2 {
                            for ty in iy1..=iy2 {
                                let tile = Tile::from(tx, ty);
                                self.add_shape_at(
                                    tile,
                                    ShapeEntry {
                                        id,
                                        paint_order,
                                    },
                                );
                                affected_tiles.insert(tile);
                            }
                        }
                    }
                }
            }
        }

        if needs_full_renumber {
            // A new shape (never seen before) was touched. Re-do the full
            // index from scratch so the depth-first paint_order assignment
            // is consistent across every entry. Cheap for typical scenes.
            self.rebuild(tree, tile_viewbox, scale);
        }

        affected_tiles
    }

    /// Recursively walk the shape tree and add shapes to the spatial index.
    /// Assigns each visited shape a depth-first `paint_order` so SSA's
    /// z-order emission is deterministic.
    fn index_shape_recursive(
        &mut self,
        shape_id: Uuid,
        tree: ShapesPoolRef,
        tile_size: f32,
        interest_rect: &TileRect,
        scale: f32,
        paint_counter: &mut u32,
    ) {
        let Some(shape) = tree.get(&shape_id) else {
            return;
        };

        if shape.hidden {
            return;
        }

        let paint_order = *paint_counter;
        *paint_counter += 1;
        let extrect = shape.extrect(tree, scale);
        let shape_tiles = tiles::get_tiles_for_rect(extrect, tile_size);

        let ix1 = shape_tiles.x1().max(interest_rect.x1());
        let iy1 = shape_tiles.y1().max(interest_rect.y1());
        let ix2 = shape_tiles.x2().min(interest_rect.x2());
        let iy2 = shape_tiles.y2().min(interest_rect.y2());

        if ix1 <= ix2 && iy1 <= iy2 {
            for tx in ix1..=ix2 {
                for ty in iy1..=iy2 {
                    let tile = Tile::from(tx, ty);
                    self.add_shape_at(
                        tile,
                        ShapeEntry {
                            id: shape_id,
                            paint_order,
                        },
                    );
                }
            }
        }

        // Recurse into children in paint order so paint_order stays consistent
        // with how SSA emits them (bottom-first, flex/grid-aware).
        if shape.is_recursive() {
            for child_id in paint_order_children(shape, tree) {
                self.index_shape_recursive(
                    child_id,
                    tree,
                    tile_size,
                    interest_rect,
                    scale,
                    paint_counter,
                );
            }
        }
    }

    /// Compute the world-space rectangle a gather effect samples from.
    /// This is the shape bounds expanded by displacement + blur + frost radius.
    pub(crate) fn compute_gather_sample_rect(
        &self,
        shape: &Shape,
        tree: ShapesPoolRef,
        scale: f32,
    ) -> skia::Rect {
        let base = shape.extrect(tree, scale);
        let mut expand = 0.0_f32;

        // Glass effect expansion
        if let Some(glass) = &shape.glass {
            if !glass.hidden {
                // Max displacement from refraction
                let displacement = glass.glass_thickness * glass.refractive_index * 50.0;
                // Blur kernel radius
                let blur_radius = glass.total_blur_sigma() * 3.0 * scale;
                // Frost scatter radius
                let frost_radius = glass.frost * 6.0;
                expand = expand.max(displacement + blur_radius + frost_radius);
            }
        }

        // Background blur expansion
        if let Some(blur) = &shape.background_blur {
            if !blur.hidden {
                let blur_radius = blur.value * 3.0 * scale;
                expand = expand.max(blur_radius);
            }
        }

        skia::Rect::from_ltrb(
            base.left - expand,
            base.top - expand,
            base.right + expand,
            base.bottom + expand,
        )
    }

}

// ── Frame-render entry points on `RenderState` ──────────────────────
//
// These are the methods the C ABI in `main.rs` ultimately calls into.
// They live here (rather than alongside the rest of `RenderState`)
// because they read the `TileGrid` spatial index directly when
// computing per-tile work. Body composition is delegated to the SSA
// path via `run_schedule` → `ssa::render_via_ssa`.

impl RenderState {

    pub fn start_render_loop(
        &mut self,
        base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        _timestamp: i32,
        sync_render: bool,
    ) -> Result<()> {
        // Top-level frame guard. Wraps everything inside this entry
        // point — schedule build, surface clears, run_schedule, GPU
        // flush — so a single tag is the answer to "how long did this
        // frame's CPU-side wasm work take?". Sub-guards
        // (`tile_grid_rebuild`, `run_schedule_TOTAL`, ...) still break
        // it down.
        let _start = performance::begin_timed_log!("start_render_loop");
        let scale = self.get_scale();

        self.tile_viewbox.update(self.viewbox, scale);
        self.focus_mode.reset();

        performance::begin_measure!("render");
        performance::begin_measure!("start_render_loop");

        self.reset_canvas();
        // `reset_canvas` clears Fills/Strokes/Current/etc. but NOT Target.
        // Target retains pixels from the previous frame until each tile's
        // finalize_{bg,content} overwrites its rect. A gather tile whose
        // backdrop samples a region whose tiles haven't yet processed THIS
        // frame ends up reading stale pixels from the last frame — the glass
        // then appears to distort whatever was there before. Force a full
        // clear to guarantee a clean slate. Tiles in the schedule rewrite
        // their own rects, and cached_blit paths still draw cached tile
        // images (stored in a separate texture cache, unaffected by this
        // clear).
        self.surfaces
            .canvas(SurfaceId::Target)
            .clear(self.background_color);

        // Phase I.5: scale-fixup of unused scratch surfaces (FILLS,
        // STROKES, InnerShadows, TextDropShadows) dropped — V2 helpers
        // paint directly onto Current/output, no longer touch scratches.
        // Surface allocations themselves still alive (separate cleanup
        // ticket).

        let viewbox_cache_size = crate::render::get_cache_size(self.viewbox, scale);
        let cached_viewbox_cache_size = crate::render::get_cache_size(self.cached_viewbox, scale);
        if viewbox_cache_size.width > cached_viewbox_cache_size.width
            || viewbox_cache_size.height > cached_viewbox_cache_size.height
        {
            self.surfaces
                .resize_cache(viewbox_cache_size, crate::render::VIEWPORT_INTEREST_AREA_THRESHOLD)?;
        }

        performance::begin_measure!("tile_grid_rebuild");
        {
            self.tile_grid.rebuild(tree, &self.tile_viewbox, scale);
        }
        performance::end_measure!("tile_grid_rebuild");

        self.nested_fills.clear();
        self.current_tile = None;
        self.render_in_progress = true;

        // Phase I.3: defensive scratch-flush dropped — Phase I.2
        // removed the last scratch-chain caller (text helper); no
        // residual scratch state to flush.

        if sync_render {
            self.run_schedule(tree)?;
            self.flush_and_submit();
            wapi::notify_tiles_render_complete!();
        } else {
            self.run_schedule(tree)?;
            self.flush_and_submit();
            if self.render_in_progress {
                self.cancel_animation_frame();
                self.render_request_id = Some(wapi::request_animation_frame!());
            } else {
                wapi::notify_tiles_render_complete!();
                performance::end_measure!("render");
            }
        }

        performance::end_measure!("start_render_loop");
        performance::end_timed_log!("start_render_loop", _start);
        Ok(())
    }

    pub fn process_animation_frame(
        &mut self,
        _base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        _timestamp: i32,
    ) -> Result<()> {
        // Continuation-frame top-level guard. Same role as
        // `frame_TOTAL` in `start_render_loop` but for chunked async
        // continuations. Sums to the full per-frame CPU cost.
        performance::begin_measure!("process_animation_frame");
        if self.render_in_progress {
            if tree.len() != 0 {
                self.run_schedule(tree)?;
            }
            self.flush_and_submit();

            if self.render_in_progress {
                self.cancel_animation_frame();
                self.render_request_id = Some(wapi::request_animation_frame!());
            } else {
                wapi::notify_tiles_render_complete!();
                performance::end_measure!("render");
            }
        }
        performance::end_measure!("process_animation_frame");
        Ok(())
    }

    pub fn render_shape_tree_sync(
        &mut self,
        _base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        _timestamp: i32,
    ) -> Result<()> {
        if tree.len() != 0 {
            self.run_schedule(tree)?;
        }
        self.flush_and_submit();
        wapi::notify_tiles_render_complete!();
        Ok(())
    }

    /// The main render loop. Walks the pre-computed schedule where every
    /// band is bracketed by a `SetTileBand` (setup) and a `FinalizeBand`
    /// (teardown) step. Because `FinalizeBand.kind` is decided at build
    /// Builds + dispatches an SSA schedule for the current frame via
    /// `ProductionSink`. The sole frame-render entry point now that V2
    /// is gone.
    fn run_schedule(&mut self, tree: ShapesPoolRef) -> Result<()> {
        let scale = self.get_scale();
        let tile_size = crate::tiles::get_tile_size(scale);
        // Pool surfaces must match legacy `Current` exactly: 1024×1024
        // (TILE_SIZE × TILE_SIZE_MULTIPLIER) with 256-px margins around
        // a 512×512 content region. This gives filter renderers (blur,
        // drop-shadow, etc.) the kernel-sampling headroom they need —
        // otherwise effect draws clip at tile boundaries with visible
        // seams. Composite + cache write extract just the content
        // region via `image_snapshot_with_bounds(margins, TILE_SIZE)`.
        let extra = self.surfaces.extra_tile_dims();
        let tile_dims = (extra.width, extra.height);
        let margins = self.surfaces.margins();
        let content_snapshot_rect = skia::IRect::from_xywh(
            margins.width,
            margins.height,
            crate::tiles::TILE_SIZE as i32,
            crate::tiles::TILE_SIZE as i32,
        );

        let interest = self.tile_viewbox.interest_rect;
        let mut tiles: Vec<Tile> = Vec::new();
        for ty in interest.y1()..=interest.y2() {
            for tx in interest.x1()..=interest.x2() {
                tiles.push(Tile(tx, ty));
            }
        }

        let origin = move |t: Tile| {
            skia::Point::new(t.x() as f32 * tile_size, t.y() as f32 * tile_size)
        };
        let clip = move |t: Tile| {
            skia::Rect::from_xywh(
                t.x() as f32 * tile_size,
                t.y() as f32 * tile_size,
                tile_size,
                tile_size,
            )
        };

        let viewbox_device_origin = skia::Point::new(
            self.viewbox.area.left * scale,
            self.viewbox.area.top * scale,
        );
        let dispatch_result = SSA_ALLOCATOR.with(|cell| {
            let mut allocator = cell.borrow_mut();
            let args = ssa::RenderArgs {
                state: self,
                allocator: &mut *allocator,
                shapes: tree,
                tiles,
                tile_size: tile_dims,
                content_snapshot_rect,
                scale,
                viewbox_device_origin,
                world_origin_for: Box::new(origin),
                clip_rect_for: Box::new(clip),
            };
            ssa::render_via_ssa(args).map(|_out| ())
        });

        // Post-schedule housekeeping — MUST mirror the tail of the
        // legacy `run_schedule` below. Without this, `render_from_cache`
        // (the pan/zoom fast path) short-circuits because
        // `cached_viewbox` never gets stamped → panning shows nothing.
        // Per-frame cache state, in-progress flag, scope tracking, and
        // UI overlays all live here too.
        self.surfaces.clear_interband_cache();
        self.render_in_progress = false;
        self.surfaces.gc();
        self.cached_viewbox = self.viewbox;

        crate::render::ui::render(self, tree);

        dispatch_result
    }

    // ── Tile management methods (same signatures as current impl) ────

    pub fn get_tiles_for_shape(&mut self, shape: &Shape, tree: ShapesPoolRef) -> TileRect {
        let scale = self.get_scale();
        let extrect = self.get_cached_extrect(shape, tree, scale);
        let tile_size = tiles::get_tile_size(scale);
        let shape_tiles = tiles::get_tiles_for_rect(extrect, tile_size);
        let interest_rect = &self.tile_viewbox.interest_rect;

        let ix1 = shape_tiles.x1().max(interest_rect.x1());
        let iy1 = shape_tiles.y1().max(interest_rect.y1());
        let ix2 = shape_tiles.x2().min(interest_rect.x2());
        let iy2 = shape_tiles.y2().min(interest_rect.y2());

        if ix1 <= ix2 && iy1 <= iy2 {
            TileRect(ix1, iy1, ix2, iy2)
        } else {
            TileRect(0, 0, -1, -1)
        }
    }

    pub fn update_shape_tiles(
        &mut self,
        shape: &Shape,
        tree: ShapesPoolRef,
    ) -> HashSet<Tile> {
        let TileRect(rsx, rsy, rex, rey) = self.get_tiles_for_shape(shape, tree);

        // Remove from old tiles
        let old_tiles: Vec<_> = self
            .tile_grid
            .get_tiles_of(&shape.id)
            .map_or(Vec::new(), |t| t.iter().copied().collect());

        let mut result = HashSet::with_capacity_and_hasher(old_tiles.len(), Default::default());

        for tile in old_tiles {
            self.tile_grid.remove_shape_at(tile, shape.id);
            result.insert(tile);
        }

        // Add to new tiles. paint_order uses 0 as placeholder — callers of
        // update_shape_tiles trigger a renumber before the dep graph rebuilds.
        for tile in (rsx..=rex).flat_map(|x| (rsy..=rey).map(move |y| Tile::from(x, y))) {
            self.tile_grid.add_shape_at(
                tile,
                ShapeEntry {
                    id: shape.id,
                    paint_order: 0,
                },
            );
            result.insert(tile);
        }

        result
    }

    pub fn update_shape_tiles_incremental(
        &mut self,
        shape: &Shape,
        tree: ShapesPoolRef,
    ) -> Vec<Tile> {
        let TileRect(rsx, rsy, rex, rey) = self.get_tiles_for_shape(shape, tree);

        let old_tiles: HashSet<Tile> = self
            .tile_grid
            .get_tiles_of(&shape.id)
            .map_or(HashSet::default(), |tiles| tiles.iter().copied().collect());

        let new_tiles: HashSet<Tile> = (rsx..=rex)
            .flat_map(|x| (rsy..=rey).map(move |y| Tile::from(x, y)))
            .collect();

        let removed: Vec<_> = old_tiles.difference(&new_tiles).copied().collect();
        let added: Vec<_> = new_tiles.difference(&old_tiles).copied().collect();

        for tile in &removed {
            self.tile_grid.remove_shape_at(*tile, shape.id);
        }

        // paint_order placeholder — renumbered by the next full/touched pass.
        for tile in &added {
            self.tile_grid.add_shape_at(
                *tile,
                ShapeEntry {
                    id: shape.id,
                    paint_order: 0,
                },
            );
        }

        Vec::new()
    }

    pub fn add_shape_tiles(
        &mut self,
        shape: &Shape,
        tree: ShapesPoolRef,
    ) -> Vec<Tile> {
        let TileRect(rsx, rsy, rex, rey) = self.get_tiles_for_shape(shape, tree);
        let mut result = Vec::new();

        // paint_order placeholder — renumbered by the next full/touched pass.
        for tile in (rsx..=rex).flat_map(|x| (rsy..=rey).map(move |y| Tile::from(x, y))) {
            self.tile_grid.add_shape_at(
                tile,
                ShapeEntry {
                    id: shape.id,
                    paint_order: 0,
                },
            );
            result.push(tile);
        }

        result
    }

    pub fn remove_cached_tile(&mut self, tile: Tile) {
        self.surfaces.remove_cached_tile_surface(tile);
    }

    pub fn rebuild_tile_index(&mut self, tree: ShapesPoolRef) {
        let scale = self.get_scale();
        self.tile_grid.rebuild(tree, &self.tile_viewbox, scale);
    }

    /// `view_only`: caller is reacting to a pure viewport change (pan/zoom)
    /// with no underlying scene mutation. In that case the tile texture
    /// cache (world-space keyed) stays valid for non-zoom changes and we
    /// skip `invalidate_tile_cache`. Pan was previously wiping the whole
    /// cache here, forcing 0% hit rate even on small drags.
    pub fn rebuild_tiles_shallow(&mut self, tree: ShapesPoolRef, view_only: bool) {
        performance::begin_measure!("rebuild_tiles_shallow");

        self.rebuild_tile_index(tree);

        if self.zoom_changed() {
            // Tiles are scaled per zoom level — different bucket means
            // existing textures aren't reusable.
            self.surfaces.remove_cached_tiles(self.background_color);
        } else if !view_only {
            // Non-view scene-level change (e.g. background color) needs
            // a tile invalidate even though world coords are the same.
            // Pan/zoom callers pass `view_only: true` to keep the
            // texture cache.
            self.surfaces.invalidate_tile_cache();
        }

        performance::end_measure!("rebuild_tiles_shallow");
    }

    pub fn rebuild_tiles_from(&mut self, tree: ShapesPoolRef, _base_id: Option<&Uuid>) {
        performance::begin_measure!("rebuild_tiles");

        let scale = self.get_scale();
        self.tile_grid.rebuild(tree, &self.tile_viewbox, scale);

        self.surfaces.remove_cached_tiles(self.background_color);
        // Invalidate all cached tiles
        for tile in self.tile_grid.grid.keys().copied().collect::<Vec<_>>() {
            self.remove_cached_tile(tile);
        }

        performance::end_measure!("rebuild_tiles");
    }

    pub fn rebuild_touched_tiles(&mut self, tree: ShapesPoolRef) {
        performance::begin_measure!("rebuild_touched_tiles");

        let touched = std::mem::take(&mut self.touched_ids);
        let scale = self.get_scale();
        let affected = self.tile_grid.update_touched(
            &touched,
            tree,
            &self.tile_viewbox,
            scale,
        );

        // SSA recomputes gather backdrops per frame, so we no longer
        // need the extra `gather_tiles_affected_by` sweep that V2 used
        // to invalidate stale persistent backdrop caches.
        for tile in affected {
            self.remove_cached_tile(tile);
        }

        performance::end_measure!("rebuild_touched_tiles");
    }

    pub fn update_tiles_shapes(
        &mut self,
        shape_ids: &[Uuid],
        tree: ShapesPoolMutRef<'_>,
    ) -> Result<()> {
        let mut all_tiles = HashSet::default();
        for shape_id in shape_ids {
            if let Some(shape) = tree.get(shape_id) {
                all_tiles.extend(self.update_shape_tiles(shape, tree));
            }
        }
        for tile in all_tiles {
            self.remove_cached_tile(tile);
        }
        Ok(())
    }

    pub fn rebuild_modifier_tiles(
        &mut self,
        tree: ShapesPoolMutRef<'_>,
        ids: Vec<Uuid>,
    ) -> Result<()> {
        use crate::shapes::all_with_ancestors;

        // Get all ancestors of modified shapes so their extrects/tiles update too
        let ancestors = all_with_ancestors(&ids, tree, false);

        let mut all_tiles = HashSet::default();
        for shape_id in &ancestors {
            if let Some(shape) = tree.get(shape_id) {
                all_tiles.extend(self.update_shape_tiles(shape, tree));
            }
        }
        for tile in all_tiles {
            self.remove_cached_tile(tile);
        }
        Ok(())
    }

    pub fn render_shape_pixels(
        &mut self,
        id: &Uuid,
        tree: ShapesPoolRef,
        scale: f32,
        _timestamp: i32,
    ) -> Result<(Vec<u8>, i32, i32)> {
        let target_surface = SurfaceId::Export;

        // `render_shape_pixels` is used by the workspace to render thumbnails
        // using the same WASM renderer instance. It must not leak any state
        // into the main viewport renderer (focus mode, render context, tile
        // tracking, etc.). Save → run export → restore.
        let saved_focus_mode = self.focus_mode.clone();
        let saved_export_context = self.export_context;
        let saved_render_area = self.render_area;
        let saved_render_area_with_margins = self.render_area_with_margins;
        let saved_current_tile = self.current_tile;
        let saved_nested_fills = std::mem::take(&mut self.nested_fills);
        let saved_preview_mode = self.preview_mode;

        self.focus_mode.clear();

        self.surfaces
            .canvas(target_surface)
            .clear(skia::Color::TRANSPARENT);

        if tree.len() != 0 {
            let shape = tree.get(id).unwrap();
            let mut extrect = shape.extrect(tree, scale);
            self.export_context = Some((extrect, scale));
            let margins = self.surfaces.margins();
            extrect.offset((margins.width as f32 / scale, margins.height as f32 / scale));

            self.surfaces.resize_export_surface(scale, extrect);
            self.render_area = extrect;
            self.render_area_with_margins = extrect;
            self.surfaces.update_render_context(extrect, scale);

            // For export, do a simple depth-first render without tile scheduling
            self.render_export_subtree(*id, tree, target_surface, scale)?;
        }

        self.export_context = None;

        self.surfaces
            .flush_and_submit(&mut self.gpu_state, target_surface);

        let image = self.surfaces.snapshot(target_surface);
        let data = image
            .encode(
                &mut self.gpu_state.context,
                skia::EncodedImageFormat::PNG,
                100,
            )
            .expect("PNG encode failed");
        let skia::ISize { width, height } = image.dimensions();

        // Restore workspace state.
        self.focus_mode = saved_focus_mode;
        self.export_context = saved_export_context;
        self.render_area = saved_render_area;
        self.render_area_with_margins = saved_render_area_with_margins;
        self.current_tile = saved_current_tile;
        self.nested_fills = saved_nested_fills;
        self.preview_mode = saved_preview_mode;

        // Restore render-surface transforms for the workspace context.
        let workspace_scale = self.get_scale();
        if !self.render_area.is_empty() {
            self.surfaces
                .update_render_context(self.render_area, workspace_scale);
        }

        Ok((data.as_bytes().to_vec(), width, height))
    }

    /// Simple depth-first render for export (no tile scheduling needed).
    fn render_export_subtree(
        &mut self,
        shape_id: Uuid,
        tree: ShapesPoolRef,
        target: SurfaceId,
        scale: f32,
    ) -> Result<()> {
        let Some(shape) = tree.get(&shape_id) else {
            return Ok(());
        };

        if shape.hidden {
            return Ok(());
        }

        self.focus_mode.enter(&shape_id);

        if self.focus_mode.is_active() {
            if shape.is_recursive() {
                self.render_shape_enter(shape, target, false);

                // Draw the container's own body (fill) before its children. The
                // tiled render paints this via a separate `Paint(ShapeBody)`
                // scheduler step, but this non-tile export recursion only did
                // enter → children → exit, so a frame/group's own fill was never
                // painted — an empty frame exported blank. `render_shape_into_target`
                // no-ops for containers with no fill/stroke and skips strokes on
                // clipped frames (drawn on top in `render_shape_exit`).
                self.render_shape_into_target(shape, target)?;

                let children = shape.children_ids(false);
                for child_id in &children {
                    self.render_export_subtree(*child_id, tree, target, scale)?;
                }

                // Export path is non-tile-scheduler; layer wrapping
                // stays inline in `render_shape_exit`, never externalized.
                self.render_shape_exit(shape, None, target, false)?;
            } else {
                // Render the shape
                self.render_background_blur(shape, target);

                if let Some(glass) = shape.glass.as_ref().filter(|g| !g.hidden) {
                    crate::render::glass::render_glass(self, shape, glass, target);
                }

                // Phase H.3: route export draw through scheduler-native
                // dispatcher; downstream paths handle their own blits.
                self.render_shape_into_target(shape, target)?;

                self.surfaces
                    .canvas(SurfaceId::DropShadows)
                    .clear(skia::Color::TRANSPARENT);
            }
        }

        self.focus_mode.exit(&shape_id);
        Ok(())
    }
}

