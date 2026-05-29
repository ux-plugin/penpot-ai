//! Explicit per-call rendering context for the SSA renderers.
//!
//! Replaces the legacy `&mut RenderState + SurfaceId` pair with a
//! struct holding exactly what a render call needs:
//!
//! - The target `skia::Surface` (no SurfaceId lookup)
//! - The tile context (`tile`, `world_origin`, `world_clip`) — what
//!   the SSA `Step::Paint` already carries
//! - The per-pass scratches (`shape_fills`, `shape_strokes`,
//!   `drop_shadows`, `inner_shadows`, `text_drop_shadows`) — singletons
//!   owned by `SinglePassScratches`, borrowed by the ctx
//! - Read-only refs the renderers need (`fonts`, `images`, `viewbox`,
//!   `options`)
//! - The GPU + allocator handles for on-demand scratch growth
//!
//! No globals are read or written. Two render calls on the same
//! `PaintCtx` see the same state; two render calls on *different*
//! `PaintCtx`s are fully independent (no shared `Current` surface to
//! step on each other).
//!
//! ## Lifetime story
//!
//! `PaintCtx<'a>` holds borrows to RenderState's sub-fields. The
//! caller (`ProductionSink`) constructs one per Paint step from
//! disjoint borrows of `RenderState`:
//!
//! ```ignore
//! let mut ctx = PaintCtx {
//!     surface: map.get_mut(write_to).unwrap(),
//!     world_origin: step.world_origin,
//!     world_clip: step.clip_rect,
//!     tile,
//!     scale: state.viewbox.zoom,
//!     scratches: &mut state.scratches,
//!     fonts: &state.fonts,
//!     images: &state.images,
//!     viewbox: &state.viewbox,
//!     options: &state.options,
//!     nested_fills: &mut state.nested_fills,
//!     sampling: state.sampling_options,
//!     gpu: &mut state.gpu_state,
//!     allocator: &mut allocator,
//! };
//! ```
//!
//! Field-disjoint borrows on `RenderState` make this work without
//! conflicting `&mut`s.

use skia_safe as skia;

use super::super::gpu_state::GpuState;
use super::super::options::RenderOptions;
use super::super::ImageStore;
use super::super::fonts::FontStore;
use crate::shapes::Fill;
use crate::state::ShapesPoolRef;
use crate::tile_grid::ssa::SurfaceAllocator;
use crate::tiles::Tile;
use crate::view::Viewbox;

// `SinglePassScratches` was the originally-planned ownership wrapper
// for the per-pass scratch surfaces (`shape_fills`, `shape_strokes`,
// `drop_shadows`, `inner_shadows`, `text_drop_shadows`). Currently no
// SSA renderer needs them — fills draw directly to `ctx.surface` with
// no offscreen scratch step, and the shadow/text/scatter renderers
// that do need scratches haven't been ported yet. When those renderers
// land, the struct + `&'a mut SinglePassScratches` field on PaintCtx
// can be re-introduced from this file's history.

/// Per-call rendering context. Holds exactly what an SSA renderer
/// needs to produce pixels into a surface — no globals.
pub struct PaintCtx<'a> {
    /// Target surface (replaces the legacy `Surfaces.get_mut(target)`
    /// lookup). Canvas access via `ctx.surface.canvas()`.
    pub surface: &'a mut skia::Surface,
    /// Current tile coord — `(0, 0)`, `(1, 0)`, etc. The Step's
    /// metadata carried this here.
    pub tile: Tile,
    /// World-space origin of the current tile — top-left of the
    /// content region in world coords. Used by the canvas-translation
    /// setup the legacy `update_render_context` did.
    pub world_origin: skia::Point,
    /// World-space clip — the tile's bounding rect in world coords.
    /// Equivalent to the legacy `render_area`.
    pub world_clip: skia::Rect,
    /// Viewbox zoom level. Equivalent to legacy `render_state.get_scale()`.
    pub scale: f32,
    /// Read-only.
    pub fonts: &'a FontStore,
    pub images: &'a mut ImageStore,
    pub viewbox: &'a Viewbox,
    pub options: &'a RenderOptions,
    /// Group-ancestor fill propagation stack. Same semantics as
    /// legacy `RenderState.nested_fills`.
    pub nested_fills: &'a mut Vec<Vec<Fill>>,
    pub sampling: skia::SamplingOptions,
    /// For renderers that need to grow on-demand scratches (e.g. the
    /// scatter/texture path grows a filter surface).
    pub gpu: &'a mut GpuState,
    /// For renderers that allocate logical surfaces (gather backdrops,
    /// scatter outputs). Most renderers won't touch this.
    pub allocator: &'a mut SurfaceAllocator,
    /// Per-tile margins in device pixels. Equivalent to
    /// `Surfaces.margins`. Renderers need this to compute scratch-
    /// surface translations matching the tile content region.
    pub margins: skia::ISize,

    // ── Legacy singleton scratch surfaces ─────────────────────────
    // Same `extra_tile_dims` (e.g. 1024×1024) layout as `ctx.surface`,
    // pre-allocated on `Surfaces` at startup. Each effect renderer
    // clears, transform-sets, and draws into the one it needs, then
    // composites the snapshot back onto `ctx.surface`.
    //
    // Borrowed disjointly from `Surfaces` at PaintCtx-build time so
    // any renderer can grab the one it needs without re-acquiring.
    pub fills_scratch: &'a mut skia::Surface,
    pub strokes_scratch: &'a mut skia::Surface,
    pub inner_shadows_scratch: &'a mut skia::Surface,
    pub drop_shadows_scratch: &'a mut skia::Surface,
    pub text_drop_shadows_scratch: &'a mut skia::Surface,
    pub filter_scratch: &'a mut skia::Surface,

    /// Shape pool for renderers that walk children (frame/group
    /// recursive drop shadows, mask groups, etc.). Read-only; same
    /// `ShapesPoolRef` the `ProductionSink` was constructed with.
    pub tree: ShapesPoolRef<'a>,

    /// Fused gather backdrop (when this PaintCtx is built inside a
    /// `PaintGather` handler). Carries the `(image, world_extent)`
    /// pair the gather renderers (`render::ssa::gather`,
    /// `render::ssa::glass`) need to draw their effect against the
    /// neighborhood. `None` for ordinary Paint steps.
    pub gather_backdrop: Option<(skia::Image, skia::Rect)>,
}

impl<'a> PaintCtx<'a> {
    /// Device-pixel translation that maps world coords to canvas
    /// coords for the current tile. Equal to
    /// `(margins_w - render_area.left*scale, margins_h - render_area.top*scale) / scale`
    /// (after scale, in world units). Mirrors
    /// `Surfaces::get_render_context_translation`.
    pub fn tile_translation_device(&self) -> skia::Point {
        let margin_w = self.margins.width as f32 / self.scale;
        let margin_h = self.margins.height as f32 / self.scale;
        skia::Point::new(
            margin_w - self.world_clip.left,
            margin_h - self.world_clip.top,
        )
    }

    /// Combined `scale × translate` matrix for the current tile —
    /// the canvas matrix the legacy `Surfaces.update_render_context`
    /// would have set. Returned as a value so callers can snapshot it
    /// *before* taking the `&mut surface.canvas()` borrow (which
    /// otherwise blocks any `&self` method call on the ctx).
    pub fn tile_transform_matrix(&self) -> skia::Matrix {
        let translation = self.tile_translation_device();
        // canvas.scale(s) then canvas.translate(t) composes as M = S * T.
        let mut m = skia::Matrix::scale((self.scale, self.scale));
        m.pre_translate(translation);
        m
    }

    /// Combined tile + shape matrix — what the legacy `render_body_direct`
    /// applies before drawing the shape body. Equal to
    /// `tile_transform_matrix * shape.transform_pivoted_around_center`.
    /// Caller concats this onto the canvas in a single call.
    pub fn tile_and_shape_transform_matrix(
        &self,
        shape: &crate::shapes::Shape,
    ) -> skia::Matrix {
        let mut tile = self.tile_transform_matrix();
        let center = shape.center();
        let mut shape_matrix = shape.transform;
        shape_matrix.post_translate(center);
        shape_matrix.pre_translate(-center);
        tile.pre_concat(&shape_matrix);
        tile
    }

    /// Apply the tile transform to `canvas`. Use only when you can
    /// already hold the `&mut surface.canvas()` borrow without also
    /// needing `&self` calls — most renderers should prefer
    /// `tile_transform_matrix()` + `canvas.concat(...)` instead.
    pub fn apply_tile_transform(&self, canvas: &skia::Canvas) {
        let m = self.tile_transform_matrix();
        canvas.concat(&m);
    }
}
