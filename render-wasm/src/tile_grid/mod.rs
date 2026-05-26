//! Dependency-aware tile scheduler for the render-wasm renderer.
//!
//! Replaces `PendingTiles`, `pending_nodes`, and `TileHashMap` with a single
//! data structure that pre-computes a topologically sorted, flat render schedule.
//! Tiles containing gather effects (glass, background blur) render after their
//! dependency tiles, so the accumulated Target surface provides a correct
//! cross-tile backdrop.

#![cfg(feature = "tile-scheduler")]

// SSA Surface IR — see `docs/ssa-surface-ir-plan.md`. Lives alongside the
// legacy scheduler during the rewrite; gated by `ssa-ir` for active use but
// always compiled so it can't bit-rot from the rest of the module.
pub mod ssa;

use std::collections::BinaryHeap;

// Hash map/set used throughout this module are FxHash-backed: small-key
// hashing (Tile = (i32, i32), BandKey, Uuid) dominates the scheduler hot
// path, and SipHash (the std default) is ~3-4× slower than FxHash on
// these tiny keys. Aliasing the names so the rest of the module reads
// like ordinary `HashMap` / `HashSet` code.
pub use rustc_hash::FxHashMap as HashMap;
pub use rustc_hash::FxHashSet as HashSet;

use skia_safe as skia;

use crate::error::{Error, Result};
use crate::performance;
use crate::render::{OpenScope, RenderState, ScopeAllocation, SurfaceId};
use crate::shapes::{BlurType, Shape, Type};
use crate::state::{ShapesPoolMutRef, ShapesPoolRef};
use crate::tiles::{self, Tile, TileRect, TileViewbox};
use crate::uuid::Uuid;
use crate::view::Viewbox;
use crate::wapi;

// ── Data structures ─────────────────────────────────────────────────────

/// Per-shape metadata stored inline in the spatial index.
/// Only derived data — the full shape is always read from ShapesPool.
#[derive(Debug, Clone)]
pub struct ShapeEntry {
    pub id: Uuid,
    pub z_index: i32,
    /// Depth-first paint rank (bottom-first), populated during TileGrid::rebuild
    /// or update_touched via renumber_paint_order. Entries constructed outside
    /// those passes use 0 as a placeholder and get corrected on the next
    /// renumber, which always runs before build_dependency_graph.
    pub paint_order: u32,
    pub has_gather: bool,
}

/// A contiguous run of shapes within one tile, bounded by that tile's
/// gather-barrier paint orders. Populated by `compute_bands`.
#[derive(Debug, Clone)]
pub struct Band {
    /// Shape ids in paint order (ascending).
    pub shapes: Vec<Uuid>,
    /// Lowest `paint_order` among entries in this band.
    pub min_paint_order: u32,
    /// Highest `paint_order` among entries in this band.
    pub max_paint_order: u32,
    /// The gather at the head of the band, if this band starts at a barrier.
    pub gather_at_head: Option<Uuid>,
}

/// Scheduler node: a specific band within a specific tile. `band_index` is
/// T-local and packed — 0, 1, 2, … per tile — no cross-tile meaning.
#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
pub struct BandKey {
    pub tile: Tile,
    pub band_index: u32,
}

impl BandKey {
    fn new(tile: Tile, band_index: u32) -> Self {
        Self { tile, band_index }
    }
}

/// How a band is finalized when its shape steps end. Pre-computed at
/// schedule-build time so `run_schedule` never has to infer state at
/// yield/resume boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizeKind {
    /// Non-last band of a multi-band tile. Push this band's Current content
    /// to Target (so later peer gather bands can sample it) and snapshot
    /// Current into the interband cache so this tile's next band can
    /// restore it.
    Intermediate,
    /// Tile's last band, and the band had shapes to render. Apply Current
    /// to the final canvas and drop the interband cache entry.
    LastContent,
    /// Tile's last band, no shapes in the band (synthetic empty-tile bg
    /// clear). Draw bg directly on Target — faster than touching Current.
    LastBg,
}

/// Identifier for a per-frame cache the scheduler owns end-to-end.
///
/// The scheduler decides at emit time which shapes need caching, when to
/// build (`BuildCache`), and when to release (`FreeCache`). The renderer
/// runs no cache-presence checks of its own — it just executes the steps
/// the scheduler emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheKind {
    /// Pre-rendered displaced image for a scatter (texture) shape.
    /// Built once per frame; consumed per-tile by `Paint(scatter_id)`.
    Scatter(Uuid),
    /// Backdrop snapshot for a gather/glass effect.
    /// Built once per frame at the head of the gather's band, after
    /// upstream bands' content has been flushed into Target.
    Gather(Uuid),
    /// V2c.1 — pre-rendered, layer-blurred shape body for a leaf
    /// shape with `shape.blur = LayerBlur(_)`. Built once per frame;
    /// consumed per-tile by the `LocalFx::LayerBlur` Paint arm.
    LocalBlur(Uuid),
}

/// A single step in the pre-computed render schedule.
#[derive(Debug, Clone)]
pub enum RenderStep {
    /// Begin rendering a band: set up the tile context, and either clear
    /// Current (is_first) or restore Current from the interband cache
    /// (non-first band). `is_last` is retained for tests/debug only —
    /// finalize semantics live in the paired `FinalizeBand` step.
    SetTileBand {
        tile: Tile,
        band_index: u32,
        is_first: bool,
        is_last: bool,
    },
    /// Finalize the band that `SetTileBand` opened. The `kind` is
    /// determined at build time so a yield between Render and
    /// FinalizeBand cannot corrupt the finalize path.
    FinalizeBand {
        tile: Tile,
        kind: FinalizeKind,
    },
    /// Enter a container (Frame/Group): clip, transform, run prep
    /// (bg_blur / glass / drop shadows / container body draws).
    /// `has_external_layer` mirrors the scheduler's choice: when true,
    /// a paired `BeginLayer` step preceded this `Enter` and pushed the
    /// save_layer for opacity/blend/frame-blur, so `render_shape_enter`
    /// must skip its inline save_layer. `has_external_gather` (P6) is
    /// true for scoped container gather shapes — the preceding
    /// `PaintGather` already ran the gather work, so the dispatcher
    /// must skip the inline `render_background_blur` / `render_glass`
    /// calls. Both are pre-baked at emit time so the dispatcher never
    /// re-runs the predicate.
    Enter {
        shape: Uuid,
        has_external_layer: bool,
        has_external_gather: bool,
    },
    /// V2c.2 — push a `save_layer` with prebuilt paint (opacity / blend
    /// / frame-clip blur). Brackets a leaf's Paint or a container's
    /// Enter→children→Exit sequence. Paired exactly with `EndLayer`.
    BeginLayer { shape: Uuid, paint: LayerPaint },
    /// Build a per-frame cache. Emitted once per `CacheKind` per frame at
    /// the right position relative to the consumers. Replaces the inline
    /// `has_X` runtime checks that the renderer used to do.
    BuildCache(CacheKind),
    /// V3 — gather effects (BackgroundBlur, Glass). Emitted BEFORE the
    /// shape's `BeginLayer` so the gather samples the un-isolated backdrop
    /// even when the body is wrapped in a save_layer for opacity/blend.
    /// Empty `effects` is not emitted — caller filters.
    PaintGather {
        shape: Uuid,
        output: SurfaceId,
        effects: Vec<GatherFx>,
    },
    /// V3 — non-gather effects (Scatter, Local). Emitted AFTER `BeginLayer`
    /// so opacity/blend wraps just the body, not the gather backdrop draw.
    PaintBody {
        shape: Uuid,
        output: SurfaceId,
        effects: Vec<EffectKey>,
    },
    /// V2c.2 — pop the save_layer pushed by the matching `BeginLayer`.
    EndLayer { shape: Uuid },
    /// V3 — open a scope for a container frame whose descendants need
    /// frame-local backdrop sampling (nested glass / bg_blur). One pair
    /// is emitted per tile that touches the frame; the runtime treats
    /// subsequent `PushScope`s for the same shape as re-entry (no
    /// re-allocation). `has_ancestor_snapshot` is true iff the frame's
    /// subtree contains a gather descendant — only then does the runtime
    /// allocate the `anc_F` snapshot.
    PushScope {
        shape: Uuid,
        has_ancestor_snapshot: bool,
    },
    /// V3 — close the matching `PushScope`. `is_final_tile` marks the
    /// last `PopScope` of `shape` in the schedule; the runtime composites
    /// `scope_F` onto its parent and frees the scope only on the final
    /// PopScope. Resolved post-topo-sort by `mark_final_pop_scopes`.
    PopScope {
        shape: Uuid,
        is_final_tile: bool,
    },
    /// Exit a container: post-prep + restore layer (legacy path) or
    /// post-prep only (V2c.2 external-layer path; the matching
    /// `EndLayer` pops the save_layer). Mirror of `Enter`.
    Exit {
        shape: Uuid,
        has_external_layer: bool,
    },
    /// Release a per-frame cache. Emitted at the tail of the schedule for
    /// each cache the scheduler built — replaces the legacy end-of-frame
    /// global clears (`clear_scatter_output_cache`, `clear_glass_backdrop_cache`).
    FreeCache(CacheKind),
}

impl Default for RenderStep {
    /// Cheap, no-allocating sentinel used by `next()` to swap a step out
    /// of the schedule via `mem::take`. Never observed by callers — the
    /// cursor always advances past consumed slots before the next read.
    fn default() -> Self {
        RenderStep::Enter {
            shape: Uuid::nil(),
            has_external_layer: false,
            has_external_gather: false,
        }
    }
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
fn layer_paint_for_shape(shape: &Shape) -> Option<LayerPaint> {
    if !shape_qualifies_for_external_layer(shape) {
        return None;
    }
    Some(LayerPaint {
        opacity: shape.opacity(),
        blend_mode: shape.blend_mode().into(),
        frame_blur_sigma_dev: None,
    })
}

/// V3 P6 — like `layer_paint_for_shape` but lifts the gather exclusion.
/// For shapes inside a `PushScope`, the scheduler emits a `PaintGather`
/// BEFORE `BeginLayer`, so the gather samples the un-isolated backdrop
/// while the save_layer wraps only the body. The legacy exclusion (which
/// existed because the inline gather in `render_shape_enter` runs before
/// save_layer) no longer applies. Masked groups and frame-clip layer-blur
/// stay excluded because their plumbing is still on the legacy path.
fn layer_paint_for_scoped_shape(shape: &Shape) -> Option<LayerPaint> {
    if !shape.needs_layer() {
        return None;
    }
    if matches!(&shape.shape_type, Type::Group(g) if g.masked) {
        return None;
    }
    if shape.has_frame_clip_layer_blur() {
        return None;
    }
    Some(LayerPaint {
        opacity: shape.opacity(),
        blend_mode: shape.blend_mode().into(),
        frame_blur_sigma_dev: None,
    })
}

/// V3 scope predicate (input only — no callers in P1).
///
/// A container frame is "scoped" when:
///   1. it is recursive (i.e. it can have children — frames/groups), AND
///   2. its subtree contains a gather effect (glass or background blur), AND
///   3. either it needs isolation in its own right (opacity / blend /
///      mask / clip / frame-blur), OR a direct child is a gather shape.
///
/// (3) covers two motivating cases:
///   - frame F has opacity 0.5 and contains a gather descendant: F must
///     be a scope so the gather's backdrop reads F's body, not Target.
///   - frame F has no special effects but directly contains a glass
///     leaf: F must be a scope so the glass refraction stays inside F.
///
/// Without (2) (no descendant gather), the existing per-tile compositor
/// path is sufficient — no scope surface needed. Without (3), F's
/// children draw straight to the parent's surface and the gather sees
/// the same result.
///
/// `subtree_has_gather` is supplied by `TileGrid::has_gather_in_subtree`,
/// which is populated during `index_shape_recursive` (rebuild) or
/// `recompute_subtree_has_gather` (incremental).
fn needs_scope(
    shape: &Shape,
    subtree_has_gather: bool,
    tree: ShapesPoolRef,
) -> bool {
    if !shape.is_recursive() {
        return false;
    }
    if !subtree_has_gather {
        return false;
    }
    if needs_isolation(shape) {
        return true;
    }
    has_direct_gather_child(shape, tree)
}

/// Does this shape need its content isolated from siblings? Wider than
/// `shape_qualifies_for_external_layer` — adds `clip=true` (frames where
/// children that overflow are visually cut) and keeps gather/bg_blur
/// shapes IN the set (under the scope model, `PushScope` fires BEFORE
/// the inline gather work in `Enter`, so the layer wraps correctly).
fn needs_isolation(shape: &Shape) -> bool {
    if matches!(&shape.shape_type, Type::Group(g) if g.masked) {
        // Masked groups stay on the legacy two-pass path — their DstIn
        // plumbing is incompatible with the scope model. P6 revisits.
        return false;
    }
    if shape.has_frame_clip_layer_blur() {
        // Frame-clip layer-blur stacks an image_filter on the inline
        // save_layer; lifting needs careful sigma threading. Defer.
        return false;
    }
    if shape.needs_layer() {
        return true;
    }
    // `clip = true` frames implicitly isolate their children to their
    // own bbox. Worth scoping so a descendant gather doesn't sample
    // beyond the clip rect.
    if matches!(&shape.shape_type, Type::Frame(_)) && shape.clip() {
        return true;
    }
    false
}

/// Does this shape have at least one immediate (depth=1) child with a
/// visible gather effect? Used by `needs_scope` to handle frames whose
/// only reason to scope is "I directly contain a gather". Cheaper than
/// re-walking the subtree.
fn has_direct_gather_child(shape: &Shape, tree: ShapesPoolRef) -> bool {
    for child_id in shape.children_ids(false) {
        if let Some(child) = tree.get(&child_id) {
            if !child.hidden && TileGrid::shape_has_gather(child) {
                return true;
            }
        }
    }
    false
}

/// Entry in the priority queue for Kahn's algorithm.
/// Lower priority value = renders first.
#[derive(Eq, PartialEq)]
struct BandPriority {
    key: BandKey,
    /// Priority group: 0 = visible, 1 = interest-only.
    group: u8,
    /// Spiral position of `key.tile` (lower = closer to center).
    spiral_index: usize,
}

impl Ord for BandPriority {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // BinaryHeap is a max-heap, so reverse: lowest group wins, then lowest
        // spiral_index, then lowest band_index so earlier bands on a tile
        // precede later ones when both are ready.
        other
            .group
            .cmp(&self.group)
            .then(other.spiral_index.cmp(&self.spiral_index))
            .then(other.key.band_index.cmp(&self.key.band_index))
    }
}

impl PartialOrd for BandPriority {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Spatial index + topological scheduler.
/// Rebuilt on viewport/shape changes. The renderer just iterates the schedule.
pub struct TileGrid {
    // ── Spatial index ────────────────────────────────────────────────
    /// Tile → shapes on it, sorted by z-index.
    grid: HashMap<Tile, Vec<ShapeEntry>>,
    /// Shape → tiles it occupies.
    index: HashMap<Uuid, HashSet<Tile>>,

    // ── Band model (populated per rebuild by `compute_bands`) ────────
    /// Tile → packed list of bands (band_index 0, 1, 2, …). Empty vec or
    /// missing key means the tile has no shapes in the interest rect.
    bands: HashMap<Tile, Vec<Band>>,

    // ── Render schedule ──────────────────────────────────────────────
    /// Pre-computed flat render schedule. Index 0 executes first.
    schedule: Vec<RenderStep>,
    /// Current position for yield/resume across animation frames.
    cursor: usize,

    // ── Scheduler-owned cache tracking (per rebuild) ─────────────────
    /// Caches the scheduler has already emitted a `BuildCache` step for in
    /// the current rebuild. Cleared at the start of each `rebuild` so
    /// emission is exactly-once-per-frame.
    emitted_caches: HashSet<CacheKind>,

    // ── Per-tile root-children prefilter (rebuilt per `rebuild`) ─────
    /// Tile → root-level shapes whose visibility check_rect (extrect for
    /// containers, selrect for leaves) intersects the tile, in paint order
    /// (bottom-first). Used by `build_schedule` to skip the
    /// O(productive_tiles × root_children) scan that would otherwise
    /// dominate at scenes with many top-level shapes (10k root children
    /// × 144 productive tiles = 1.44M intersection tests/frame).
    root_tiles: HashMap<Tile, Vec<Uuid>>,

    // ── Scope precondition (rebuilt per `rebuild`) ──────────────────
    /// Shape id → whether the subtree rooted at this shape (inclusive)
    /// contains any gather effect (glass / background blur). Populated by
    /// `index_shape_recursive` via bubble-up: a shape's bit ORs its own
    /// `has_gather` with all its descendants'. Consumed by `needs_scope`
    /// at emit time to decide whether to push a scope around a container.
    /// Without this lookup, every container would have to walk its
    /// subtree at emit time to know whether a scope is needed.
    subtree_has_gather: HashMap<Uuid, bool>,
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
    // Phase E: for masked groups, `children_ids(false)` drops the
    // mask child (Penpot convention: `children[0]` = mask). We need
    // it indexed in the tile grid too so the scheduler can emit
    // Paint(mask) inside the DstIn layer in `emit_masked_group_steps`.
    if let Type::Group(group) = shape.shape_type {
        if group.masked {
            if let Some(mask_id) = shape.mask_id() {
                ids.push(*mask_id);
            }
        }
    }
    ids
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
        // Drop shadows are skipped for text shapes — text emits its
        // shadows via the paragraph image filter inside `render_shape`,
        // so the scheduler doesn't need a separate `DropShadows` step.
        let is_text = matches!(shape.shape_type, Type::Text(_));
        if !is_text && shape.drop_shadows_visible().next().is_some() {
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

/// Push the gather + body steps for a leaf shape onto `schedule`. When a
/// shape has no gather effects, the gather step is skipped — no empty
/// steps land in the schedule.
fn push_paint_steps(schedule: &mut Vec<RenderStep>, shape: &Shape) {
    let (gather, body) = paint_plan_for_shape(shape);
    if !gather.is_empty() {
        schedule.push(RenderStep::PaintGather {
            shape: shape.id,
            output: SurfaceId::Current,
            effects: gather,
        });
    }
    schedule.push(RenderStep::PaintBody {
        shape: shape.id,
        output: SurfaceId::Current,
        effects: body,
    });
}

impl TileGrid {
    pub fn new() -> Self {
        TileGrid {
            grid: HashMap::default(),
            index: HashMap::default(),
            bands: HashMap::default(),
            schedule: Vec::new(),
            cursor: 0,
            emitted_caches: HashSet::default(),
            root_tiles: HashMap::default(),
            subtree_has_gather: HashMap::default(),
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

    pub fn invalidate(&mut self) {
        self.grid.clear();
        self.index.clear();
        self.bands.clear();
        self.schedule.clear();
        self.cursor = 0;
        self.emitted_caches.clear();
        self.subtree_has_gather.clear();
    }

    // ── Schedule control ────────────────────────────────────────────

    pub fn reset(&mut self) {
        self.cursor = 0;
    }

    pub fn next(&mut self) -> Option<RenderStep> {
        if self.cursor < self.schedule.len() {
            // `mem::take` swaps the slot for `RenderStep::default()` (a cheap
            // unit-like variant) and returns the original. O(1), no allocator
            // hits — important since `PaintBody`'s `Vec<EffectKey>` would otherwise
            // clone twice per step in the hot dispatch loop. The cursor advances
            // past the consumed slot immediately, so no caller observes the
            // sentinel; the slot's `Default` is dropped on the next `rebuild()`.
            let step = std::mem::take(&mut self.schedule[self.cursor]);
            self.cursor += 1;
            Some(step)
        } else {
            None
        }
    }

    /// Skip forward to the next SetTileBand step (used when the current
    /// tile's band is cached).
    pub fn skip_to_next_tile(&mut self) {
        while self.cursor < self.schedule.len() {
            if matches!(self.schedule[self.cursor], RenderStep::SetTileBand { .. }) {
                break;
            }
            self.cursor += 1;
        }
    }

    // ── Full rebuild ────────────────────────────────────────────────

    /// Rebuild the full spatial index and render schedule from the shape tree.
    ///
    /// Steps:
    /// 1. Walk shape tree, assign shapes to tiles
    /// 2. Generate spiral from viewport
    /// 3. Scan for gather effects → build dependency edges
    /// 4. Topological sort with spiral priority tiebreaker
    /// 5. Flatten into Vec<RenderStep>
    pub fn rebuild(
        &mut self,
        tree: ShapesPoolRef,
        tile_viewbox: &TileViewbox,
        scale: f32,
    ) {
        performance::begin_measure!("tile_grid_rebuild");

        self.grid.clear();
        self.index.clear();
        self.bands.clear();
        self.schedule.clear();
        self.cursor = 0;
        self.emitted_caches.clear();
        self.root_tiles.clear();
        self.subtree_has_gather.clear();

        let tile_size = tiles::get_tile_size(scale);
        let interest_rect = &tile_viewbox.interest_rect;

        // Step 1: Walk shape tree, assign shapes to tiles (and assign paint_order).
        {
            crate::perf_guard!("rebuild_step1_index_shapes");
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
            } else {
            }
        }

        // Step 1b: Build the per-tile root-children prefilter. Only top-level
        // shapes go here, with the visibility check_rect that
        // `build_schedule`'s `visible_roots` cache used to recompute per
        // productive tile.
        {
            crate::perf_guard!("rebuild_step1b_root_tiles");
            self.build_root_tiles(tree, tile_size, interest_rect, scale);
        }

        // Step 2: Generate spiral
        let spiral = {
            crate::perf_guard!("rebuild_step2_spiral");
            Self::generate_spiral(interest_rect)
        };

        // Step 3: Compute bands per tile (barriers = paint_orders of gathers
        // whose sample regions reach this tile, plus the tile's own gathers).
        {
            crate::perf_guard!("rebuild_step3_compute_bands");
            self.compute_bands(tree, tile_size, interest_rect, scale);
        }

        // Step 4: Build dependency graph over BandKeys
        let deps = {
            crate::perf_guard!("rebuild_step4_dep_graph");
            self.build_dependency_graph(tree, tile_size, interest_rect, scale)
        };

        // Step 5: Topological sort with priority
        let (sorted_bands, empty_tiles) = {
            crate::perf_guard!("rebuild_step5_toposort");
            self.topological_sort(&spiral, &deps, tile_viewbox)
        };

        // Step 6: Flatten into render schedule
        {
            crate::perf_guard!("rebuild_step6_build_schedule");
            self.build_schedule(&sorted_bands, &empty_tiles, tree, scale);
        }

        performance::end_measure!("tile_grid_rebuild");
    }

    /// Incremental update: only re-index touched shapes and rebuild schedule.
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

        // If every touched shape's paint_order can be recovered from its
        // existing grid entry, the depth-first paint counter is unchanged
        // and we can skip the full-tree `renumber_paint_order` pass. New
        // shapes (no prior entry) force a full renumber as before.
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
                    let has_gather = Self::shape_has_gather(shape);
                    let z_index = shape.z_index();
                    let extrect = shape.extrect(tree, scale);
                    let shape_tiles = tiles::get_tiles_for_rect(extrect, tile_size);

                    // Use the prior paint_order if known. If the shape is
                    // new (no prior entries), fall back to placeholder 0
                    // and force a full renumber after the loop.
                    let paint_order = match prev_paint_order {
                        Some(po) => po,
                        None => {
                            needs_full_renumber = true;
                            0
                        }
                    };

                    // Intersect with interest area
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
                                        z_index,
                                        paint_order,
                                        has_gather,
                                    },
                                );
                                affected_tiles.insert(tile);
                            }
                        }
                    }
                }
            }
        }

        // Renumber only if some touched id had no prior entry (a brand-new
        // shape). For the typical drag/move case (touched shapes already
        // existed last frame) this pass is fully skipped — the existing
        // depth-first counter is still valid because tree topology is
        // unchanged, and `add_shape_at` already inserts at the
        // paint-order-sorted position so per-tile sort invariant holds.
        if needs_full_renumber {
            self.renumber_paint_order(tree);
        }

        // Rebuild schedule with updated index
        self.bands.clear();
        self.compute_bands(tree, tile_size, interest_rect, scale);
        // Root-tiles prefilter must mirror what `rebuild` builds; clear and
        // re-fill, otherwise `build_root_tiles` appends to stale entries
        // every frame and the per-tile id list grows unbounded.
        self.root_tiles.clear();
        self.build_root_tiles(tree, tile_size, interest_rect, scale);
        // `subtree_has_gather` is bubbled by `index_shape_recursive` during
        // full rebuilds. The incremental path doesn't recurse, so any
        // change to a shape's own `has_gather` (toggling glass on a leaf)
        // wouldn't propagate to ancestors' bits. Recompute by a separate
        // DFS over the tree — cheap (one bool OR per shape).
        self.subtree_has_gather.clear();
        self.recompute_subtree_has_gather(tree);
        let spiral = Self::generate_spiral(interest_rect);
        let deps = self.build_dependency_graph(tree, tile_size, interest_rect, scale);
        let (sorted_bands, empty_tiles) =
            self.topological_sort(&spiral, &deps, tile_viewbox);
        self.build_schedule(&sorted_bands, &empty_tiles, tree, scale);

        affected_tiles
    }

    // ── Internal helpers ────────────────────────────────────────────

    /// Check if a shape has a gather effect (glass or background blur).
    fn shape_has_gather(shape: &Shape) -> bool {
        let has_glass = shape
            .glass
            .as_ref()
            .is_some_and(|g| !g.hidden);

        let has_bg_blur = shape
            .background_blur
            .is_some_and(|b| !b.hidden);

        has_glass || has_bg_blur
    }

    /// Build `self.root_tiles`: for every top-level shape, push its id into
    /// every tile its visibility check_rect intersects, in paint order
    /// (bottom-first). Mirrors the per-root visibility test that used to
    /// live inside `build_schedule`'s `visible_roots` cache loop, but pays
    /// the O(N_roots × tiles_per_root) cost once instead of paying
    /// O(N_roots × N_productive_tiles) per `visible_roots` build.
    ///
    /// Caller must clear `self.root_tiles` before calling.
    fn build_root_tiles(
        &mut self,
        tree: ShapesPoolRef,
        tile_size: f32,
        interest_rect: &TileRect,
        scale: f32,
    ) {
        let root_id = Uuid::nil();
        let Some(root) = tree.get(&root_id) else {
            return;
        };

        // children_ids returns topmost-first; reverse for bottom-first paint
        // order (matches `build_schedule`'s emission order).
        let mut root_children = root.children_ids(false);
        root_children.reverse();

        for &child_id in &root_children {
            let Some(shape) = tree.get(&child_id) else {
                continue;
            };
            if shape.hidden {
                continue;
            }

            // Same dual logic as the old `visible_roots` loop: containers
            // use extrect (descendants extend the visible footprint); leaves
            // use selrect (effects already accounted for upstream).
            let is_container = matches!(
                shape.shape_type,
                Type::Frame(_) | Type::Group(_)
            );
            let check_rect = if is_container {
                shape.extrect(tree, scale)
            } else {
                shape.selrect()
            };

            let shape_tiles = tiles::get_tiles_for_rect(check_rect, tile_size);

            // Intersect with interest area.
            let ix1 = shape_tiles.x1().max(interest_rect.x1());
            let iy1 = shape_tiles.y1().max(interest_rect.y1());
            let ix2 = shape_tiles.x2().min(interest_rect.x2());
            let iy2 = shape_tiles.y2().min(interest_rect.y2());

            if ix1 <= ix2 && iy1 <= iy2 {
                for tx in ix1..=ix2 {
                    for ty in iy1..=iy2 {
                        self.root_tiles
                            .entry(Tile::from(tx, ty))
                            .or_default()
                            .push(child_id);
                    }
                }
            }
        }
    }

    /// Recursively walk the shape tree and add shapes to the spatial index.
    /// Returns `true` if `shape_id`'s subtree (including itself) contains
    /// any gather effect. Used to populate `self.subtree_has_gather` for
    /// the scope predicate (`needs_scope`) at emit time without paying a
    /// second tree walk.
    fn index_shape_recursive(
        &mut self,
        shape_id: Uuid,
        tree: ShapesPoolRef,
        tile_size: f32,
        interest_rect: &TileRect,
        scale: f32,
        paint_counter: &mut u32,
    ) -> bool {
        let Some(shape) = tree.get(&shape_id) else {
            return false;
        };

        if shape.hidden {
            return false;
        }

        let paint_order = *paint_counter;
        *paint_counter += 1;

        let has_gather = Self::shape_has_gather(shape);
        let z_index = shape.z_index();
        let extrect = shape.extrect(tree, scale);
        let shape_tiles = tiles::get_tiles_for_rect(extrect, tile_size);

        // Intersect with interest area
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
                            z_index,
                            paint_order,
                            has_gather,
                        },
                    );
                }
            }
        }

        // Recurse into children in paint order so paint_order stays consistent
        // with how the schedule will emit them (bottom-first, flex/grid-aware).
        let mut subtree_has_gather = has_gather;
        if shape.is_recursive() {
            for child_id in paint_order_children(shape, tree) {
                let child_subtree = self.index_shape_recursive(
                    child_id,
                    tree,
                    tile_size,
                    interest_rect,
                    scale,
                    paint_counter,
                );
                subtree_has_gather = subtree_has_gather || child_subtree;
            }
        }

        self.subtree_has_gather.insert(shape_id, subtree_has_gather);
        subtree_has_gather
    }

    /// Walk the shape tree from root and rebuild `self.subtree_has_gather`
    /// from scratch. Used by the incremental update path
    /// (`update_touched`) where `index_shape_recursive` doesn't run.
    /// Returns whether `id`'s subtree (inclusive) contains a gather, so
    /// callers can compose results.
    fn recompute_subtree_has_gather(&mut self, tree: ShapesPoolRef) {
        let root_id = Uuid::nil();
        if let Some(root) = tree.get(&root_id) {
            for child_id in paint_order_children(root, tree) {
                self.recompute_subtree_has_gather_recurse(child_id, tree);
            }
        }
    }

    fn recompute_subtree_has_gather_recurse(
        &mut self,
        id: Uuid,
        tree: ShapesPoolRef,
    ) -> bool {
        let Some(shape) = tree.get(&id) else {
            return false;
        };
        if shape.hidden {
            return false;
        }
        let mut subtree = Self::shape_has_gather(shape);
        if shape.is_recursive() {
            for child_id in paint_order_children(shape, tree) {
                subtree =
                    self.recompute_subtree_has_gather_recurse(child_id, tree) || subtree;
            }
        }
        self.subtree_has_gather.insert(id, subtree);
        subtree
    }

    /// Read-only accessor for the scope predicate. Returns whether the
    /// subtree rooted at `id` (inclusive) contains a gather effect.
    /// Defaults to `false` for shapes not in the map (hidden, removed,
    /// or root which is implicit).
    pub fn has_gather_in_subtree(&self, id: Uuid) -> bool {
        self.subtree_has_gather.get(&id).copied().unwrap_or(false)
    }

    /// Walk the shape tree depth-first and overwrite every existing
    /// `ShapeEntry.paint_order` in `self.grid` with a fresh counter. Used by
    /// incremental updates where new entries were added with a placeholder
    /// `paint_order: 0` and pre-existing entries carry stale values.
    ///
    /// Since this mutates `paint_order` in place without preserving the
    /// `add_shape_at` insertion-order invariant, it finishes with a
    /// per-tile sort so downstream consumers (`compute_bands`) can trust
    /// that `self.grid[tile]` is paint-order-sorted.
    fn renumber_paint_order(&mut self, tree: ShapesPoolRef) {
        let mut counter: u32 = 0;
        let root_id = Uuid::nil();
        if let Some(root) = tree.get(&root_id) {
            for child_id in paint_order_children(root, tree) {
                self.renumber_recurse(&mut counter, child_id, tree);
            }
        }
        // Restore the paint-order invariant for every tile touched by this
        // renumber pass. Each tile has a tiny entry count relative to total
        // shapes, so `sort_unstable_by_key` stays cheap.
        for entries in self.grid.values_mut() {
            entries.sort_unstable_by_key(|e| e.paint_order);
        }
    }

    fn renumber_recurse(&mut self, counter: &mut u32, id: Uuid, tree: ShapesPoolRef) {
        let Some(shape) = tree.get(&id) else {
            return;
        };
        if shape.hidden {
            return;
        }
        let po = *counter;
        *counter += 1;
        // Update every ShapeEntry for this shape across the tiles it occupies.
        if let Some(tiles) = self.index.get(&id).cloned() {
            for tile in tiles {
                if let Some(entries) = self.grid.get_mut(&tile) {
                    for e in entries.iter_mut() {
                        if e.id == id {
                            e.paint_order = po;
                        }
                    }
                }
            }
        }
        if shape.is_recursive() {
            for child in paint_order_children(shape, tree) {
                self.renumber_recurse(counter, child, tree);
            }
        }
    }

    /// Compute per-tile bands. A band is a contiguous run of shapes (in
    /// paint-order) bounded by gather-barriers *relevant to that tile*. A
    /// tile's barriers are the `paint_order` values of every gather G such
    /// that T is in G's sample region (plus G's own tile, so the gather
    /// always sits at the head of a band in its home tile). Tiles outside
    /// every gather's sample region get exactly one band — the hot path
    /// stays identical to the pre-refactor scheduler.
    fn compute_bands(
        &mut self,
        tree: ShapesPoolRef,
        tile_size: f32,
        interest_rect: &TileRect,
        scale: f32,
    ) {
        // Pre-pass: for each gather, push its paint_order into every
        // sample-region tile's barrier list.
        let mut barriers: HashMap<Tile, Vec<u32>> = HashMap::default();

        // Collect (gather_tile, shape_id, paint_order) first to avoid
        // borrowing self.grid twice (compute_gather_sample_rect takes &self).
        let gathers: Vec<(Tile, Uuid, u32)> = self
            .grid
            .iter()
            .flat_map(|(tile, entries)| {
                entries.iter().filter(|e| e.has_gather).map(move |e| (*tile, e.id, e.paint_order))
            })
            .collect();

        for (gather_tile, shape_id, g_po) in gathers {
            let Some(shape) = tree.get(&shape_id) else {
                continue;
            };
            let sample_rect = self.compute_gather_sample_rect(shape, tree, scale);
            let sample_tiles = tiles::get_tiles_for_rect(sample_rect, tile_size);

            let sx1 = sample_tiles.x1().max(interest_rect.x1());
            let sy1 = sample_tiles.y1().max(interest_rect.y1());
            let sx2 = sample_tiles.x2().min(interest_rect.x2());
            let sy2 = sample_tiles.y2().min(interest_rect.y2());

            if sx1 <= sx2 && sy1 <= sy2 {
                for stx in sx1..=sx2 {
                    for sty in sy1..=sy2 {
                        barriers.entry(Tile::from(stx, sty)).or_default().push(g_po);
                    }
                }
            }
            // Ensure G's own tile carries the barrier even if the sample region
            // happens not to cover it (compute_gather_sample_rect could in
            // principle return a rect that excludes the shape's own tile).
            barriers.entry(gather_tile).or_default().push(g_po);
        }

        for v in barriers.values_mut() {
            v.sort();
            v.dedup();
        }

        // Per-tile band computation. Each shape falls into a "bucket" =
        // (number of barriers ≤ its paint_order). Consecutive entries with
        // the same bucket form a band. A shape whose paint_order equals a
        // barrier AND is itself a gather gets marked as the band's head.
        for (tile, entries) in &self.grid {
            if entries.is_empty() {
                continue;
            }

            let empty = Vec::new();
            let bars = barriers.get(tile).unwrap_or(&empty);

            // Entries are paint-order-sorted by invariant:
            //   - `add_shape_at` inserts at the binary-search position
            //   - `renumber_paint_order` re-sorts each tile at its end
            // so we can walk `entries` directly.

            let bucket_of = |po: u32| -> usize {
                // Count of barriers ≤ po (partition_point returns the first
                // index whose element is > po, which is exactly this count).
                bars.partition_point(|&b| b <= po)
            };

            let mut packed: Vec<Band> = Vec::new();
            let mut current_shapes: Vec<Uuid> = Vec::new();
            let mut current_min: u32 = u32::MAX;
            let mut current_max: u32 = 0;
            let mut current_gather_at_head: Option<Uuid> = None;
            let mut current_bucket: Option<usize> = None;

            for e in entries.iter() {
                let bucket = bucket_of(e.paint_order);
                if current_bucket != Some(bucket) {
                    // Flush the previous band.
                    if !current_shapes.is_empty() {
                        packed.push(Band {
                            shapes: std::mem::take(&mut current_shapes),
                            min_paint_order: current_min,
                            max_paint_order: current_max,
                            gather_at_head: current_gather_at_head.take(),
                        });
                        current_min = u32::MAX;
                        current_max = 0;
                    }
                    current_bucket = Some(bucket);
                    // Mark as gather head iff this entry's po equals the
                    // barrier that opens this bucket AND the entry is itself
                    // a gather. (If two gathers share a paint_order — rare —
                    // we pick the first one as head; subsequent ones are
                    // still gathers but treated as regular band members.)
                    if e.has_gather && bucket > 0 && bars[bucket - 1] == e.paint_order {
                        current_gather_at_head = Some(e.id);
                    }
                }
                current_shapes.push(e.id);
                if e.paint_order < current_min {
                    current_min = e.paint_order;
                }
                if e.paint_order > current_max {
                    current_max = e.paint_order;
                }
            }
            if !current_shapes.is_empty() {
                packed.push(Band {
                    shapes: std::mem::take(&mut current_shapes),
                    min_paint_order: current_min,
                    max_paint_order: current_max,
                    gather_at_head: current_gather_at_head.take(),
                });
            }

            if !packed.is_empty() {
                self.bands.insert(*tile, packed);
            }
        }
    }

    /// Build dependency graph: for each band headed by a gather G, record
    /// which bands must render first — specifically, every band on every
    /// sample-region tile whose `max_paint_order < G.paint_order`. Because G
    /// contributes a barrier to each sample-region tile, those tiles' bands
    /// split cleanly at G's paint_order, so "below-G" bands are a well-
    /// defined prefix and every dep edge is acyclic by construction.
    fn build_dependency_graph(
        &self,
        tree: ShapesPoolRef,
        tile_size: f32,
        interest_rect: &TileRect,
        scale: f32,
    ) -> HashMap<BandKey, HashSet<BandKey>> {
        let mut deps: HashMap<BandKey, HashSet<BandKey>> = HashMap::default();

        // Precompute the "strictly-below-G backstop" source: every
        // non-gather band, sorted by max_paint_order. For a gather with
        // paint_order `g_po`, eligible dep targets are a prefix of this
        // sorted list (everything with max_po < g_po). Replaces the old
        // O(G · B) nested scan with one O(B log B) sort + O(G · cutoff)
        // prefix walk.
        let non_gather_count = self
            .bands
            .values()
            .map(|v| v.iter().filter(|b| b.gather_at_head.is_none()).count())
            .sum::<usize>();
        let mut non_gather_bands: Vec<(u32, BandKey)> =
            Vec::with_capacity(non_gather_count);
        for (tile, bands) in &self.bands {
            for (idx, band) in bands.iter().enumerate() {
                if band.gather_at_head.is_none() {
                    non_gather_bands
                        .push((band.max_paint_order, BandKey::new(*tile, idx as u32)));
                }
            }
        }
        non_gather_bands.sort_unstable_by_key(|(po, _)| *po);

        for (tile, bands) in &self.bands {
            for (band_idx, band) in bands.iter().enumerate() {
                let Some(g_id) = band.gather_at_head else {
                    continue;
                };
                let g_po = band.min_paint_order; // the gather sits at the head
                let Some(shape) = tree.get(&g_id) else {
                    continue;
                };

                let sample_rect = self.compute_gather_sample_rect(shape, tree, scale);
                let sample_tiles = tiles::get_tiles_for_rect(sample_rect, tile_size);

                let sx1 = sample_tiles.x1().max(interest_rect.x1());
                let sy1 = sample_tiles.y1().max(interest_rect.y1());
                let sx2 = sample_tiles.x2().min(interest_rect.x2());
                let sy2 = sample_tiles.y2().min(interest_rect.y2());

                let key = BandKey::new(*tile, band_idx as u32);

                let dep_set = deps.entry(key).or_default();

                for stx in sx1..=sx2 {
                    for sty in sy1..=sy2 {
                        let sample_tile = Tile::from(stx, sty);
                        let Some(sample_bands) = self.bands.get(&sample_tile) else {
                            continue;
                        };
                        for (sidx, sband) in sample_bands.iter().enumerate() {
                            // Edges point toward strictly-lower paint-order
                            // bands. Self-band (sample_tile == tile && sidx
                            // == band_idx) is naturally excluded by the
                            // `max < g_po` test (the gather sits at the head
                            // so our own band's max >= g_po).
                            if sband.max_paint_order < g_po {
                                dep_set
                                    .insert(BandKey::new(sample_tile, sidx as u32));
                            }
                        }
                    }
                }

                // Simpler & strictly stronger backstop: force EVERY
                // non-gather band strictly below this gather in paint order
                // to run before it, not just those whose tile lies in the
                // heuristic sample region. `compute_gather_sample_rect`
                // underestimates the shader's actual reach (displacement +
                // blur kernel can extend past the heuristic radius), leaving
                // tile-sized white holes where below-content tiles weren't
                // yet on Target when the backdrop snapshot was taken. This
                // pass closes every such gap at the cost of a few extra deps
                // — cheap at scheduling, zero extra runtime render work.
                //
                // `non_gather_bands` is sorted by max_paint_order, so the
                // eligible prefix (max_po < g_po) is found via partition
                // point and walked in O(cutoff).
                let cutoff = non_gather_bands.partition_point(|(po, _)| *po < g_po);
                for (_, dep_key) in &non_gather_bands[..cutoff] {
                    if *dep_key == key {
                        continue; // self — can't happen (self is gather-headed) but cheap to guard
                    }
                    dep_set.insert(*dep_key);
                }
            }
        }

        deps
    }

    /// For a set of tiles whose content just changed, return every tile that
    /// hosts a gather shape whose sample region overlaps any of those tiles.
    /// Callers must invalidate the cache of these tiles so the gather effect
    /// re-samples the updated backdrop.
    pub fn gather_tiles_affected_by(
        &self,
        dirty_tiles: &HashSet<Tile>,
        tree: ShapesPoolRef,
        scale: f32,
    ) -> HashSet<Tile> {
        let tile_size = tiles::get_tile_size(scale);
        let mut result: HashSet<Tile> = HashSet::default();
        if dirty_tiles.is_empty() {
            return result;
        }
        for (gather_tile, entries) in &self.grid {
            for entry in entries {
                if !entry.has_gather {
                    continue;
                }
                let Some(shape) = tree.get(&entry.id) else {
                    continue;
                };
                let sample_rect = self.compute_gather_sample_rect(shape, tree, scale);
                let st = tiles::get_tiles_for_rect(sample_rect, tile_size);
                let overlaps = dirty_tiles.iter().any(|t| {
                    t.x() >= st.x1() && t.x() <= st.x2() && t.y() >= st.y1() && t.y() <= st.y2()
                });
                if overlaps {
                    result.insert(*gather_tile);
                }
            }
        }
        result
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

    /// Generate every tile inside `rect` in roughly-concentric order (closest
    /// to the center first). Uses Chebyshev distance for ordering — cheaper
    /// than a literal spiral walk and, crucially, guaranteed to cover exactly
    /// the tiles in `rect` (no holes, no out-of-bounds tiles).
    fn generate_spiral(rect: &TileRect) -> Vec<Tile> {
        let columns = rect.width() + 1;
        let rows = rect.height() + 1;
        let total = columns * rows;
        if total <= 0 {
            return Vec::new();
        }

        let cx = rect.center_x();
        let cy = rect.center_y();

        let mut result: Vec<Tile> = Vec::with_capacity(total as usize);
        for ty in rect.y1()..=rect.y2() {
            for tx in rect.x1()..=rect.x2() {
                result.push(Tile::from(tx, ty));
            }
        }

        // Chebyshev distance keeps a "ring" ordering; tiebreak by a stable
        // clockwise angle so adjacent ring tiles stay locally coherent.
        result.sort_by(|a, b| {
            let da = (a.x() - cx).abs().max((a.y() - cy).abs());
            let db = (b.x() - cx).abs().max((b.y() - cy).abs());
            da.cmp(&db)
                .then_with(|| (a.y() - cy).cmp(&(b.y() - cy)))
                .then_with(|| (a.x() - cx).cmp(&(b.x() - cx)))
        });
        result
    }

    /// Topological sort over `BandKey` nodes using Kahn's algorithm. The
    /// band model is a strict DAG by construction (every edge points to a
    /// strictly-lower `max_paint_order`), so all nodes must emit. A
    /// `debug_assert` catches any regression.
    fn topological_sort(
        &self,
        spiral: &[Tile],
        deps: &HashMap<BandKey, HashSet<BandKey>>,
        tile_viewbox: &TileViewbox,
    ) -> (Vec<BandKey>, Vec<Tile>) {
        // Build spiral index for priority tiebreak.
        let spiral_index: HashMap<Tile, usize> = spiral
            .iter()
            .enumerate()
            .map(|(i, t)| (*t, i))
            .collect();

        // Tiles with bands emit one BandKey per band → topo-sorted via Kahn.
        // Tiles with no bands (viewport tiles whose shapes moved away and the
        // tile is now empty) get collected separately and emitted at the end
        // of the schedule as bare clearing pairs (`SetTileBand` +
        // `FinalizeBand{LastBg}`), without going through topo. They have no
        // deps and nothing depends on them, so order vs. productive bands is
        // visually irrelevant — keeping them out of topo cuts node count by
        // ~10× for typical viewports (e.g. 1920×1080 → ~50 productive vs.
        // ~600 total interest tiles).
        let mut all_keys: Vec<BandKey> = Vec::new();
        let mut empty_tiles: Vec<Tile> = Vec::new();
        for tile in spiral {
            match self.bands.get(tile) {
                Some(bands) if !bands.is_empty() => {
                    for idx in 0..bands.len() {
                        all_keys.push(BandKey::new(*tile, idx as u32));
                    }
                }
                _ => {
                    empty_tiles.push(*tile);
                }
            }
        }

        let key_set: HashSet<BandKey> = all_keys.iter().copied().collect();

        // In-degree + reverse adjacency restricted to keys that actually
        // exist (deps from/to tiles outside the spiral are ignored).
        let mut in_degree: HashMap<BandKey, usize> = HashMap::default();
        let mut reverse_deps: HashMap<BandKey, Vec<BandKey>> = HashMap::default();

        for (key, dep_set) in deps {
            if !key_set.contains(key) {
                continue;
            }
            let count = dep_set.iter().filter(|d| key_set.contains(d)).count();
            *in_degree.entry(*key).or_default() = count;

            for dep in dep_set {
                if key_set.contains(dep) {
                    reverse_deps.entry(*dep).or_default().push(*key);
                }
            }
        }

        // Seed the priority queue with bands that have no deps.
        let mut ready = BinaryHeap::new();
        for key in &all_keys {
            let degree = in_degree.get(key).copied().unwrap_or(0);
            if degree == 0 {
                let is_visible = tile_viewbox.visible_rect.contains(&key.tile);
                let group = if is_visible { 0 } else { 1 };
                ready.push(BandPriority {
                    key: *key,
                    group,
                    spiral_index: *spiral_index.get(&key.tile).unwrap_or(&usize::MAX),
                });
            }
        }

        let mut sorted = Vec::with_capacity(all_keys.len());

        while let Some(bp) = ready.pop() {
            sorted.push(bp.key);

            if let Some(dependents) = reverse_deps.get(&bp.key) {
                for dependent in dependents {
                    if let Some(degree) = in_degree.get_mut(dependent) {
                        *degree -= 1;
                        if *degree == 0 {
                            let is_visible =
                                tile_viewbox.visible_rect.contains(&dependent.tile);
                            let group = if is_visible { 0 } else { 1 };
                            ready.push(BandPriority {
                                key: *dependent,
                                group,
                                spiral_index: *spiral_index
                                    .get(&dependent.tile)
                                    .unwrap_or(&usize::MAX),
                            });
                        }
                    }
                }
            }
        }

        // The band model is a strict DAG — every node must emit. If this
        // ever trips, it's a correctness regression in compute_bands or
        // build_dependency_graph.
        debug_assert_eq!(
            sorted.len(),
            all_keys.len(),
            "band scheduler: dep graph had a cycle (emitted {}/{} bands)",
            sorted.len(),
            all_keys.len()
        );

        (sorted, empty_tiles)
    }

    /// Flatten the sorted band list into a Vec<RenderStep>. For each band,
    /// emits `SetTileBand` + depth-first shape traversal filtered to shapes
    /// in this band's shape set. Empty interest tiles (no productive bands)
    /// are emitted as a tail of bare `SetTileBand` + `FinalizeBand{LastBg}`
    /// pairs so their pixels get cleared on Target without spending topo
    /// nodes on them.
    fn build_schedule(
        &mut self,
        sorted_bands: &[BandKey],
        empty_tiles: &[Tile],
        tree: ShapesPoolRef,
        scale: f32,
    ) {
        self.schedule.clear();

        // Bail early if the tree has no root.
        if tree.get(&Uuid::nil()).is_none() {
            return;
        }

        // Per-tile cache of (tile_rect, visible-root-ids) for the productive
        // tiles in this schedule. Visible root-ids come from
        // `self.root_tiles` (built once per rebuild in `build_root_tiles`),
        // so this loop is O(productive_tiles) instead of
        // O(productive_tiles × root_children) — the previous formulation
        // dominated for scenes with thousands of root-level shapes.
        //
        // We clone the per-tile Uuid slice into the local cache so that the
        // emit loop below can hold a shared borrow on `visible_roots` while
        // calling `&mut self.emit_shape_steps_checked` — borrowing
        // `self.root_tiles` directly would conflict with the `&mut self`
        // call. Each clone is small (only root shapes touching that tile).
        let mut visible_roots: HashMap<Tile, (skia::Rect, Vec<Uuid>)> =
            HashMap::with_capacity_and_hasher(sorted_bands.len().min(256), Default::default());
        for key in sorted_bands {
            if visible_roots.contains_key(&key.tile) {
                continue;
            }
            let tile_rect = tiles::get_tile_rect(key.tile, scale);
            let visible: Vec<Uuid> = self
                .root_tiles
                .get(&key.tile)
                .cloned()
                .unwrap_or_default();
            visible_roots.insert(key.tile, (tile_rect, visible));
        }

        // Move `self.bands` out for the duration of the band loop so we can
        // hand `&[Uuid]` slices into `&mut self.emit_shape_steps_checked`
        // without the previous per-band `band.shapes.clone()` and per-band
        // `HashSet<Uuid>` allocation. At 14k bands that was ~14k clones +
        // ~14k hashset allocations per rebuild. Slice + linear `.contains`
        // is faster than HashSet for typical band sizes (<32 shapes).
        // `self.bands` is restored at the end of the loop.
        let bands_taken = std::mem::take(&mut self.bands);

        for key in sorted_bands {
            // Productive bands only — every key here has a matching Band.
            // The `_ => (None, true, true)` branch that used to handle
            // synthetic empty-tile BandKeys is unreachable now (empty tiles
            // are emitted in the tail below); keep a defensive fallback so a
            // future regression doesn't silently drop a tile clear.
            let (band_shape_slice, is_first, is_last): (&[Uuid], bool, bool) =
                match bands_taken.get(&key.tile) {
                    Some(bands) if !bands.is_empty() => {
                        let total = bands.len();
                        let idx = key.band_index as usize;
                        let band = bands.get(idx);
                        let is_last = idx + 1 == total;
                        let shapes: &[Uuid] = band.map(|b| b.shapes.as_slice()).unwrap_or(&[]);
                        (shapes, idx == 0, is_last)
                    }
                    _ => {
                        debug_assert!(
                            false,
                            "build_schedule: sorted_bands key {:?} missing a productive band",
                            key
                        );
                        (&[], true, true)
                    }
                };

            self.schedule.push(RenderStep::SetTileBand {
                tile: key.tile,
                band_index: key.band_index,
                is_first,
                is_last,
            });

            let band_has_shapes = !band_shape_slice.is_empty();

            if band_has_shapes {
                if let Some((tile_rect, visible)) = visible_roots.get(&key.tile) {
                    let tile_rect = *tile_rect;
                    for root_id in visible.iter() {
                        let root_id = *root_id;
                        self.emit_shape_steps_checked(
                            root_id,
                            tree,
                            &tile_rect,
                            scale,
                            band_shape_slice,
                            /*skip_self_check=*/ true,
                        );
                    }
                }
            }

            // Finalize kind is fully determined here (build time) — no
            // runtime guessing, no state that a yield can drop.
            let kind = if !is_last {
                FinalizeKind::Intermediate
            } else if band_has_shapes {
                FinalizeKind::LastContent
            } else {
                FinalizeKind::LastBg
            };
            self.schedule.push(RenderStep::FinalizeBand {
                tile: key.tile,
                kind,
            });
        }

        // Restore `self.bands` so downstream code (e.g. `run_schedule`'s
        // `SetTileBand` cached-tile fast path) can read the band layout.
        self.bands = bands_taken;

        // Empty-tile clearing tail. Tiles inside the interest rect that
        // carry no productive bands still need their Target pixels cleared,
        // otherwise stale content from a previous frame remains visible
        // when shapes move away. Emit a bare `SetTileBand` +
        // `FinalizeBand{LastBg}` pair per empty tile, in spiral order. They
        // have no shape content, no deps, and nothing depends on them — so
        // batching after productive bands is correct (tile rects are
        // disjoint; productive painting on tile T can't be undone by a
        // later clear of tile T' ≠ T).
        for tile in empty_tiles {
            self.schedule.push(RenderStep::SetTileBand {
                tile: *tile,
                band_index: 0,
                is_first: true,
                is_last: true,
            });
            self.schedule.push(RenderStep::FinalizeBand {
                tile: *tile,
                kind: FinalizeKind::LastBg,
            });
        }

        // Tail: release every per-frame cache the scheduler emitted a
        // `BuildCache` for this rebuild. Replaces the legacy global
        // end-of-frame clears in `run_schedule`. Scheduler-owned end-to-end:
        // build → consume → free.
        if !self.emitted_caches.is_empty() {
            // Sorted for determinism (HashSet iteration order isn't stable);
            // also makes test golden-output diffs stable.
            let mut caches: Vec<CacheKind> = self.emitted_caches.iter().copied().collect();
            caches.sort_by_key(|k| match k {
                CacheKind::Scatter(id) => (0u8, id.as_u128()),
                CacheKind::Gather(id) => (1u8, id.as_u128()),
                CacheKind::LocalBlur(id) => (2u8, id.as_u128()),
            });
            for kind in caches {
                self.schedule.push(RenderStep::FreeCache(kind));
            }
        }

        // V3 P2: for every scoped frame F, the schedule now carries one
        // `PopScope(F)` per tile that touched F (one per band emission).
        // The runtime needs to know which PopScope is the LAST so it can
        // composite `scope_F` onto its parent and free the scope. Walk
        // the schedule backward, track first-seen shape ids, and set
        // `is_final_tile = true` on those. Earlier PopScopes for the
        // same shape stay `false` and just push that tile's slice into
        // `scope_F` without freeing.
        self.mark_final_pop_scopes();
    }

    /// Backward pass over `self.schedule` that flips `is_final_tile` to
    /// true on the LAST `PopScope` per shape id. O(N) over schedule
    /// length with one `HashSet` lookup per `PopScope` step encountered.
    fn mark_final_pop_scopes(&mut self) {
        let mut seen: HashSet<Uuid> = HashSet::default();
        for step in self.schedule.iter_mut().rev() {
            if let RenderStep::PopScope { shape, is_final_tile } = step {
                if seen.insert(*shape) {
                    *is_final_tile = true;
                }
            }
        }
    }

    /// Emit Enter/Render/Exit steps for a shape and its descendants, filtered
    /// to shapes in `band_shapes`. Returns true if at least one step was
    /// emitted for this subtree (used by callers to skip empty Enter/Exit
    /// brackets).
    ///
    /// `skip_self_check` lets the root-level caller (`build_schedule`) avoid
    /// re-doing the tile-intersection test it already performed when
    /// populating the per-tile `visible_roots` cache. Recursed children
    /// always get the full check since their selrect/extrect is independent
    /// of the parent's.
    fn emit_shape_steps_checked(
        &mut self,
        shape_id: Uuid,
        tree: ShapesPoolRef,
        tile_rect: &skia::Rect,
        scale: f32,
        band_shapes: &[Uuid],
        skip_self_check: bool,
    ) -> bool {
        let Some(shape) = tree.get(&shape_id) else {
            return false;
        };

        if shape.hidden {
            return false;
        }

        // perf-trace: log every shape the scheduler walks (deduped on
        // shape_id + key predicates). Catches shapes that never enter
        // `emit_cache_build_for_shape` because the leaf-vs-container
        // branch went the wrong way.
        #[cfg(feature = "perf-trace")]
        crate::perf_trace::log_shape_walk(shape_id, shape);

        // Visibility check — is the shape in or near this tile?
        // Use `extrect` (not `selrect`) so scatter-effect shapes, whose
        // output kernel extends past the shape's natural outline, still
        // emit on neighbour tiles. `extrect` is cached on the shape.
        //
        // The root-level caller (`build_schedule`) pre-filters via its
        // `visible_roots` cache and passes `skip_self_check = true` so we
        // don't redo this intersection test. Recursed children always run
        // the full check since their extrect is independent of the
        // parent's.
        if !skip_self_check {
            let extrect = shape.extrect(tree, scale);
            if !extrect.intersects(*tile_rect) {
                return false;
            }
        }

        // Scatter container: emit a single PaintBody step and do NOT recurse,
        // so descendants aren't also blitted independently on top of the
        // warped output. The `RenderStep::PaintBody` handler dispatches to
        // the subtree scatter renderer when the shape is recursive.
        //
        // Masked groups are excluded — their Enter/Exit save_layer plumbing
        // is required for correct masking and the subtree path does not
        // reproduce it. Such groups fall through to the normal recursive
        // emission (textures still silently skipped as before — pre-existing
        // limitation).
        let is_scatter = shape
            .texture
            .as_ref()
            .is_some_and(|t| !t.hidden && t.radius > 0.0);
        let is_masked_group = matches!(&shape.shape_type, Type::Group(g) if g.masked);
        if shape.is_recursive() && is_scatter && !is_masked_group {
            let has_band_content = band_shapes.contains(&shape_id)
                || subtree_has_band_shape(shape, tree, band_shapes);
            if has_band_content {
                self.emit_cache_build_for_shape(shape_id, shape);
                push_paint_steps(&mut self.schedule, shape);
                return true;
            }
            return false;
        }

        if shape.is_recursive() {
            // Phase E — masked group two-pass composition. Outer
            // SrcOver layer wraps content + mask. Inner DstIn layer
            // wraps the mask shape. On EndLayer the inner DstIn pops,
            // clipping the outer layer's content to mask alpha; on
            // the outer EndLayer the masked result composites onto
            // target.
            if is_masked_group {
                return self.emit_masked_group_steps(
                    shape_id,
                    shape,
                    tree,
                    tile_rect,
                    scale,
                    band_shapes,
                );
            }

            // Container: speculatively push BeginLayer (if applicable) +
            // Enter, recurse, then drop the speculative steps if no
            // child emitted anything for this band.
            //
            // V2c.2 ordering rationale: BeginLayer fires BEFORE Enter so
            // the container's drop_shadows / body draw / children all
            // composite inside the layer. Predicate excludes shapes
            // with bg_blur / glass; for those, Enter still mutates
            // Current pre-layer in legacy form, so the externalized
            // layer would arrive too late. Same reasoning as the
            // legacy `render_background_blur` / `render_glass` calls
            // running before `render_shape_enter`.
            let speculative_pos = self.schedule.len();
            // V3 scope: wraps the entire container emission — Push/PopScope
            // brackets `BuildCache(Gather)`, `PaintGather`, `BeginLayer`,
            // `Enter`, children, `Exit`, `EndLayer`. Per-tile emission
            // means each tile that touches F gets its own pair; the
            // runtime treats subsequent PushScopes for the same F as
            // re-entry (no re-allocation). `is_final_tile` is resolved
            // post-topo-sort by `mark_final_pop_scopes`.
            let subtree_gather = self.has_gather_in_subtree(shape_id);
            let scoped = needs_scope(shape, subtree_gather, tree);
            let has_self_gather = Self::shape_has_gather(shape);
            // P6: container gather is hoisted out of `Enter` only when the
            // frame is scoped — otherwise the legacy inline path runs
            // (no behavior change for non-scoped gather containers).
            let scoped_gather = scoped && has_self_gather;
            // Track caches emitted in this speculative window so we can
            // roll back `self.emitted_caches` on truncate. Without this,
            // subsequent bands of the same shape would skip BuildCache
            // emission (HashSet says "already emitted") even though the
            // truncate dropped the schedule entry.
            let mut speculative_caches: Vec<CacheKind> = Vec::new();
            // P6: BuildCache(Gather(F)) emitted BEFORE PushScope so the
            // gather samples the PARENT scope's backdrop (anc + scope +
            // Current), not F's own still-empty scope_F.
            if scoped_gather {
                speculative_caches
                    .extend(self.emit_cache_build_for_shape(shape_id, shape));
            }
            if scoped {
                self.schedule.push(RenderStep::PushScope {
                    shape: shape_id,
                    has_ancestor_snapshot: subtree_gather,
                });
            }
            // P6: PaintGather for the container fires INSIDE the scope
            // (so its refraction lands on Current, which PopScope mirrors
            // into scope_F). Matched by `has_external_gather=true` on the
            // Enter step so the dispatcher skips inline bg_blur/glass.
            if scoped_gather {
                let (gather_effects, _body) = paint_plan_for_shape(shape);
                if !gather_effects.is_empty() {
                    self.schedule.push(RenderStep::PaintGather {
                        shape: shape_id,
                        output: SurfaceId::Current,
                        effects: gather_effects,
                    });
                }
            }
            // Layer-paint predicate: scoped frames use the lifted version
            // (gather exclusion removed because PaintGather already ran
            // outside the layer). Non-scoped frames use the legacy
            // predicate.
            let layer_paint = if scoped {
                layer_paint_for_scoped_shape(shape)
            } else {
                layer_paint_for_shape(shape)
            };
            let has_external_layer = layer_paint.is_some();
            if let Some(p) = layer_paint {
                self.schedule.push(RenderStep::BeginLayer {
                    shape: shape_id,
                    paint: p,
                });
            }
            self.schedule.push(RenderStep::Enter {
                shape: shape_id,
                has_external_layer,
                has_external_gather: scoped_gather,
            });

            let mut children = shape.children_ids(false);
            children.reverse();
            let mut any_child_emitted = false;
            for child_id in &children {
                if self.emit_shape_steps_checked(
                    *child_id,
                    tree,
                    tile_rect,
                    scale,
                    band_shapes,
                    /*skip_self_check=*/ false,
                ) {
                    any_child_emitted = true;
                }
            }

            // The container itself is a shape in the band's shape list if and
            // only if it's a recursive shape with a paint_order matching the
            // barrier split. But we don't emit Render for recursive shapes,
            // so container membership in `band_shapes` just means "keep its
            // Enter/Exit brackets around any contained band content".
            let self_in_band = band_shapes.contains(&shape_id);

            if any_child_emitted || self_in_band {
                self.schedule.push(RenderStep::Exit {
                    shape: shape_id,
                    has_external_layer,
                });
                if has_external_layer {
                    self.schedule.push(RenderStep::EndLayer { shape: shape_id });
                }
                if scoped {
                    self.schedule.push(RenderStep::PopScope {
                        shape: shape_id,
                        is_final_tile: false,
                    });
                }
                true
            } else {
                // Drop speculative steps (BuildCache, PushScope,
                // PaintGather, BeginLayer, Enter). The schedule is
                // truncated to `speculative_pos`, AND `emitted_caches` is
                // rolled back so subsequent bands of F still emit
                // BuildCache properly.
                self.schedule.truncate(speculative_pos);
                for kind in speculative_caches {
                    self.emitted_caches.remove(&kind);
                }
                false
            }
        } else if band_shapes.contains(&shape_id) {
            // Leaf path. BuildCache emits *before* BeginLayer because
            // caches build on Filter / scratch surfaces unrelated to
            // Current's save_layer state, and we want Current's stack
            // depth at Paint time to match the BeginLayer that
            // immediately precedes it.
            self.emit_cache_build_for_shape(shape_id, shape);
            let layer_paint = layer_paint_for_shape(shape);
            // V3: PaintGather runs BEFORE BeginLayer so the gather samples
            // the un-isolated backdrop; BeginLayer/EndLayer brackets only
            // the body. paint_plan_for_shape splits effects so this works
            // cleanly. For shapes that don't qualify for an external layer
            // (the gather/bg_blur shapes today), gather+body still run in
            // order; the inline save_layer in `render_shape` handles wrap.
            let (gather, body) = paint_plan_for_shape(shape);
            if !gather.is_empty() {
                self.schedule.push(RenderStep::PaintGather {
                    shape: shape_id,
                    output: SurfaceId::Current,
                    effects: gather,
                });
            }
            if let Some(p) = layer_paint {
                self.schedule.push(RenderStep::BeginLayer {
                    shape: shape_id,
                    paint: p,
                });
            }
            self.schedule.push(RenderStep::PaintBody {
                shape: shape_id,
                output: SurfaceId::Current,
                effects: body,
            });
            if layer_paint.is_some() {
                self.schedule.push(RenderStep::EndLayer { shape: shape_id });
            }
            true
        } else {
            false
        }
    }

    /// Phase E — emit masked-group schedule:
    ///
    /// ```text
    ///   BeginLayer(SrcOver)         [outer]
    ///   Enter(has_external_layer=true)
    ///     Paint(content children, in z-order, model[1..N])
    ///     BeginLayer(DstIn)         [inner]
    ///       Paint(mask child, model[0])
    ///     EndLayer                  [inner pops, mask DstIn-clips outer content]
    ///   Exit
    ///   EndLayer                    [outer pops, masked result onto target]
    /// ```
    ///
    /// Penpot data model: `children.first()` is the mask shape;
    /// `children[1..]` are the content. After `children.reverse()` for
    /// the band-iteration convention used by non-masked containers, the
    /// mask lands LAST — same emission ordering as the existing path,
    /// but wrapped in the inner DstIn layer.
    ///
    /// Returns true if anything was emitted into the band.
    fn emit_masked_group_steps(
        &mut self,
        shape_id: Uuid,
        shape: &Shape,
        tree: ShapesPoolRef,
        tile_rect: &skia::Rect,
        scale: f32,
        band_shapes: &[Uuid],
    ) -> bool {
        let speculative_pos = self.schedule.len();

        let outer_paint = LayerPaint {
            opacity: 1.0,
            blend_mode: skia::BlendMode::SrcOver,
            frame_blur_sigma_dev: None,
        };
        let inner_paint = LayerPaint {
            opacity: 1.0,
            blend_mode: skia::BlendMode::DstIn,
            frame_blur_sigma_dev: None,
        };

        self.schedule.push(RenderStep::BeginLayer {
            shape: shape_id,
            paint: outer_paint,
        });
        self.schedule.push(RenderStep::Enter {
            shape: shape_id,
            has_external_layer: true,
            has_external_gather: false,
        });

        // Mask child = `Shape::mask_id()` = `children.first()`.
        // Content = `children_ids(false)` which for masked groups
        // already EXCLUDES the mask child (see `Shape::children_ids`
        // — for masked groups it does `rev().take(len-1)`, dropping
        // the last-after-reverse = `children[0]` = the mask).
        let Some(&mask_id) = shape.mask_id() else {
            // empty masked group — drop everything
            self.schedule.truncate(speculative_pos);
            return false;
        };
        let content_ids = shape.children_ids(false);

        // `children_ids(false)` already returns bottom-first
        // (it does `rev()` internally). Iterate in returned order;
        // band-tile dispatch composites in schedule order so visual
        // stacking is whatever the model says.
        let mut any_emitted = false;
        for child_id in &content_ids {
            if self.emit_shape_steps_checked(
                *child_id,
                tree,
                tile_rect,
                scale,
                band_shapes,
                false,
            ) {
                any_emitted = true;
            }
        }

        // Inner DstIn layer for mask child. If the mask shape has no
        // band content (out of view / hidden), drop the inner layer
        // wrapping (a DstIn layer with no Src would clear everything).
        let inner_layer_pos = self.schedule.len();
        self.schedule.push(RenderStep::BeginLayer {
            shape: shape_id,
            paint: inner_paint,
        });
        let mask_emitted =
            self.emit_shape_steps_checked(mask_id, tree, tile_rect, scale, band_shapes, false);
        if mask_emitted {
            self.schedule.push(RenderStep::EndLayer { shape: shape_id });
        } else {
            self.schedule.truncate(inner_layer_pos);
        }

        let self_in_band = band_shapes.contains(&shape_id);
        if any_emitted || mask_emitted || self_in_band {
            self.schedule.push(RenderStep::Exit {
                shape: shape_id,
                has_external_layer: true,
            });
            self.schedule.push(RenderStep::EndLayer { shape: shape_id });
            true
        } else {
            self.schedule.truncate(speculative_pos);
            false
        }
    }

    /// If `shape` qualifies for one or more scheduler-owned caches, emit a
    /// `BuildCache` step the first time we see this shape this frame.
    /// Idempotent via `emitted_caches`.
    ///
    /// Order matters for combined scatter+glass shapes: the gather backdrop
    /// must be snapshotted before the scatter cache is built, because
    /// `BuildCache(Scatter)` reads the cached backdrop image and feeds it
    /// into the displacement pass.
    /// Emits BuildCache step(s) for `shape`. Returns the list of kinds
    /// freshly inserted into `self.emitted_caches` so a speculative
    /// caller (e.g. container emit that may later truncate) can roll
    /// back the set. Callers that always commit can ignore the return.
    fn emit_cache_build_for_shape(
        &mut self,
        shape_id: Uuid,
        shape: &Shape,
    ) -> Vec<CacheKind> {
        let has_scatter = shape
            .texture
            .as_ref()
            .is_some_and(|t| !t.hidden && t.radius > 0.0);
        // Phase 7b: lifted to all gather variants. `has_gather` covers
        // glass + bg-blur, root-level + nested. Snapshots are
        // bbox-bounded (`selrect ± 3σ`) via
        // `Surface::image_snapshot_with_bounds`, so memory pressure
        // stays flat even for iso_glass-style scenes (100 root
        // gathers × ~370 KB ≈ 37 MB, comfortably inside the 96 MB
        // bytes cap). Scheduler band-barrier already separates
        // gather peers correctly — see `compute_bands`.
        let has_gather = Self::shape_has_gather(shape);
        let has_local_blur =
            crate::render::local::shape_qualifies_for_layer_blur_cache(shape);

        // perf-trace: log per-shape emit decision once per change so
        // the agent can see which BuildCache steps the scheduler is
        // about to emit. Dedupe internally by `(shape_id, predicate
        // tuple)`.
        #[cfg(feature = "perf-trace")]
        crate::perf_trace::log_emit_cache_decision(
            shape_id,
            shape,
            has_scatter,
            has_gather,
            has_local_blur,
        );

        let mut emitted: Vec<CacheKind> = Vec::new();

        // Gather first — its snapshot is an input to the scatter pass for
        // combined scatter+glass shapes.
        if has_gather {
            let kind = CacheKind::Gather(shape_id);
            if self.emitted_caches.insert(kind) {
                self.schedule.push(RenderStep::BuildCache(kind));
                emitted.push(kind);
            }
        }

        if has_scatter {
            let kind = CacheKind::Scatter(shape_id);
            if self.emitted_caches.insert(kind) {
                self.schedule.push(RenderStep::BuildCache(kind));
                emitted.push(kind);
            }
        }

        // V2c.1 — leaf layer-blur cache. Emit AFTER gather/scatter so
        // a (rare) shape carrying both gather+layer-blur sees the
        // gather backdrop already populated when its layer-blur
        // build runs. In practice `shape_qualifies_for_layer_blur_cache`
        // excludes shapes with gather effects, so this ordering is
        // belt-and-braces.
        if has_local_blur {
            let kind = CacheKind::LocalBlur(shape_id);
            if self.emitted_caches.insert(kind) {
                self.schedule.push(RenderStep::BuildCache(kind));
                emitted.push(kind);
            }
        }

        emitted
    }
}

/// True if any descendant of `shape` (at any depth) appears in `band_shapes`.
/// Used by the scatter-container emit guard to decide whether this band
/// needs a `Render(container)` step.
fn subtree_has_band_shape(
    shape: &Shape,
    tree: ShapesPoolRef,
    band_shapes: &[Uuid],
) -> bool {
    for child_id in shape.children_ids(false) {
        if band_shapes.contains(&child_id) {
            return true;
        }
        if let Some(child) = tree.get(&child_id) {
            if subtree_has_band_shape(child, tree, band_shapes) {
                return true;
            }
        }
    }
    false
}

// ── RenderState replacement methods ─────────────────────────────────────
//
// These have the same public signatures as the methods gated with
// #[cfg(not(feature = "tile-scheduler"))] in render.rs.
// state.rs calls them without knowing which implementation runs.

#[cfg(feature = "tile-scheduler")]
impl RenderState {
    /// V3 P3 — `PushScope(F)` dispatch. On the FIRST per-tile `PushScope`
    /// for a given `shape`, allocate `scope_F` (frame-bbox-sized in
    /// world coords) and record it in `scope_allocations`. On every
    /// `PushScope` (first or re-entry from a later tile): snapshot
    /// `Current`'s content region into `parent_stash`, clear `Current`,
    /// and push to `open_scopes` so the paired `PopScope` can restore.
    /// P5 extension: when `has_ancestor_snapshot=true`, compose
    /// `anc_F = Target ⊕ <enclosing scopes>` ONCE at the moment F enters
    /// and store the snapshot. Every gather inside F reuses it.
    pub(crate) fn handle_push_scope(
        &mut self,
        shape: Uuid,
        tree: ShapesPoolRef,
        has_ancestor_snapshot: bool,
    ) -> Result<()> {
        // Lazy alloc: first PushScope for this shape's band allocates.
        if !self.scope_allocations.contains_key(&shape) {
            let Some(element) = tree.get(&shape) else {
                return Ok(());
            };
            let scale = self.get_scale();
            let extrect = element.extrect(tree, scale);
            // Clip to viewbox area in world coords — no point allocating
            // scope coverage outside what could ever be visible.
            let viewbox = self.viewbox.area;
            let world_bbox = skia::Rect::from_ltrb(
                extrect.left.max(viewbox.left),
                extrect.top.max(viewbox.top),
                extrect.right.min(viewbox.right),
                extrect.bottom.min(viewbox.bottom),
            );
            if world_bbox.is_empty() {
                // Scope offscreen — nothing to do this frame. Don't
                // allocate; subsequent `PopScope` checks for the entry
                // and no-ops when absent.
                return Ok(());
            }
            let devpx_w = (world_bbox.width() * scale).ceil() as i32;
            let devpx_h = (world_bbox.height() * scale).ceil() as i32;
            if devpx_w <= 0 || devpx_h <= 0 {
                return Ok(());
            }
            let label = format!("scope_{}", shape);
            let scope_surface = self
                .gpu_state
                .create_surface_with_dimensions(label, devpx_w, devpx_h)?;
            self.scope_allocations.insert(
                shape,
                ScopeAllocation {
                    scope_surface,
                    ancestor_snapshot: None,
                    world_origin: skia::Point::new(world_bbox.left, world_bbox.top),
                    world_size: skia::Size::new(world_bbox.width(), world_bbox.height()),
                },
            );
        }

        // Stash + clear Current for the body of this scope. The matching
        // PopScope reads `parent_stash` and merges with this tile's F
        // content. `parent_stash` covers Current's content region only
        // (margins inset) — matches what `restore_current_from_scope`
        // expects.
        let parent_stash = self
            .surfaces
            .snapshot_current_content()
            .unwrap_or_else(|| {
                // Empty content region (extreme cases) — fall back to
                // a full-surface snapshot, which is correct semantics
                // (anything outside content is bg color anyway).
                self.surfaces.snapshot(SurfaceId::Current)
            });
        self.surfaces.clear_current(self.background_color);

        // P5: build `anc_F` once on first PushScope for this band.
        // ancestor_snapshot is None on the entry built in P3; subsequent
        // re-entries for the same shape's later tiles find ancestor_snapshot
        // already populated and skip. The compose is "Target ⊕ enclosing
        // scopes" — flushed via `flush_and_submit` first so Target reflects
        // all pre-F dependency tiles' contributions.
        if has_ancestor_snapshot {
            let needs_anc = self
                .scope_allocations
                .get(&shape)
                .map(|a| a.ancestor_snapshot.is_none())
                .unwrap_or(false);
            if needs_anc {
                self.compose_ancestor_snapshot(shape)?;
            }
        }

        self.open_scopes.push(OpenScope {
            shape_id: shape,
            parent_stash,
        });
        Ok(())
    }

    /// V3 P5 — allocate a temporary surface sized to F's `world_bbox`,
    /// draw `Target` onto it, then every currently-open enclosing scope's
    /// `scope_surface` on top, in order. Snapshot the result and store
    /// in `scope_allocations[F].ancestor_snapshot`. Reused by every
    /// `BuildCache(Gather)` inside F.
    ///
    /// The math: `temp_surface`'s pixel (0,0) corresponds to world
    /// `alloc.world_origin`. To place `Target` (whose pixel (0,0) is
    /// `viewbox.origin`), draw at `(viewbox.origin - world_origin) * scale`.
    /// Same offset shape for each enclosing scope.
    fn compose_ancestor_snapshot(&mut self, shape: Uuid) -> Result<()> {
        let (world_origin, world_size_w, world_size_h) = {
            let Some(alloc) = self.scope_allocations.get(&shape) else {
                return Ok(());
            };
            (
                alloc.world_origin,
                alloc.world_size.width,
                alloc.world_size.height,
            )
        };
        let scale = self.get_scale();
        let devpx_w = (world_size_w * scale).ceil() as i32;
        let devpx_h = (world_size_h * scale).ceil() as i32;
        if devpx_w <= 0 || devpx_h <= 0 {
            return Ok(());
        }
        // Flush GPU first so Target reflects all dependency-tile writes
        // that the topo-sort scheduled before F. Without this, the
        // ancestor snapshot can miss content from sibling tiles still
        // pending submission.
        self.flush_and_submit();

        // Allocate temp surface for composition. Discarded after snapshot.
        let label = format!("anc_compose_{}", shape);
        let mut temp = self
            .gpu_state
            .create_surface_with_dimensions(label, devpx_w, devpx_h)?;
        {
            let canvas = temp.canvas();
            canvas.clear(self.background_color);

            // Draw Target. Image origin in temp's devpx:
            // (viewbox - world_origin) * scale.
            let target_img = self.surfaces.snapshot(SurfaceId::Target);
            let tx = (self.viewbox.area.left - world_origin.x) * scale;
            let ty = (self.viewbox.area.top - world_origin.y) * scale;
            canvas.draw_image(
                &target_img,
                skia::Point::new(tx, ty),
                Some(&skia::Paint::default()),
            );

            // Draw every enclosing open scope (bottom-up: outermost
            // first, innermost last). open_scopes is bottom-first
            // already (we push on Push, top is innermost).
            for open in self.open_scopes.iter() {
                let Some(enc) = self.scope_allocations.get_mut(&open.shape_id) else {
                    continue;
                };
                let enc_img = enc.scope_surface.image_snapshot();
                let ex = (enc.world_origin.x - world_origin.x) * scale;
                let ey = (enc.world_origin.y - world_origin.y) * scale;
                canvas.draw_image(
                    &enc_img,
                    skia::Point::new(ex, ey),
                    Some(&skia::Paint::default()),
                );
            }
        }
        let anc_image = temp.image_snapshot();
        // `temp` drops here — GPU resource recycled.
        if let Some(alloc) = self.scope_allocations.get_mut(&shape) {
            alloc.ancestor_snapshot = Some(anc_image);
        }
        Ok(())
    }

    /// V3 P3 — `PopScope(F)` dispatch. Pops the matching `OpenScope`,
    /// captures F's per-tile content from `Current`, composites it onto
    /// `scope_F` (the persistent surface), then restores `Current` to
    /// `parent_stash ⊕ F_tile_content` so the parent's tile draw
    /// continues with F visible. On `is_final_tile`, drops the scope
    /// allocation (frees `scope_surface` + `anc_F`).
    pub(crate) fn handle_pop_scope(
        &mut self,
        shape: Uuid,
        is_final_tile: bool,
    ) -> Result<()> {
        let Some(open) = self.open_scopes.pop() else {
            // Defensive: schedule emitted PopScope without a matching
            // PushScope (or PushScope was skipped via offscreen bail).
            return Ok(());
        };
        debug_assert_eq!(
            open.shape_id, shape,
            "PopScope/PushScope mismatch: expected {:?}, got {:?}",
            open.shape_id, shape
        );

        let tile_content = self.surfaces.snapshot_current_content();

        // Capture `scale` and `render_area` BEFORE the `get_mut` borrow
        // so we don't double-borrow `self`.
        let scale = self.get_scale();
        let render_area_left = self.render_area.left;
        let render_area_top = self.render_area.top;

        // Composite F's tile slice onto scope_F.
        if let (Some(tile_img), Some(alloc)) =
            (tile_content.as_ref(), self.scope_allocations.get_mut(&shape))
        {
            // The content-region snapshot's pixel (0,0) corresponds to
            // world point `render_area.{left, top}` (margins already
            // inset by `snapshot_current_content`).
            let offset_x = (render_area_left - alloc.world_origin.x) * scale;
            let offset_y = (render_area_top - alloc.world_origin.y) * scale;
            alloc.scope_surface.canvas().draw_image(
                tile_img,
                skia::Point::new(offset_x, offset_y),
                Some(&skia::Paint::default()),
            );
        }

        // Restore Current = parent_stash ⊕ F's tile content. The parent
        // continues drawing into a Current that sees F's contribution.
        self.surfaces.restore_current_from_scope(
            &open.parent_stash,
            tile_content.as_ref(),
            self.background_color,
        );

        // Final tile in the band drops the persistent scope allocation.
        // In P3 nothing reads `scope_surface` after this point (P4 wires
        // gather sampling); just free the surface. The cross-tile
        // composite onto a parent scope / Target is NOT needed yet
        // because Current's merge above already carries F's content
        // through normal `FinalizeBand`.
        if is_final_tile {
            self.scope_allocations.remove(&shape);
        }
        Ok(())
    }

    /// V3 P4 — build a gather backdrop snapshot using the active scope
    /// stack instead of `Target`. Composes `anc_F ⊕ scope_F ⊕ Current`
    /// onto a temp surface sized to the gather's `extent_world` and
    /// inserts the snapshot into the per-shape backdrop cache.
    ///
    /// - `anc_F` (pre-baked at PushScope): static stack of `Target ⊕
    ///   <enclosing scopes>` covering everything beneath F's content.
    /// - `scope_F`: F's content from previously-finalized tiles in this
    ///   band (mirror-written by `handle_pop_scope`).
    /// - `Current`: F's mid-tile, in-progress content for THIS tile,
    ///   including preceding sibling gathers that already painted
    ///   refraction into `Current`.
    ///
    /// Result is the same image format the existing `Target`-based path
    /// produces (bbox-bounded, world-origin tagged). The `PaintGather`
    /// dispatcher consumes it identically — no changes downstream.
    fn build_gather_backdrop_scoped(
        &mut self,
        id: Uuid,
        element: &Shape,
        gather: &crate::render::gather::GatherKind<'_>,
    ) -> Result<()> {
        // Top-of-stack scope is the innermost ancestor containing this
        // gather. Its `ancestor_snapshot` + `scope_surface` together
        // give us everything below the gather (other than this tile's
        // mid-content, which we pull from `Current`).
        let Some(open) = self.open_scopes.last() else {
            return Ok(());
        };
        let scope_shape_id = open.shape_id;

        let scale = self.get_scale();
        let extent_world = gather.extent_world(element);
        // Clip against viewbox so an offscreen gather doesn't allocate
        // a giant scratch.
        let viewbox = self.viewbox.area;
        let clipped = skia::Rect::from_ltrb(
            extent_world.left.max(viewbox.left),
            extent_world.top.max(viewbox.top),
            extent_world.right.min(viewbox.right),
            extent_world.bottom.min(viewbox.bottom),
        );
        if clipped.is_empty() {
            return Ok(());
        }
        let devpx_w = (clipped.width() * scale).ceil() as i32;
        let devpx_h = (clipped.height() * scale).ceil() as i32;
        if devpx_w <= 0 || devpx_h <= 0 {
            return Ok(());
        }

        // Pull the three source surfaces' state. Snapshots are GPU-light
        // (texture share); the surface remains live for further writes.
        let (anc_image, scope_image, scope_world_origin) = {
            let Some(alloc) = self.scope_allocations.get_mut(&scope_shape_id) else {
                return Ok(());
            };
            let anc_image = alloc.ancestor_snapshot.clone();
            let scope_image = alloc.scope_surface.image_snapshot();
            let scope_world_origin = alloc.world_origin;
            (anc_image, scope_image, scope_world_origin)
        };
        let current_image = self.surfaces.snapshot_current_content();
        let render_area_left = self.render_area.left;
        let render_area_top = self.render_area.top;
        let bg = self.background_color;

        // Allocate a scratch surface sized to the gather's clipped
        // extent. Composition target. Snapshotted and discarded after.
        let label = format!("gather_snap_{}", id);
        let mut snap = self
            .gpu_state
            .create_surface_with_dimensions(label, devpx_w, devpx_h)?;
        {
            let canvas = snap.canvas();
            canvas.clear(bg);

            // anc_F covers `Target ⊕ enclosing scopes`. Its world
            // origin equals `scope_world_origin`. Snap's world origin
            // is `clipped.{left, top}`. Offset on snap:
            //   (scope_world_origin - clipped.origin) * scale.
            if let Some(anc) = anc_image.as_ref() {
                let ox = (scope_world_origin.x - clipped.left) * scale;
                let oy = (scope_world_origin.y - clipped.top) * scale;
                canvas.draw_image(
                    anc,
                    skia::Point::new(ox, oy),
                    Some(&skia::Paint::default()),
                );
            }

            // scope_F covers F's prior-tile content; same origin shape.
            {
                let ox = (scope_world_origin.x - clipped.left) * scale;
                let oy = (scope_world_origin.y - clipped.top) * scale;
                canvas.draw_image(
                    &scope_image,
                    skia::Point::new(ox, oy),
                    Some(&skia::Paint::default()),
                );
            }

            // Current's content region (margins inset) covers this
            // tile's mid-flight F content. Its pixel (0,0) equals
            // world `render_area.{left, top}`.
            if let Some(cur) = current_image.as_ref() {
                let ox = (render_area_left - clipped.left) * scale;
                let oy = (render_area_top - clipped.top) * scale;
                canvas.draw_image(
                    cur,
                    skia::Point::new(ox, oy),
                    Some(&skia::Paint::default()),
                );
            }
        }
        let backdrop = snap.image_snapshot();
        // `snap` drops, GPU resource recycled.

        self.surfaces.insert_glass_backdrop_with_world_origin(
            id,
            backdrop,
            skia::Point::new(clipped.left, clipped.top),
        );
        Ok(())
    }

    /// V2b per-effect dispatcher. Walks the action's effect list in order,
    /// routing each `EffectKey` to its existing per-effect renderer. The
    /// scheduler decides _what_ to render and _in what order_; this method
    /// is a flat dispatcher with no implicit ordering knowledge of its own.
    ///
    /// `input` is unused in V2b and reserved for V2c (inner-shadow `SrcATop`
    /// silhouette clipping via `Surface(Fills)` input, gather backdrop via
    /// `Cache(Gather(id))`).
    pub(crate) fn scheduler_render_effects(
        &mut self,
        element: &Shape,
        tree: ShapesPoolRef,
        output: SurfaceId,
        effects: &[EffectKey],
    ) -> Result<()> {
        let id = element.id;
        let scale = self.get_scale();

        for effect in effects {
            // Per-effect timing. Guard drops on continue/?/end.
            let _dbg_tag: &'static str = match effect {
                EffectKey::Gather(GatherFx::BackgroundBlur) => "fx_BackgroundBlur",
                EffectKey::Gather(GatherFx::Glass) => "fx_Glass",
                EffectKey::Scatter(ScatterFx::DropShadows) => "fx_DropShadows",
                EffectKey::Local(LocalFx::ShapeBody) => "fx_ShapeBody",
                EffectKey::Local(LocalFx::LayerBlur) => "fx_LayerBlur",
                EffectKey::Scatter(ScatterFx::Blit) => "fx_ScatterBlit",
            };
            crate::perf_guard!(_dbg_tag);
            match effect {
                EffectKey::Gather(_) => {
                    // Phase 7b: unified gather paint. The matching
                    // `BuildCache(Gather)` step earlier in the
                    // schedule populated the per-frame backdrop
                    // cache (image + origin in source devpx). Pull
                    // both, route through `GatherKind`, render.
                    let Some(gather) =
                        crate::render::gather::GatherKind::from_shape(element)
                    else {
                        continue;
                    };
                    // Sanity: gather variant the schedule emitted
                    // for must match the one we'd pick now. Mismatch
                    // is rare (shape mutated mid-frame); fall back
                    // to legacy direct paint without cache.
                    if gather.effect_key() != *effect {
                        match effect {
                            EffectKey::Gather(GatherFx::BackgroundBlur) => {
                                self.render_background_blur(element, output);
                            }
                            EffectKey::Gather(GatherFx::Glass) => {
                                if let Some(glass) =
                                    element.glass.as_ref().filter(|g| !g.hidden)
                                {
                                    crate::render::glass::render_glass(
                                        self, element, glass, output,
                                    );
                                }
                            }
                            _ => {}
                        }
                        continue;
                    }

                    let is_root_level =
                        element.parent_id.is_some_and(|p| p == Uuid::nil());
                    let backdrop_id = gather.snapshot_source(is_root_level);

                    let (backdrop, world_origin) = match self
                        .surfaces
                        .get_glass_backdrop_with_world_origin(id)
                    {
                        Some(v) => v,
                        None => {
                            // Defensive fallback — `BuildCache` step
                            // skipped (shouldn't happen given `has_gather`
                            // lift, but keep safety).
                            if backdrop_id == SurfaceId::Target {
                                let tile_rect = self.get_current_tile_bounds()?;
                                let bg_color = self.background_color;
                                self.surfaces
                                    .composite_current_to_target(tile_rect, bg_color);
                                self.flush_and_submit();
                            }
                            (
                                self.surfaces
                                    .get_or_snapshot_glass_backdrop(id, backdrop_id),
                                None,
                            )
                        }
                    };

                    gather.render(self, element, backdrop, backdrop_id, output, world_origin);
                }
                EffectKey::Scatter(ScatterFx::DropShadows) => {
                    if self.options.is_fast_mode() {
                        continue;
                    }
                    let translation = self
                        .surfaces
                        .get_render_context_translation(self.render_area, scale);
                    let node_render_state = crate::render::NodeRenderState::leaf(id);
                    let mut extrect_cache: Option<skia::Rect> = None;
                    self.render_element_drop_shadows_and_composite(
                        element,
                        tree,
                        &mut extrect_cache,
                        None,
                        scale,
                        translation,
                        &node_render_state,
                        output,
                    )?;
                }
                EffectKey::Local(LocalFx::ShapeBody) => {
                    // V2c-phase4: scheduler-native draw. Direct paint
                    // into `output`; the matching `BeginLayer` already
                    // wraps the layer for opacity/blend so we never
                    // wrap one here. Falls back to `render_shape`
                    // legacy chain for shape types `render_shape_into_target`
                    // does not yet handle (text, svg, masked, etc.).
                    self.render_shape_into_target(element, output)?;
                }
                EffectKey::Local(LocalFx::LayerBlur) => {
                    // V2c.1 — pull the cached layer-blur image
                    // (built by the matching `BuildCache(LocalBlur(id))`
                    // step) and blit onto `output` at the right
                    // world-space position.
                    if let Some((image, world_bbox)) =
                        self.surfaces.get_local_blur_output(id)
                    {
                        crate::render::local::LocalKind::paint_cached(
                            self,
                            &image,
                            world_bbox,
                            output,
                        );
                    } else {
                        // Defensive fallback — `BuildCache` was
                        // skipped (overflow / extent invalid). Phase H.1:
                        // route through scheduler-native dispatcher;
                        // shape paints without layer-blur on this rare
                        // overflow path (better than legacy chain).
                        self.render_shape_into_target(element, output)?;
                    }
                }
                EffectKey::Scatter(ScatterFx::Blit) => {
                    // Pre-rendered displaced image, blitted from the
                    // `Cache(Scatter(id))` slot built by `BuildCache(Scatter)`.
                    let Some((img, clipped_extrect)) = self
                        .surfaces
                        .get_scatter_output(id)
                        .map(|(i, r)| (i.clone(), *r))
                    else {
                        continue;
                    };
                    let translation = self
                        .surfaces
                        .get_render_context_translation(self.render_area, scale);
                    let tile_world = self.render_area;
                    let skip_shadows = self.options.is_fast_mode();
                    let has_inner_shadows = !skip_shadows
                        && element.inner_shadows_visible().next().is_some();

                    let canvas = self.surfaces.canvas_and_mark_dirty(output);
                    canvas.save();
                    canvas.scale((scale, scale));
                    canvas.translate(translation);
                    canvas.clip_rect(tile_world, skia::ClipOp::Intersect, true);

                    let src = skia::Rect::from_xywh(
                        0.0,
                        0.0,
                        img.width() as f32,
                        img.height() as f32,
                    );
                    let src_constraint =
                        Some((&src, skia::canvas::SrcRectConstraint::Strict));

                    if !skip_shadows {
                        for shadow in element.drop_shadows_visible() {
                            let Some(filter) = shadow.get_drop_shadow_filter() else {
                                continue;
                            };
                            let mut paint = skia::Paint::default();
                            paint.set_image_filter(filter);
                            canvas.draw_image_rect(
                                &img,
                                src_constraint,
                                clipped_extrect,
                                &paint,
                            );
                        }
                    }

                    if has_inner_shadows {
                        canvas.save_layer(&skia::canvas::SaveLayerRec::default());
                    }

                    canvas.draw_image_rect(
                        &img,
                        src_constraint,
                        clipped_extrect,
                        &skia::Paint::default(),
                    );

                    if has_inner_shadows {
                        for shadow in element.inner_shadows_visible() {
                            let Some(filter) = shadow.get_inner_shadow_filter() else {
                                continue;
                            };
                            let mut paint = skia::Paint::default();
                            paint.set_image_filter(filter);
                            paint.set_blend_mode(skia::BlendMode::SrcATop);
                            canvas.draw_image_rect(
                                &img,
                                src_constraint,
                                clipped_extrect,
                                &paint,
                            );
                        }
                        canvas.restore();
                    }

                    canvas.restore();
                }
            }
        }
        Ok(())
    }

    pub fn start_render_loop(
        &mut self,
        base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        timestamp: i32,
        sync_render: bool,
    ) -> Result<()> {
        // Top-level frame guard. Wraps everything inside this entry
        // point — schedule build, surface clears, run_schedule, GPU
        // flush — so a single tag is the answer to "how long did this
        // frame's CPU-side wasm work take?". Sub-guards
        // (`tile_grid_rebuild`, `run_schedule_TOTAL`, ...) still break
        // it down.
        crate::perf_guard!("frame_TOTAL");
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
            crate::perf_guard!("tile_grid_rebuild");
            self.tile_grid.rebuild(tree, &self.tile_viewbox, scale);
            self.tile_grid.reset();
        }
        performance::end_measure!("tile_grid_rebuild");

        self.nested_fills.clear();
        self.current_tile = None;
        self.render_in_progress = true;

        // Phase I.3: defensive scratch-flush dropped — Phase I.2
        // removed the last scratch-chain caller (text helper); no
        // residual scratch state to flush.

        if sync_render {
            self.run_schedule(tree, timestamp, false)?;
            self.flush_and_submit();
        } else {
            self.run_schedule(tree, timestamp, true)?;
            self.flush_and_submit();
            if self.render_in_progress {
                self.cancel_animation_frame();
                self.render_request_id = Some(wapi::request_animation_frame!());
            } else {
                performance::end_measure!("render");
            }
        }

        performance::end_measure!("start_render_loop");
        performance::end_timed_log!("start_render_loop", _start);
        crate::perf_record_frame!();
        Ok(())
    }

    pub fn process_animation_frame(
        &mut self,
        _base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        timestamp: i32,
    ) -> Result<()> {
        // Continuation-frame top-level guard. Same role as
        // `frame_TOTAL` in `start_render_loop` but for chunked async
        // continuations. Sums to the full per-frame CPU cost.
        crate::perf_guard!("frame_TOTAL");
        performance::begin_measure!("process_animation_frame");
        if self.render_in_progress {
            if tree.len() != 0 {
                self.run_schedule(tree, timestamp, true)?;
            }
            self.flush_and_submit();

            if self.render_in_progress {
                self.cancel_animation_frame();
                self.render_request_id = Some(wapi::request_animation_frame!());
            } else {
                performance::end_measure!("render");
            }
        }
        performance::end_measure!("process_animation_frame");
        crate::perf_record_frame!();
        Ok(())
    }

    pub fn render_shape_tree_sync(
        &mut self,
        _base_object: Option<&Uuid>,
        tree: ShapesPoolRef,
        timestamp: i32,
    ) -> Result<()> {
        if tree.len() != 0 {
            self.run_schedule(tree, timestamp, false)?;
        }
        self.flush_and_submit();
        Ok(())
    }

    /// The main render loop. Walks the pre-computed schedule where every
    /// band is bracketed by a `SetTileBand` (setup) and a `FinalizeBand`
    /// (teardown) step. Because `FinalizeBand.kind` is decided at build
    /// time, nothing about the finalize depends on state that a yield
    /// could drop.
    ///
    /// Per band:
    /// - `SetTileBand` sets up the tile context, then either clears Current
    ///   (is_first, or cached_blit fast-path), or restores Current from
    ///   the interband cache (non-first band).
    /// - `Enter`/`Render`/`Exit` steps render the band's shapes into
    ///   Current.
    /// - `FinalizeBand` executes the precomputed finalize action:
    ///   * `Intermediate` — composite Current→Target (so peer gather
    ///     bands see it) + snapshot Current into interband cache.
    ///   * `LastContent` — apply Current to final canvas + drop interband.
    ///   * `LastBg` — direct bg draw on Target + drop interband.
    fn run_schedule(
        &mut self,
        tree: ShapesPoolRef,
        timestamp: i32,
        can_yield: bool,
    ) -> Result<()> {
        crate::perf_guard!("run_schedule_TOTAL");
        let mut iteration = 0;

        while let Some(step) = self.tile_grid.next() {
            match step {
                RenderStep::SetTileBand {
                    tile,
                    band_index,
                    is_first,
                    is_last,
                } => {
                    crate::perf_guard!("step_SetTileBand");
                    self.update_render_context(tile);

                    if is_first {
                        // First visit to this tile. Check for a fully cached
                        // tile surface — the fast path — before clearing.
                        // The cached path is only valid for tiles with a
                        // single band AND no gather at the band head.
                        // Gather tiles' output depends on the current
                        // frame's Target backdrop, so a cached image from
                        // a previous frame is inherently stale.
                        let tile_bands = self.tile_grid.bands.get(&tile);
                        let tile_band_count = tile_bands.map(|b| b.len()).unwrap_or(1);
                        let band_has_gather_head = tile_bands
                            .and_then(|b| b.first())
                            .is_some_and(|b| b.gather_at_head.is_some());
                        if tile_band_count == 1
                            && !band_has_gather_head
                            && self.surfaces.has_cached_tile_surface(tile)
                        {
                            crate::perf_count!(tile_hit);
                            crate::perf_guard!("step_SetTileBand_cached_blit");
                            let rect = self.get_current_tile_bounds()?;
                            self.surfaces.draw_cached_tile_surface(
                                tile,
                                rect,
                                self.background_color,
                            );
                            self.current_tile = None;
                            // Blit already drew to final — skip this tile's
                            // FinalizeBand step by advancing to the next
                            // SetTileBand (or end of schedule).
                            self.tile_grid.skip_to_next_tile();
                            continue;
                        }
                        // First-band visit that didn't take the cached_blit
                        // fast path. Counts as a miss regardless of why
                        // (no entry in cache, multi-band tile, gather head)
                        // — `tile_misses + tile_hits` is the count of
                        // first-band tile visits per frame.
                        crate::perf_count!(tile_miss);

                        self.surfaces
                            .canvas(SurfaceId::Current)
                            .clear(self.background_color);

                    } else {
                        // Non-first band: restore Current from the snapshot
                        // left by the previous visit to this same tile.
                        // Clear first so the restore lands on a clean slate
                        // (margins outside the content region stay bg).
                        self.surfaces
                            .canvas(SurfaceId::Current)
                            .clear(self.background_color);
                        let restored = self.surfaces.restore_current_from_interband(tile);
                        debug_assert!(
                            restored,
                            "run_schedule: non-first band visit to {:?} without a snapshot",
                            tile
                        );
                    }
                }

                RenderStep::FinalizeBand { tile, kind } => {
                    crate::perf_guard!("step_FinalizeBand");
                    // The SetTileBand that opened this band already set
                    // current_tile; if it was cleared (cached_blit path),
                    // skip_to_next_tile would have hopped past us. So in
                    // any well-formed schedule, current_tile == Some(tile)
                    // here.
                    debug_assert_eq!(
                        self.current_tile,
                        Some(tile),
                        "FinalizeBand {:?} arrived with current_tile={:?}",
                        tile, self.current_tile
                    );
                    let tile_rect = self.get_current_tile_bounds()?;
                    match kind {
                        FinalizeKind::Intermediate => {
                            self.surfaces.composite_current_to_target(
                                tile_rect,
                                self.background_color,
                            );
                            self.surfaces.snapshot_current_for_interband(tile);
                        }
                        FinalizeKind::LastContent => {
                            self.apply_render_to_final_canvas(tile_rect)?;
                            self.surfaces.drop_interband(tile);
                        }
                        FinalizeKind::LastBg => {
                            let bg = self.background_color;
                            self.surfaces.apply_mut(SurfaceId::Target as u32, |s| {
                                let mut paint = skia::Paint::default();
                                paint.set_color(bg);
                                s.canvas().draw_rect(tile_rect, &paint);
                            });
                            self.surfaces.drop_interband(tile);
                        }
                    }
                }

                RenderStep::Enter { shape: id, has_external_layer, has_external_gather } => {
                    crate::perf_guard!("step_Enter");
                    let Some(element) = tree.get(&id) else {
                        continue;
                    };

                    if element.hidden {
                        // Skip this container and its children
                        self.skip_container_steps();
                        continue;
                    }

                    self.focus_mode.enter(&id);

                    if self.focus_mode.is_active() {
                        let scale = self.get_scale();
                        let skip_shadows = self.options.is_fast_mode();
                        let is_text = matches!(element.shape_type, Type::Text(_));

                        // P6: when `has_external_gather` is true, an earlier
                        // `PaintGather` step (emitted inside the surrounding
                        // PushScope) already ran the gather work — bg_blur
                        // and glass refraction are already on Current. Skip
                        // the inline calls. The non-scoped legacy path keeps
                        // running below for shapes the scheduler didn't lift.
                        if !has_external_gather {
                            // Background blur BEFORE save_layer so it modifies
                            // the backdrop independently of the shape's opacity.
                            {
                                crate::perf_guard!("enter_bg_blur");
                                self.render_background_blur(element, SurfaceId::Current);
                            }

                            // Glass effect BEFORE save_layer so it snapshots the
                            // real accumulated backdrop on Target. Mirrors the
                            // leaf Render handler's root-vs-nested branching.
                            if let Some(glass) = element.glass.as_ref().filter(|g| !g.hidden) {
                                crate::perf_guard!("enter_glass");
                                let is_root_level =
                                    element.parent_id.is_some_and(|p| p == Uuid::nil());
                                if is_root_level {
                                    let tile_rect = self.get_current_tile_bounds()?;
                                    let bg_color = self.background_color;
                                    self.surfaces
                                        .composite_current_to_target(tile_rect, bg_color);
                                    self.flush_and_submit();
                                    let backdrop_image = self
                                        .surfaces
                                        .get_or_snapshot_glass_backdrop(id, SurfaceId::Target);
                                    crate::render::glass::render_glass_with_backdrop_image(
                                        self,
                                        element,
                                        glass,
                                        SurfaceId::Current,
                                        SurfaceId::Target,
                                        Some(backdrop_image),
                                        None,
                                    );
                                } else {
                                    crate::render::glass::render_glass(
                                        self,
                                        element,
                                        glass,
                                        SurfaceId::Current,
                                    );
                                }
                            }
                        }

                        {
                            crate::perf_guard!("enter_render_shape_enter");
                            // V2c.2: scheduler emits a paired `BeginLayer`
                            // step ahead of this `Enter` for qualifying
                            // shapes and pre-bakes the choice into the
                            // `Enter` step (`has_external_layer`), so the
                            // dispatcher avoids re-running the predicate.
                            self.render_shape_enter(
                                element,
                                SurfaceId::Current,
                                has_external_layer,
                            );
                        }

                        // Drop shadows for the container itself. Text shapes
                        // emit drop shadows via the paragraph image filter
                        // inside `render_shape`, so skip the separate pass
                        // for them. Clipped frames with layer blur render
                        // shadows before the layer (not handled here for
                        // simplicity — add if needed).
                        if !skip_shadows && !is_text {
                            crate::perf_guard!("enter_drop_shadows");
                            let translation = self
                                .surfaces
                                .get_render_context_translation(self.render_area, scale);
                            let node_render_state =
                                crate::render::NodeRenderState::leaf(id);
                            let mut extrect_cache: Option<skia::Rect> = None;
                            self.render_element_drop_shadows_and_composite(
                                element,
                                tree,
                                &mut extrect_cache,
                                None,
                                scale,
                                translation,
                                &node_render_state,
                                SurfaceId::Current,
                            )?;
                        }

                        // Render the container's own fills/strokes alongside
                        // its children. Mirrors the non-tile path's ordering
                        // (enter → render_shape → children → exit). Strokes
                        // on clipped frames are skipped here — they land in
                        // `render_shape_exit` on top of children.
                        // Phase H.2: route through scheduler-native
                        // dispatcher. Frame fills + simple paths take
                        // direct-draw; effect-heavy frames still hit
                        // legacy until H.6 folds.
                        {
                            crate::perf_guard!("enter_render_shape");
                            self.render_shape_into_target(element, SurfaceId::Current)?;
                        }
                        self.surfaces
                            .canvas(SurfaceId::DropShadows)
                            .clear(skia::Color::TRANSPARENT);
                    }
                }

                RenderStep::BuildCache(kind) => {
                    crate::perf_guard!(match kind {
                        CacheKind::Scatter(_) => "step_BuildCache_Scatter",
                        CacheKind::Gather(_) => "step_BuildCache_Gather",
                        CacheKind::LocalBlur(_) => "step_BuildCache_LocalBlur",
                    });
                    performance::begin_measure!("scheduler_build_cache");
                    match kind {
                        CacheKind::Scatter(id) => {
                            let Some(element) = tree.get(&id) else {
                                performance::end_measure!("scheduler_build_cache");
                                continue;
                            };
                            // For combined scatter+glass: scheduler emitted
                            // BuildCache(Gather) earlier in the schedule, so
                            // the backdrop snapshot is already in the cache.
                            let (glass_backdrop, glass_backdrop_world_origin) = if element
                                .glass
                                .as_ref()
                                .is_some_and(|g| !g.hidden)
                            {
                                match self.surfaces.get_glass_backdrop_with_world_origin(id) {
                                    Some((img, origin)) => (Some(img), origin),
                                    None => (None, None),
                                }
                            } else {
                                (None, None)
                            };

                            // DBG-INSTR-B
                            {
                                let has_glass = element
                                    .glass
                                    .as_ref()
                                    .is_some_and(|g| !g.hidden);
                                let backdrop_some = glass_backdrop.is_some();
                                let (bw, bh) = glass_backdrop
                                    .as_ref()
                                    .map(|i| (i.width(), i.height()))
                                    .unwrap_or((0, 0));
                                let (wx, wy) = glass_backdrop_world_origin
                                    .map(|p| (p.x, p.y))
                                    .unwrap_or((-1.0, -1.0));
                                let radius = element
                                    .texture
                                    .as_ref()
                                    .map(|t| t.radius)
                                    .unwrap_or(0.0);
                                crate::wapi_post_log!(format!(
                                    "{{\"tag\":\"glass-bug/scatter-build\",\"site\":\"tile_grid.rs:2680\",\"value\":{{\"shape_id\":\"{:?}\",\"has_glass\":{},\"backdrop_some\":{},\"backdrop_w\":{},\"backdrop_h\":{},\"world_x\":{},\"world_y\":{},\"texture_radius\":{}}}}}",
                                    id, has_glass, backdrop_some, bw, bh, wx, wy, radius
                                ));
                            }

                            let scatter_output = if element.is_recursive() {
                                crate::perf_guard!("texture_filter_subtree");
                                crate::render::texture::render_and_filter_subtree_to_image(
                                    self,
                                    element,
                                    tree,
                                    glass_backdrop,
                                    glass_backdrop_world_origin,
                                )
                            } else {
                                crate::perf_guard!("texture_filter_leaf");
                                crate::render::texture::render_and_filter_to_image(
                                    self,
                                    element,
                                    tree,
                                    glass_backdrop,
                                    glass_backdrop_world_origin,
                                )
                            };
                            if let Some((img, clipped_extrect)) = scatter_output {
                                self.surfaces
                                    .insert_scatter_output(id, img, clipped_extrect);
                            }
                        }
                        CacheKind::Gather(id) => {
                            // Bbox-bounded gather backdrop snapshot via
                            // `image_snapshot_with_bounds`. Routed through
                            // `GatherKind` so glass + bg-blur (root + nested)
                            // share the same path. Snapshot covers `selrect
                            // ± 3σ` instead of the whole target.
                            let Some(element) = tree.get(&id) else {
                                continue;
                            };
                            let Some(gather) =
                                crate::render::gather::GatherKind::from_shape(element)
                            else {
                                continue;
                            };

                            // P4: gather inside an open scope composes
                            // its backdrop from `anc_F ⊕ scope_F ⊕ Current`
                            // (three image draws, independent of nesting
                            // depth — `anc_F` was pre-baked at PushScope).
                            // Skips the existing Target-snapshot path; the
                            // resulting image is bbox-bounded to the
                            // gather's `extent_world` and inserted into
                            // the per-shape backdrop cache the same way.
                            if !self.open_scopes.is_empty() {
                                self.build_gather_backdrop_scoped(
                                    id, element, &gather,
                                )?;
                                performance::end_measure!("scheduler_build_cache");
                                continue;
                            }

                            let is_root_level =
                                element.parent_id.is_some_and(|p| p == Uuid::nil());
                            let snapshot_source = gather.snapshot_source(is_root_level);

                            // Root gather sources from Target (after
                            // composite); nested from Current.
                            if snapshot_source == SurfaceId::Target {
                                let tile_rect = self.get_current_tile_bounds()?;
                                let bg_color = self.background_color;
                                self.surfaces
                                    .composite_current_to_target(tile_rect, bg_color);
                            }
                            self.flush_and_submit();

                            let extent = crate::render::gather::extent_in_source_devpx(
                                self,
                                element,
                                &gather,
                                snapshot_source,
                            );
                            let bounded = self
                                .surfaces
                                .snapshot_subrect(snapshot_source, extent);

                            // Convert the (clamped) extent's top-left in
                            // source-surface devpx back to world coords. The
                            // inverse of `extent_in_source_devpx`:
                            //   - Target (no margins):
                            //       world = viewbox + extent / scale
                            //   - Current/Filter/etc (extra_tile_dims, has margins):
                            //       world = render_area + (extent - margins) / scale
                            // Target is special because the backbuffer surface
                            // is allocated at the bare viewport size — its pixel
                            // (0, 0) is exactly at world `viewbox.origin`, with
                            // no margins ring before it.
                            let scale = self.get_scale();
                            let world_origin = {
                                let inv_scale = 1.0 / scale.max(1e-6);
                                match snapshot_source {
                                    SurfaceId::Target => skia::Point::new(
                                        self.viewbox.area.left
                                            + (extent.left as f32) * inv_scale,
                                        self.viewbox.area.top
                                            + (extent.top as f32) * inv_scale,
                                    ),
                                    _ => {
                                        let margins = self.surfaces.margins();
                                        skia::Point::new(
                                            self.render_area.left
                                                + (extent.left as f32 - margins.width as f32)
                                                    * inv_scale,
                                            self.render_area.top
                                                + (extent.top as f32 - margins.height as f32)
                                                    * inv_scale,
                                        )
                                    }
                                }
                            };

                            // DBG-INSTR-A
                            {
                                let bounded_some = bounded.is_some();
                                let (bw, bh) = bounded
                                    .as_ref()
                                    .map(|i| (i.width(), i.height()))
                                    .unwrap_or((0, 0));
                                let radius = element
                                    .texture
                                    .as_ref()
                                    .map(|t| t.radius)
                                    .unwrap_or(0.0);
                                let parent_kind = match element.parent_id {
                                    Some(p) if p == Uuid::nil() => "nil",
                                    Some(_) => "frame",
                                    None => "none",
                                };
                                crate::wapi_post_log!(format!(
                                    "{{\"tag\":\"glass-bug/gather-built\",\"site\":\"tile_grid.rs:2739\",\"value\":{{\"shape_id\":\"{:?}\",\"snapshot_source\":\"{:?}\",\"is_root_level\":{},\"parent_kind\":\"{}\",\"render_area_left\":{},\"render_area_top\":{},\"viewbox_left\":{},\"viewbox_top\":{},\"extent_x\":{},\"extent_y\":{},\"extent_w\":{},\"extent_h\":{},\"world_x\":{},\"world_y\":{},\"bounded_some\":{},\"bounded_w\":{},\"bounded_h\":{},\"texture_radius\":{}}}}}",
                                    id, snapshot_source, is_root_level, parent_kind, self.render_area.left, self.render_area.top, self.viewbox.area.left, self.viewbox.area.top, extent.left, extent.top, extent.width(), extent.height(), world_origin.x, world_origin.y, bounded_some, bw, bh, radius
                                ));
                            }

                            match bounded {
                                Some(img) => self
                                    .surfaces
                                    .insert_glass_backdrop_with_world_origin(
                                        id,
                                        img,
                                        world_origin,
                                    ),
                                None => {
                                    // Empty/clamped extent fallback —
                                    // snapshot the entire source surface.
                                    // The full-surface image's pixel (0,0)
                                    // corresponds to the source's pixel
                                    // (0,0). For Target (no margins),
                                    // that's `viewbox.origin`. For Current/
                                    // Filter (extra_tile_dims w/ margins),
                                    // that's `render_area - margins/scale`.
                                    let image = self
                                        .surfaces
                                        .get_or_snapshot_glass_backdrop(
                                            id,
                                            snapshot_source,
                                        );
                                    let inv_scale = 1.0 / scale.max(1e-6);
                                    let full_origin = match snapshot_source {
                                        SurfaceId::Target => skia::Point::new(
                                            self.viewbox.area.left,
                                            self.viewbox.area.top,
                                        ),
                                        _ => {
                                            let margins = self.surfaces.margins();
                                            skia::Point::new(
                                                self.render_area.left
                                                    - (margins.width as f32) * inv_scale,
                                                self.render_area.top
                                                    - (margins.height as f32) * inv_scale,
                                            )
                                        }
                                    };
                                    self.surfaces
                                        .insert_glass_backdrop_with_world_origin(
                                            id,
                                            image,
                                            full_origin,
                                        );
                                }
                            }
                        }
                        CacheKind::LocalBlur(id) => {
                            // Leaf layer-blur cache build. Render bounded
                            // body, blur, snapshot into the per-frame
                            // local_blur_output_cache. Paint pulls + blits.
                            let Some(element) = tree.get(&id) else {
                                continue;
                            };
                            let Some(local) =
                                crate::render::local::LocalKind::from_shape_layer_blur(
                                    element,
                                )
                            else {
                                continue;
                            };
                            let result = local.render_to_image(self, element);
                            let Some((image, world_bbox)) = result else {
                                // Overflow / fallback — skip caching this
                                // frame; Paint arm's defensive fallback
                                // paints inline.
                                continue;
                            };
                            self.surfaces
                                .insert_local_blur_output(id, image, world_bbox);
                        }
                    }
                    performance::end_measure!("scheduler_build_cache");
                }

                RenderStep::FreeCache(kind) => {
                    crate::perf_guard!("step_FreeCache");
                    match kind {
                        CacheKind::Scatter(id) => self.surfaces.remove_scatter_output(id),
                        CacheKind::Gather(id) => self.surfaces.remove_glass_backdrop(id),
                        CacheKind::LocalBlur(id) => self.surfaces.remove_local_blur_output(id),
                    }
                }

                RenderStep::PaintGather { shape: id, output, effects } => {
                    crate::perf_guard!("step_PaintGather");
                    performance::begin_measure!("paint_gather_step");
                    let Some(element) = tree.get(&id) else {
                        performance::end_measure!("paint_gather_step");
                        continue;
                    };
                    if element.hidden {
                        performance::end_measure!("paint_gather_step");
                        continue;
                    }
                    // PaintGather and PaintBody share the same shape — `enter`
                    // here, paired with PaintBody's `exit`. focus_mode is
                    // reentrant so this is safe even if PaintBody is skipped.
                    self.focus_mode.enter(&id);
                    if !self.focus_mode.is_active() {
                        performance::end_measure!("paint_gather_step");
                        continue;
                    }
                    let scale = self.get_scale();
                    let extrect = element.extrect(tree, scale);
                    if !extrect.intersects(self.render_area_with_margins) {
                        performance::end_measure!("paint_gather_step");
                        continue;
                    }
                    let body_effects: Vec<EffectKey> = effects
                        .iter()
                        .map(|g| EffectKey::Gather(*g))
                        .collect();
                    self.scheduler_render_effects(element, tree, output, &body_effects)?;
                    performance::end_measure!("paint_gather_step");
                }

                RenderStep::PaintBody { shape: id, output, effects } => {
                    crate::perf_guard!("step_PaintBody");
                    performance::begin_measure!("paint_body_step");
                    let Some(element) = tree.get(&id) else {
                        performance::end_measure!("paint_body_step");
                        continue;
                    };
                    if element.hidden {
                        performance::end_measure!("paint_body_step");
                        continue;
                    }
                    // For shapes without a PaintGather step, this is the
                    // first visit — focus_mode.enter is idempotent. For
                    // shapes that had a PaintGather, this matches its enter.
                    self.focus_mode.enter(&id);
                    if !self.focus_mode.is_active() {
                        performance::end_measure!("paint_body_step");
                        continue;
                    }
                    let scale = self.get_scale();
                    let extrect = element.extrect(tree, scale);
                    if !extrect.intersects(self.render_area_with_margins) {
                        performance::end_measure!("paint_body_step");
                        continue;
                    }
                    self.scheduler_render_effects(element, tree, output, &effects)?;
                    self.focus_mode.exit(&id);
                    performance::end_measure!("paint_body_step");
                }

                RenderStep::PushScope { shape, has_ancestor_snapshot } => {
                    crate::perf_guard!("step_PushScope");
                    self.handle_push_scope(shape, tree, has_ancestor_snapshot)?;
                }

                RenderStep::PopScope { shape, is_final_tile } => {
                    crate::perf_guard!("step_PopScope");
                    self.handle_pop_scope(shape, is_final_tile)?;
                }

                RenderStep::Exit { shape: id, has_external_layer } => {
                    crate::perf_guard!("step_Exit");
                    let Some(element) = tree.get(&id) else {
                        continue;
                    };

                    if self.focus_mode.is_active() {
                        // V2c.2: matched with the `has_external_layer`
                        // choice on the paired `Enter` step — when set,
                        // the trailing `EndLayer` step pops the layer
                        // and we skip `render_shape_exit`'s inline
                        // restore.
                        self.render_shape_exit(
                            element,
                            None,
                            SurfaceId::Current,
                            has_external_layer,
                        )?;
                    }

                    self.focus_mode.exit(&id);
                }

                RenderStep::BeginLayer { paint, .. } => {
                    crate::perf_guard!("step_BeginLayer");
                    // Always push/pop unconditionally — focus_mode flips
                    // mid-traversal (toggles on Enter/Exit of the focused
                    // subtree) and gating here on `is_active` would risk
                    // an unmatched save_layer if the state flips between
                    // BeginLayer and the paired EndLayer. The work done
                    // inside the layer (children's Paint steps) is
                    // separately gated by their own focus checks.
                    let mut p = skia::Paint::default();
                    p.set_alpha_f(paint.opacity);
                    p.set_blend_mode(paint.blend_mode);
                    if let Some(sigma) = paint.frame_blur_sigma_dev {
                        if let Some(filter) =
                            skia::image_filters::blur((sigma, sigma), None, None, None)
                        {
                            p.set_image_filter(filter);
                        }
                    }
                    let rec = skia::canvas::SaveLayerRec::default().paint(&p);
                    self.surfaces.canvas(SurfaceId::Current).save_layer(&rec);
                }

                RenderStep::EndLayer { .. } => {
                    crate::perf_guard!("step_EndLayer");
                    self.surfaces.canvas(SurfaceId::Current).restore();
                }
            }

            if can_yield {
                iteration += 1;
                if self.should_stop_rendering(iteration, timestamp) {
                    return Ok(());
                }
            }
        }

        // With explicit FinalizeBand steps, a well-formed schedule always
        // ends on a FinalizeBand (or on a cached_blit that already drew to
        // final). No trailing finalize needed.

        // Clear any stale inter-band snapshots so they don't leak into
        // the next frame's run_schedule invocation. Per-gather-shape
        // backdrops and per-scatter-shape displaced outputs are released
        // by `RenderStep::FreeCache` steps emitted at the tail of the
        // schedule, so no global clear is needed for them here.
        self.surfaces.clear_interband_cache();

        // V3 P3: scope allocations and open scopes should be empty at
        // end-of-schedule (every `PushScope` paired with a `PopScope`
        // with `is_final_tile=true` removed the entry). Clear
        // defensively in case of asymmetric schedules (e.g. partial
        // cancellation, future paths that bail mid-schedule).
        self.scope_allocations.clear();
        self.open_scopes.clear();

        self.render_in_progress = false;
        self.surfaces.gc();
        self.cached_viewbox = self.viewbox;

        if self.options.is_debug_visible() {
            crate::render::debug::render(self);
        }

        crate::render::ui::render(self, tree);
        crate::render::debug::render_wasm_label(self);

        Ok(())
    }

    /// Skip past matching Enter/Exit pairs when a container is hidden.
    fn skip_container_steps(&mut self) {
        let mut depth = 1;
        while depth > 0 {
            match self.tile_grid.next() {
                Some(RenderStep::Enter { .. }) => depth += 1,
                Some(RenderStep::Exit { .. }) => depth -= 1,
                None => break,
                _ => {}
            }
        }
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
        let has_gather = TileGrid::shape_has_gather(shape);
        let z_index = shape.z_index();

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
                    z_index,
                    paint_order: 0,
                    has_gather,
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
        let has_gather = TileGrid::shape_has_gather(shape);
        let z_index = shape.z_index();

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
                    z_index,
                    paint_order: 0,
                    has_gather,
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
        let has_gather = TileGrid::shape_has_gather(shape);
        let z_index = shape.z_index();
        let mut result = Vec::new();

        // paint_order placeholder — renumbered by the next full/touched pass.
        for tile in (rsx..=rex).flat_map(|x| (rsy..=rey).map(move |y| Tile::from(x, y))) {
            self.tile_grid.add_shape_at(
                tile,
                ShapeEntry {
                    id: shape.id,
                    z_index,
                    paint_order: 0,
                    has_gather,
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

        // Also invalidate any gather tile whose sample region overlaps the
        // changed tiles. Without this, a non-gather shape moving inside a
        // glass/background-blur sample region leaves the gather's cached
        // backdrop stale.
        let gather_affected =
            self.tile_grid
                .gather_tiles_affected_by(&affected, tree, scale);

        for tile in affected {
            self.remove_cached_tile(tile);
        }
        for tile in gather_affected {
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
        let scale = self.get_scale();
        let gather_affected = self.tile_grid.gather_tiles_affected_by(&all_tiles, tree, scale);
        for tile in all_tiles {
            self.remove_cached_tile(tile);
        }
        for tile in gather_affected {
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

        // Re-index affected shapes and invalidate their tiles
        let mut all_tiles = HashSet::default();
        for shape_id in &ancestors {
            if let Some(shape) = tree.get(shape_id) {
                all_tiles.extend(self.update_shape_tiles(shape, tree));
            }
        }
        let scale = self.get_scale();
        let gather_affected = self.tile_grid.gather_tiles_affected_by(&all_tiles, tree, scale);
        for tile in all_tiles {
            self.remove_cached_tile(tile);
        }
        for tile in gather_affected {
            self.remove_cached_tile(tile);
        }
        Ok(())
    }

    pub fn render_shape_pixels(
        &mut self,
        id: &Uuid,
        tree: ShapesPoolRef,
        scale: f32,
        timestamp: i32,
    ) -> Result<(Vec<u8>, i32, i32)> {
        let target_surface = SurfaceId::Export;

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

#[cfg(test)]
mod tests;
