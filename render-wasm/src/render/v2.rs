use skia_safe::{self as skia, Matrix, RRect, Rect};
use std::borrow::Cow;

use rustc_hash::FxHashSet as HashSet;

use super::gpu_state::GpuState;

use super::options::RenderOptions;
pub use super::surfaces::{SurfaceId, Surfaces};

use super::{
    debug, fills, filters, fonts, glass, grid_layout, noise, shadows, strokes, text, texture, ui,
};
use super::local;

use crate::error::{Error, Result};
use crate::performance;
use crate::shapes::{
    all_with_ancestors, radius_to_sigma, Blur, BlurType, Corners, Fill, Shadow, Shape, SolidColor,
    Stroke, StrokeKind, Type,
};
use crate::state::{ShapesPoolMutRef, ShapesPoolRef};
use crate::tiles::{self, TileRect};
use crate::uuid::Uuid;
use crate::view::Viewbox;
use crate::wapi;

pub use super::fonts::*;
pub use super::images::*;

// This is the extra area used for tile rendering (tiles beyond viewport).
// Higher values pre-render more tiles, reducing empty squares during pan but using more memory.
pub(crate) const VIEWPORT_INTEREST_AREA_THRESHOLD: i32 = 1;
type ClipStack = Vec<(Rect, Option<Corners>, Matrix)>;

#[derive(Debug)]
pub struct NodeRenderState {
    pub id: Uuid,
    // We use this bool to keep that we've traversed all the children inside this node.
    visited_children: bool,
    // This is used to clip the content of frames.
    clip_bounds: Option<ClipStack>,
    // This is a flag to indicate that we've already drawn the mask of a masked group.
    visited_mask: bool,
    // This bool indicates that we're drawing the mask shape.
    mask: bool,
    // True when this container was flattened (enter/exit skipped).
    flattened: bool,
}
impl NodeRenderState {
    pub fn is_root(&self) -> bool {
        self.id.is_nil()
    }

    /// Leaf-shape state for callers outside the recursive `render_shape_tree`
    /// walk (e.g. the tile scheduler's `RenderStep::Render`). Only `id` is
    /// load-bearing — the rest is container-traversal bookkeeping.
    pub(crate) fn leaf(id: Uuid) -> Self {
        Self {
            id,
            visited_children: false,
            clip_bounds: None,
            visited_mask: false,
            mask: false,
            flattened: false,
        }
    }

    /// Calculates the clip bounds for child elements of a given shape.
    ///
    /// This function determines the clipping region that should be applied to child elements
    /// when rendering. It takes into account the element's selection rectangle, transform.
    ///
    /// # Parameters
    ///
    /// * `element` - The shape element for which to calculate clip bounds
    /// * `offset` - Optional offset (x, y) to adjust the bounds position. When provided,
    ///   the bounds are translated by the negative of this offset, effectively moving
    ///   the clipping region to compensate for coordinate system transformations.
    ///   This is useful for nested coordinate systems or when elements are grouped
    ///   and need relative positioning adjustments.
    fn append_clip(
        clip_stack: Option<ClipStack>,
        clip: (Rect, Option<Corners>, Matrix),
    ) -> Option<ClipStack> {
        match clip_stack {
            Some(mut stack) => {
                stack.push(clip);
                Some(stack)
            }
            None => Some(vec![clip]),
        }
    }

    pub fn get_children_clip_bounds(
        &self,
        element: &Shape,
        offset: Option<(f32, f32)>,
        clip_inset: Option<f32>,
    ) -> Option<ClipStack> {
        if self.id.is_nil() || !element.clip() {
            return self.clip_bounds.clone();
        }

        let mut bounds = element.selrect();
        if let Some(offset) = offset {
            let x = bounds.x() - offset.0;
            let y = bounds.y() - offset.1;
            let width = bounds.width();
            let height = bounds.height();
            bounds.set_xywh(x, y, width, height);
        }
        let mut transform = element.transform;
        transform.post_translate(bounds.center());
        transform.pre_translate(-bounds.center());

        let corners = match &element.shape_type {
            Type::Rect(data) => data.corners,
            Type::Frame(data) => data.corners,
            _ => None,
        };

        if let Some(clip_inset) = clip_inset.filter(|&e| e > 0.0) {
            bounds.inset((clip_inset, clip_inset));
        }

        Self::append_clip(self.clip_bounds.clone(), (bounds, corners, transform))
    }

    /// Calculates the clip bounds for shadow rendering of a given shape.
    ///
    /// This function determines the clipping region that should be applied when rendering a
    /// shadow for a shape element. For frames, it uses the shadow bounds to clip nested
    /// shadows. For groups, it returns the existing clip bounds since groups should not
    /// constrain nested shadows based on their selection rectangle bounds.
    ///
    /// # Parameters
    ///
    /// * `element` - The shape element for which to calculate shadow clip bounds
    /// * `shadow` - The shadow configuration containing blur, offset, and other properties
    pub fn get_nested_shadow_clip_bounds(
        &self,
        element: &Shape,
        shadow: &Shadow,
    ) -> Option<ClipStack> {
        if self.id.is_nil() {
            return self.clip_bounds.clone();
        }

        // Assert that the shape is either a Frame or Group
        assert!(
            matches!(element.shape_type, Type::Frame(_) | Type::Group(_)),
            "Shape must be a Frame or Group for nested shadow clip bounds calculation"
        );

        match &element.shape_type {
            Type::Frame(_) => {
                let mut bounds = element.get_selrect_shadow_bounds(shadow);
                let blur_inset = (shadow.blur * 2.).max(0.0);
                if blur_inset > 0.0 {
                    let max_inset_x = (bounds.width() * 0.5).max(0.0);
                    let max_inset_y = (bounds.height() * 0.5).max(0.0);
                    // Clamp the inset so we never shrink more than half of the width/height;
                    // otherwise the rect could end up inverted on small frames.
                    let inset_x = blur_inset.min(max_inset_x);
                    let inset_y = blur_inset.min(max_inset_y);
                    if inset_x > 0.0 || inset_y > 0.0 {
                        bounds.inset((inset_x, inset_y));
                    }
                }

                let mut transform = element.transform;
                transform.post_translate(element.center());
                transform.pre_translate(-element.center());

                let corners = match &element.shape_type {
                    Type::Frame(data) => data.corners,
                    _ => None,
                };

                Self::append_clip(self.clip_bounds.clone(), (bounds, corners, transform))
            }
            _ => self.clip_bounds.clone(),
        }
    }
}

/// Represents the "focus mode" state used during rendering.
///
/// Focus mode allows selectively highlighting or isolating specific shapes (UUIDs)
/// during the render pass. It maintains a list of shapes to focus and tracks
/// whether the current rendering context is inside a focused element.
///
/// # Focus Propagation
/// If a shape is in focus, all its nested content
/// is also considered to be in focus for the duration of the render traversal. Focus
/// state propagates *downward* through the tree while rendering.
///
/// # Usage
/// - `set_shapes(...)` to activate focus mode for specific elements and their anidated content.
/// - `clear()` to disable focus mode.
/// - `reset()` should be called at the beginning of the render loop.
/// - `enter(...)` / `exit(...)` should be called when entering and leaving shape
///   render contexts.
/// - `is_active()` returns whether the current shape is being rendered in focus.
pub struct FocusMode {
    shapes: Vec<Uuid>,
    active: bool,
}

impl FocusMode {
    pub fn new() -> Self {
        FocusMode {
            shapes: Vec::new(),
            active: false,
        }
    }

    pub fn clear(&mut self) {
        self.shapes.clear();
        self.active = false;
    }

    pub fn set_shapes(&mut self, shapes: Vec<Uuid>) {
        self.shapes = shapes;
    }

    /// Returns `true` if the given shape ID should be focused.
    /// If the `shapes` list is empty, focus applies to all shapes.
    pub fn should_focus(&self, id: &Uuid) -> bool {
        self.shapes.is_empty() || self.shapes.contains(id)
    }

    pub fn enter(&mut self, id: &Uuid) {
        if !self.active && self.should_focus(id) {
            self.active = true;
        }
    }

    pub fn exit(&mut self, id: &Uuid) {
        if self.active && self.should_focus(id) {
            self.active = false;
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn reset(&mut self) {
        self.active = false;
    }
}

pub(crate) struct RenderState {
    pub(crate) gpu_state: GpuState,
    pub options: RenderOptions,
    pub surfaces: Surfaces,
    pub fonts: FontStore,
    pub viewbox: Viewbox,
    pub cached_viewbox: Viewbox,
    pub images: ImageStore,
    pub background_color: skia::Color,
    // Identifier of the current requestAnimationFrame call, if any.
    pub render_request_id: Option<i32>,
    // Indicates whether the rendering process has pending frames.
    pub render_in_progress: bool,
    // Stack of nodes pending to be rendered.
    pub current_tile: Option<tiles::Tile>,
    pub sampling_options: skia::SamplingOptions,
    pub render_area: Rect,
    // render_area expanded by surface margins — used for visibility checks so that
    // shapes in the margin zone are rendered (needed for background blur sampling).
    pub render_area_with_margins: Rect,
    pub tile_viewbox: tiles::TileViewbox,
    pub tile_grid: crate::tile_grid::TileGrid,
    /// Coarse revision counter feeding `backdrop_hash` for `Gather`
    /// effect-cache keys (phase 4). Bumped on any shape mutation
    /// path that could change the pixels behind a glass / bg-blur
    /// shape — `set_modifiers`, `clean_modifiers`. Pan/zoom do not
    /// bump it because world coords are unchanged. Pessimistic on
    /// move (every glass entry invalidates even if the moved shape
    /// is far away); phase 6 narrows this with per-shape mutation
    /// invalidation.
    pub scene_revision: u64,
    // nested_fills maintains a stack of group  fills that apply to nested shapes
    // without their own fill definitions. This is necessary because in SVG, a group's `fill`
    // can affect its child elements if they don't specify one themselves. If the planned
    // migration to remove group-level fills is completed, this code should be removed.
    // Frames contained in groups must reset this nested_fills stack pushing a new empty vector.
    pub nested_fills: Vec<Vec<Fill>>,
    pub show_grid: Option<Uuid>,
    pub focus_mode: FocusMode,
    pub touched_ids: HashSet<Uuid>,
    /// Preview render mode - when true, uses simplified rendering for progressive loading
    pub preview_mode: bool,
    pub export_context: Option<(Rect, f32)>,
}

pub(crate) fn get_cache_size(viewbox: Viewbox, scale: f32) -> skia::ISize {
    // First we retrieve the extended area of the viewport that we could render.
    let TileRect(isx, isy, iex, iey) = tiles::get_tiles_for_viewbox_with_interest(
        viewbox,
        VIEWPORT_INTEREST_AREA_THRESHOLD,
        scale,
    );

    let dx = if isx.signum() != iex.signum() { 1 } else { 0 };
    let dy = if isy.signum() != iey.signum() { 1 } else { 0 };

    let tile_size = tiles::TILE_SIZE;
    (
        ((iex - isx).abs() + dx) * tile_size as i32,
        ((iey - isy).abs() + dy) * tile_size as i32,
    )
        .into()
}

impl RenderState {
    pub fn try_new(width: i32, height: i32) -> Result<RenderState> {
        // This needs to be done once per WebGL context.
        let mut gpu_state = GpuState::try_new()?;
        let sampling_options =
            skia::SamplingOptions::new(skia::FilterMode::Linear, skia::MipmapMode::Nearest);

        let fonts = FontStore::try_new()?;
        let surfaces = Surfaces::try_new(
            &mut gpu_state,
            (width, height),
            sampling_options,
            tiles::get_tile_dimensions(),
        )?;

        // This is used multiple times everywhere so instead of creating new instances every
        // time we reuse this one.

        let viewbox = Viewbox::new(width as f32, height as f32);

        Ok(RenderState {
            gpu_state: gpu_state.clone(),
            options: RenderOptions::default(),
            surfaces,
            fonts,
            viewbox,
            cached_viewbox: Viewbox::new(0., 0.),
            images: ImageStore::new(gpu_state.context.clone()),
            background_color: skia::Color::TRANSPARENT,
            render_request_id: None,
            render_in_progress: false,
            current_tile: None,
            sampling_options,
            render_area: Rect::new_empty(),
            render_area_with_margins: Rect::new_empty(),
            tile_viewbox: tiles::TileViewbox::new_with_interest(
                viewbox,
                VIEWPORT_INTEREST_AREA_THRESHOLD,
                1.0,
            ),
            tile_grid: crate::tile_grid::TileGrid::new(),
            scene_revision: 0,
            nested_fills: vec![],
            show_grid: None,
            focus_mode: FocusMode::new(),
            touched_ids: HashSet::default(),
            preview_mode: false,
            export_context: None,
        })
    }

    /// Combines every visible layer blur currently active (ancestors + shape)
    /// into a single equivalent blur. Layer blur radii compound by adding their
    /// variances (σ² = radius²), so we:
    ///   1. Convert each blur radius into variance via `blur_variance`.
    ///   2. Sum all variances.
    ///   3. Convert the total variance back to a radius with `blur_from_variance`.
    ///
    /// This keeps blur math consistent everywhere we need to merge blur sources.
    fn combined_layer_blur(&self, shape_blur: Option<Blur>) -> Option<Blur> {
        // Phase G: nested_blurs stack stripped (zero push sites).
        // Variance roundtrip preserved as identity for visible LayerBlur,
        // returns None for hidden / non-LayerBlur, matching prior behavior
        // when stack was empty (the only state in v2).
        Self::blur_from_variance(Self::blur_variance(shape_blur))
    }

    /// Returns the variance (radius²) for a visible layer blur, or zero if the
    /// blur is hidden/absent. Working in variance space lets us add multiple
    /// blur radii correctly.
    fn blur_variance(blur: Option<Blur>) -> f32 {
        match blur {
            Some(blur) if !blur.hidden && blur.blur_type == BlurType::LayerBlur => {
                blur.value.powi(2)
            }
            _ => 0.,
        }
    }

    /// Builds a blur from an accumulated variance value. If no variance was
    /// contributed, we return `None`; otherwise the equivalent single radius is
    /// `sqrt(total)`.
    fn blur_from_variance(total: f32) -> Option<Blur> {
        (total > 0.).then(|| Blur::new(BlurType::LayerBlur, false, total.sqrt()))
    }

    /// Convenience helper to merge two optional layer blurs using the same
    /// variance math as `combined_layer_blur`.
    fn combine_blur_values(base: Option<Blur>, extra: Option<Blur>) -> Option<Blur> {
        let total = Self::blur_variance(base) + Self::blur_variance(extra);
        Self::blur_from_variance(total)
    }

    fn frame_clip_layer_blur(shape: &Shape) -> Option<Blur> {
        shape.frame_clip_layer_blur()
    }

    /// Renders background blur effect directly to the given target surface.
    /// Must be called BEFORE any save_layer for the shape's own opacity/blend,
    /// so that the backdrop blur is independent of the shape's visual properties.
    pub(crate) fn render_background_blur(&mut self, shape: &Shape, target_surface: SurfaceId) {
        if self.options.is_fast_mode() {
            return;
        }
        if matches!(shape.shape_type, Type::Text(_)) || matches!(shape.shape_type, Type::SVGRaw(_))
        {
            return;
        }
        if shape.background_blur.filter(|b| !b.hidden).is_none() {
            return;
        }
        let backdrop = self.surfaces.snapshot(target_surface);
        self.render_background_blur_from_image(shape, backdrop, None, target_surface);
    }

    /// Phase 7 — bg-blur path that consumes a pre-fetched backdrop
    /// image instead of snapshotting the target surface itself. The
    /// scheduler routes through this so a single per-shape backdrop
    /// snapshot covers all tiles for the gather.
    ///
    /// `backdrop_origin_devpx` (when `Some`) is the top-left of
    /// `backdrop` in `target_surface`'s device-pixel coord system. The
    /// blurred image draws at that origin so the clipped pixels land
    /// where they came from. `None` keeps legacy "image starts at
    /// (0, 0)" semantics.
    pub(crate) fn render_background_blur_from_image(
        &mut self,
        shape: &Shape,
        backdrop: skia::Image,
        backdrop_origin_devpx: Option<skia::IPoint>,
        target_surface: SurfaceId,
    ) {
        if self.options.is_fast_mode() {
            return;
        }
        if matches!(shape.shape_type, Type::Text(_)) || matches!(shape.shape_type, Type::SVGRaw(_))
        {
            return;
        }
        let blur = match shape.background_blur.filter(|b| !b.hidden) {
            Some(blur) => blur,
            None => return,
        };

        let scale = self.get_scale();
        let scaled_sigma = radius_to_sigma(blur.value * scale);
        // Cap sigma so the blur kernel (≈3σ) stays within the tile margin.
        // This prevents visible seams at tile boundaries when zoomed in.
        // During export there's no tiling, so skip the cap.
        let sigma = if self.export_context.is_some() {
            scaled_sigma
        } else {
            let margin = self.surfaces.margins().width as f32;
            let max_sigma = margin / 3.0;
            scaled_sigma.min(max_sigma)
        };

        let blur_filter =
            match skia::image_filters::blur((sigma, sigma), skia::TileMode::Clamp, None, None) {
                Some(filter) => filter,
                None => return,
            };

        let translation = self
            .surfaces
            .get_render_context_translation(self.render_area, scale);

        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);

        let canvas = self.surfaces.canvas(target_surface);
        canvas.save();

        // Current/Export have no render context transform (identity canvas).
        // Apply scale + translate + shape transform so the clip maps
        // from shape-local coords to device pixels correctly.
        canvas.scale((scale, scale));
        canvas.translate(translation);
        canvas.concat(&matrix);

        // Clip to shape's path based on shape type
        match &shape.shape_type {
            Type::Rect(data) if data.corners.is_some() => {
                let rrect = RRect::new_rect_radii(shape.selrect, data.corners.as_ref().unwrap());
                canvas.clip_rrect(rrect, skia::ClipOp::Intersect, true);
            }
            Type::Frame(data) if data.corners.is_some() => {
                let rrect = RRect::new_rect_radii(shape.selrect, data.corners.as_ref().unwrap());
                canvas.clip_rrect(rrect, skia::ClipOp::Intersect, true);
            }
            Type::Rect(_) | Type::Frame(_) => {
                canvas.clip_rect(shape.selrect, skia::ClipOp::Intersect, true);
            }
            Type::Circle => {
                let mut pb = skia::PathBuilder::new();
                pb.add_oval(shape.selrect, None, None);
                canvas.clip_path(&pb.detach(), skia::ClipOp::Intersect, true);
            }
            _ => {
                if let Some(path) = shape.get_skia_path() {
                    canvas.clip_path(&path, skia::ClipOp::Intersect, true);
                } else {
                    canvas.clip_rect(shape.selrect, skia::ClipOp::Intersect, true);
                }
            }
        }

        // Reset matrix so snapshot draws pixel-for-pixel on the surface.
        // Clips survive reset_matrix (stored in device coords).
        canvas.reset_matrix();

        // Image origin: legacy = (0,0) (snapshot covered the whole
        // target surface); bbox-bounded = the snapshot's top-left in
        // target devpx, so the blurred pixels land where they came
        // from.
        let (img_x, img_y) = match backdrop_origin_devpx {
            Some(p) => (p.x, p.y),
            None => (0, 0),
        };

        // Use Src blend to replace content within the clip with the
        // blurred version (not SrcOver which would double-render).
        let mut paint = skia::Paint::default();
        paint.set_image_filter(blur_filter);
        paint.set_blend_mode(skia::BlendMode::Src);
        canvas.draw_image(&backdrop, (img_x, img_y), Some(&paint));

        canvas.restore();
    }

    pub fn fonts(&self) -> &FontStore {
        &self.fonts
    }

    pub fn fonts_mut(&mut self) -> &mut FontStore {
        &mut self.fonts
    }

    pub fn add_image(&mut self, id: Uuid, is_thumbnail: bool, image_data: &[u8]) -> Result<()> {
        self.images.add(id, is_thumbnail, image_data)
    }

    /// Adds an image from an existing WebGL texture, avoiding re-decoding
    pub fn add_image_from_gl_texture(
        &mut self,
        id: Uuid,
        is_thumbnail: bool,
        texture_id: u32,
        width: i32,
        height: i32,
    ) -> Result<()> {
        self.images
            .add_image_from_gl_texture(id, is_thumbnail, texture_id, width, height)
    }

    pub fn has_image(&self, id: &Uuid, is_thumbnail: bool) -> bool {
        self.images.contains(id, is_thumbnail)
    }

    pub fn set_debug_flags(&mut self, debug: u32) {
        self.options.flags = debug;
    }

    pub fn set_dpr(&mut self, dpr: f32) -> Result<()> {
        if Some(dpr) != self.options.dpr {
            self.options.dpr = Some(dpr);
            self.resize(
                self.viewbox.width.floor() as i32,
                self.viewbox.height.floor() as i32,
            )?;
            self.fonts.set_scale_debug_font(dpr);
        }
        Ok(())
    }

    pub fn set_antialias_threshold(&mut self, value: f32) {
        self.options.set_antialias_threshold(value);
    }

    pub fn set_background_color(&mut self, color: skia::Color) {
        self.background_color = color;
    }

    pub fn set_preview_mode(&mut self, enabled: bool) {
        self.preview_mode = enabled;
    }

    pub fn resize(&mut self, width: i32, height: i32) -> Result<()> {
        let dpr_width = (width as f32 * self.options.dpr()).floor() as i32;
        let dpr_height = (height as f32 * self.options.dpr()).floor() as i32;
        self.surfaces
            .resize(&mut self.gpu_state, dpr_width, dpr_height)?;
        self.viewbox.set_wh(width as f32, height as f32);
        self.tile_viewbox.update(self.viewbox, self.get_scale());

        Ok(())
    }

    pub fn flush_and_submit(&mut self) {
        crate::perf_guard!("gpu_flush_and_submit");
        self.surfaces
            .flush_and_submit(&mut self.gpu_state, SurfaceId::Target);
    }

    pub fn reset_canvas(&mut self) {
        self.surfaces.reset(self.background_color);
    }

    #[allow(dead_code)]
    pub fn get_canvas_at(&mut self, surface_id: SurfaceId) -> &skia::Canvas {
        self.surfaces.canvas(surface_id)
    }

    #[allow(dead_code)]
    pub fn restore_canvas(&mut self, surface_id: SurfaceId) {
        self.surfaces.canvas(surface_id).restore();
    }

    pub fn apply_render_to_final_canvas(&mut self, rect: skia::Rect) -> Result<()> {
        let tile_rect = self.get_current_aligned_tile_bounds()?;
        self.surfaces.cache_current_tile_texture(
            &self.tile_viewbox,
            &self
                .current_tile
                .ok_or(Error::CriticalError("Current tile not found".to_string()))?,
            &tile_rect,
        );

        self.surfaces.draw_cached_tile_surface(
            self.current_tile
                .ok_or(Error::CriticalError("Current tile not found".to_string()))?,
            rect,
            self.background_color,
        );
        Ok(())
    }

    pub fn clear_focus_mode(&mut self) {
        self.focus_mode.clear();
    }

    pub fn set_focus_mode(&mut self, shapes: Vec<Uuid>) {
        self.focus_mode.set_shapes(shapes);
    }

    /// V2 scheduler-native shape draw.
    ///
    /// Replaces the per-aspect scratch chain (`render_shape` slow path
    /// → FILLS/STROKES/INNER scratch → `apply_drawing_to_render_canvas`
    /// blit) with one direct draw into `target`. Caller (the scheduler
    /// dispatcher) owns the save_layer for opacity/blend via the
    /// matching `BeginLayer` step, so this fn never wraps a layer.
    ///
    /// Scope: simple shape types (Rect, Circle, Path, Bool, plus
    /// containers Group/Frame as no-ops). Falls back to legacy
    /// `render_shape` for: Text, SVGRaw, shapes with backdrop blur,
    /// glass, masked groups, fast-mode special handling, or anything
    /// requiring the FILLS-as-clip pattern (inner shadows on fills).
    ///
    /// Why this exists: `render_shape` slow path was designed for V1
    /// traversal with an outer-save_layer assumption — opacity wraps
    /// the entire subtree at the V1 enter, and per-shape draws assume
    /// they paint into that wrapping layer. Under tile-scheduler that
    /// assumption fails for leaves with opacity (they don't get an
    /// enter/exit pair). Drawing directly into the scheduler's
    /// `BeginLayer`-wrapped target sidesteps the issue.
    /// V2 scheduler-native shape draw — top-level dispatcher.
    ///
    /// One-arg-per-target, one-helper-per-aspect. Each helper does
    /// direct draw into `target` (no scratch chain, no per-aspect
    /// surface). Caller (the scheduler dispatcher) owns the
    /// save_layer for opacity/blend via the matching `BeginLayer`
    /// step, so no helper wraps a layer for opacity/blend.
    ///
    /// Phase A scaffold: helpers Text/SVGRaw/bg-blur delegate to
    /// `render_shape_legacy` for now. Subsequent phases replace each
    /// stub with a direct-draw body.
    pub fn render_shape_into_target(
        &mut self,
        shape: &Shape,
        target: SurfaceId,
    ) -> Result<()> {
        // Containers without own visible content: nothing to paint.
        // Children handled by their own `Paint(ShapeBody)` entries.
        if matches!(shape.shape_type, Type::Group(_) | Type::Frame(_))
            && shape.fills.is_empty()
            && shape.visible_strokes().next().is_none()
        {
            return Ok(());
        }

        match &shape.shape_type {
            Type::Text(_) => self.render_text_into_target(shape, target),
            Type::SVGRaw(_) => self.render_svg_into_target(shape, target),
            // Phase I.1: backdrop-blur composition lives in
            // `EffectKey::Gather(BackgroundBlur)` (pre-pass); body draw
            // is identical to non-bg-blur shapes. Routed straight to
            // `render_body_direct`; former `render_with_backdrop_blur`
            // wrapper deleted.
            _ => self.render_body_direct(shape, target),
        }
    }

    /// Direct-draw body: fills + strokes + inner shadows + noise + layer
    /// blur into `target`. Caller (scheduler dispatcher) owns the
    /// save_layer for opacity/blend via the matching `BeginLayer` step.
    ///
    /// Phase H.6: folded former `render_body_legacy` (slow scratch chain
    /// + `apply_drawing_to_render_canvas` blit) into this single helper.
    /// Inner shadows now paint directly onto `target` via the per-fill
    /// or per-stroke shadow paint (filter creates inner-shadow look from
    /// shape geometry). Layer blur via inline save_layer.
    ///
    /// Composition order mirrors legacy `apply_drawing_to_render_canvas`:
    /// 1. fills + noise
    /// 2. fill inner shadows (only if `shape.has_fills()`)
    /// 3. strokes
    /// 4. stroke inner shadows (only if NOT `shape.has_fills()`)
    fn render_body_direct(&mut self, shape: &Shape, target: SurfaceId) -> Result<()> {
        let scale = self.get_scale();
        let translation = self
            .surfaces
            .get_render_context_translation(self.render_area, scale);
        let antialias =
            shape.should_use_antialias(scale, self.options.antialias_threshold);
        let fast_mode = self.options.is_fast_mode();

        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);

        // Layer blur sigma — applied via inline save_layer wrapping the
        // entire body draw. Skipped in fast mode (pan/zoom).
        let layer_sigma = if !fast_mode {
            shape
                .blur
                .filter(|b| !b.hidden && b.blur_type == BlurType::LayerBlur)
                .map(|b| b.sigma())
        } else {
            None
        };

        {
            let canvas = self.surfaces.canvas_and_mark_dirty(target);
            canvas.save();
            canvas.scale((scale, scale));
            canvas.translate(translation);
            canvas.concat(&matrix);
        }

        // Inline layer-blur isolation layer.
        if let Some(sigma) = layer_sigma {
            if let Some(filter) = skia::image_filters::blur((sigma, sigma), None, None, None) {
                let mut layer_paint = skia::Paint::default();
                layer_paint.set_image_filter(filter);
                let layer_rec = skia::canvas::SaveLayerRec::default().paint(&layer_paint);
                self.surfaces.canvas(target).save_layer(&layer_rec);
            }
        }

        // Fills with nested_fills fallback (group ancestor's fill
        // propagates to fill-less leaves; SVG `fill="none"` suppresses
        // fallback).
        let fill_none = shape
            .svg_attrs
            .as_ref()
            .is_some_and(|attrs| attrs.fill_none);
        let is_container = matches!(
            shape.shape_type,
            Type::Group(_) | Type::Frame(_)
        );
        if shape.fills.is_empty() && !is_container && !fill_none {
            if let Some(fills_to_render) = self.nested_fills.last() {
                let fills_to_render = fills_to_render.clone();
                fills::render(self, shape, &fills_to_render, antialias, target, None)?;
            }
        } else {
            fills::render(self, shape, &shape.fills, antialias, target, None)?;
        }

        // Noise overlay (mixed with fills before strokes).
        noise::render_shape_noise(self, shape, target);

        // Fill inner shadows (only when shape has fills; SrcAtop-style
        // image filter clips to fill geometry).
        if !fast_mode && shape.has_fills() {
            shadows::render_fill_inner_shadows(self, shape, antialias, target);
        }

        // Strokes (skipped on clipped frames — drawn in `render_shape_exit`
        // on top of children via `render_clipped_strokes_into_target`).
        let skip_strokes =
            matches!(shape.shape_type, Type::Frame(_)) && shape.clip_content;
        if !skip_strokes {
            let visible_strokes: Vec<&Stroke> = shape.visible_strokes().collect();
            if !visible_strokes.is_empty() {
                strokes::render(
                    self,
                    shape,
                    &visible_strokes,
                    Some(target),
                    antialias,
                    None,
                )?;
                // Stroke inner shadows (only when no fills — render_stroke_inner_shadows
                // internally guards on `!shape.has_fills()`).
                if !fast_mode && !shape.has_fills() {
                    for stroke in &visible_strokes {
                        shadows::render_stroke_inner_shadows(
                            self,
                            shape,
                            stroke,
                            antialias,
                            target,
                        )?;
                    }
                }
            }
        }

        // Restore layer-blur isolation layer (composites blurred body onto target).
        if layer_sigma.is_some() {
            self.surfaces.canvas(target).restore();
        }

        if self.options.is_debug_visible() {
            let shape_selrect_bounds = self.get_shape_selrect_bounds(shape);
            debug::render_debug_shape(self, Some(shape_selrect_bounds), None);
        }

        self.surfaces.canvas(target).restore();
        Ok(())
    }

    /// Phase I.2: text path direct-draw rewrite.
    ///
    /// Paints text glyph fills, strokes, drop shadows, and inner shadows
    /// directly onto `target` — no scratch chain, no
    /// `apply_drawing_to_render_canvas` blit. Per-glyph image filters
    /// (drop / inner shadow) are self-contained: each filter generates
    /// shadow pixels from the source paint's alpha (the glyph
    /// coverage), independent of destination state.
    ///
    /// Composition order mirrors legacy `apply_drawing_to_render_canvas`
    /// blit ordering (TextDropShadows → FILLS →
    /// (InnerShadows if `has_fills`) → STROKES →
    /// (InnerShadows if `!has_fills`)):
    ///
    /// 1. text drop shadows (skipped when shape has visible strokes —
    ///    stroke-drop-shadows pass below covers them)
    /// 2. stroke drop shadows
    /// 3. text fills
    /// 4. (if `has_fills`) stroke inner shadows + fill inner shadows —
    ///    BEFORE stroke fills so they appear under strokes
    /// 5. stroke fills (Inner kind via `render_inner_stroke`; others
    ///    via `render_with_bounds_outset`)
    /// 6. (if `!has_fills`) stroke inner shadows + fill inner shadows —
    ///    AFTER stroke fills so they appear over strokes
    fn render_text_into_target(
        &mut self,
        shape: &Shape,
        target: SurfaceId,
    ) -> Result<()> {
        let Type::Text(text_content_orig) = &shape.shape_type else {
            unreachable!("render_text_into_target called with non-Text shape");
        };

        let fast_mode = self.options.is_fast_mode();
        let scale = self.get_scale();
        let translation = self
            .surfaces
            .get_render_context_translation(self.render_area, scale);

        // Per-shape transform centered on shape's center.
        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);

        // Apply per-tile scale+translate + per-shape matrix on target
        // once. Target (Current) is NOT pre-scaled by
        // `update_render_context`, unlike the legacy scratch surfaces.
        {
            let canvas = self.surfaces.canvas_and_mark_dirty(target);
            canvas.save();
            canvas.scale((scale, scale));
            canvas.translate(translation);
            canvas.concat(&matrix);
        }

        let text_content = text_content_orig.new_bounds(shape.selrect());
        let count_inner_strokes = shape.count_visible_inner_strokes();
        let text_fill_inset = (count_inner_strokes > 0).then(|| 1.0 / scale);
        let text_stroke_blur_outset =
            Stroke::max_bounds_width(shape.visible_strokes(), false);
        let mut paragraph_builders = text_content.paragraph_builder_group_from_text(None);
        let stroke_kinds: Vec<StrokeKind> =
            shape.visible_strokes().rev().map(|s| s.kind).collect();
        let (mut stroke_paragraphs_list, stroke_opacities): (Vec<_>, Vec<_>) = shape
            .visible_strokes()
            .rev()
            .map(|stroke| {
                text::stroke_paragraph_builder_group_from_text(
                    &text_content,
                    stroke,
                    &shape.selrect(),
                    None,
                )
            })
            .unzip();

        if fast_mode {
            // Fast path: fills + strokes only, no shadows or blur.
            text::render(
                Some(self),
                None,
                shape,
                &mut paragraph_builders,
                Some(target),
                None,
                None,
                text_fill_inset,
                None,
            )?;

            for (i, (stroke_paragraphs, layer_opacity)) in stroke_paragraphs_list
                .iter_mut()
                .zip(stroke_opacities.iter())
                .enumerate()
            {
                if stroke_kinds[i] == StrokeKind::Inner {
                    let mut mask_builders = text_content.paragraph_builder_group_opaque();
                    let mut fill_builders =
                        text_content.paragraph_builder_group_from_text(None);
                    text::render_inner_stroke(
                        Some(self),
                        None,
                        shape,
                        &mut mask_builders,
                        stroke_paragraphs,
                        &mut fill_builders,
                        Some(target),
                        None,
                        text_stroke_blur_outset,
                        *layer_opacity,
                    )?;
                } else {
                    text::render_with_bounds_outset(
                        Some(self),
                        None,
                        shape,
                        stroke_paragraphs,
                        Some(target),
                        None,
                        None,
                        text_stroke_blur_outset,
                        None,
                        *layer_opacity,
                    )?;
                }
            }
        } else {
            let drop_shadows = shape.drop_shadow_paints();
            let inner_shadows = shape.inner_shadow_paints();
            let blur_filter = shape.image_filter(1.);
            let has_fills = shape.has_fills();
            let has_visible_strokes = shape.has_visible_strokes();
            let mut paragraphs_with_shadows =
                text_content.paragraph_builder_group_from_text(Some(true));
            let (mut stroke_paragraphs_with_shadows_list, _shadow_opacities): (Vec<_>, Vec<_>) =
                shape
                    .visible_strokes()
                    .rev()
                    .map(|stroke| {
                        text::stroke_paragraph_builder_group_from_text(
                            &text_content,
                            stroke,
                            &shape.selrect(),
                            Some(true),
                        )
                    })
                    .unzip();

            // 1. Text drop shadows (skipped if shape has visible strokes
            //    — stroke-drop-shadows pass covers them).
            if !has_visible_strokes {
                for shadow in &drop_shadows {
                    text::render(
                        Some(self),
                        None,
                        shape,
                        &mut paragraphs_with_shadows,
                        Some(target),
                        Some(shadow),
                        blur_filter.as_ref(),
                        None,
                        None,
                    )?;
                }
            }

            // 2. Stroke drop shadows.
            shadows::render_text_shadows(
                self,
                shape,
                &mut paragraphs_with_shadows,
                &mut stroke_paragraphs_with_shadows_list,
                Some(target),
                &drop_shadows,
                &blur_filter,
                &stroke_kinds,
                &text_content,
            )?;

            // 3. Text fills.
            text::render(
                Some(self),
                None,
                shape,
                &mut paragraph_builders,
                Some(target),
                None,
                blur_filter.as_ref(),
                text_fill_inset,
                None,
            )?;

            // 4. Inner shadows BEFORE stroke fills (when has_fills, so
            //    they appear under strokes — matches legacy blit order
            //    InnerShadows-before-STROKES for has_fills=true).
            if has_fills {
                shadows::render_text_shadows(
                    self,
                    shape,
                    &mut paragraphs_with_shadows,
                    &mut stroke_paragraphs_with_shadows_list,
                    Some(target),
                    &inner_shadows,
                    &blur_filter,
                    &stroke_kinds,
                    &text_content,
                )?;
                if !has_visible_strokes {
                    for shadow in &inner_shadows {
                        text::render(
                            Some(self),
                            None,
                            shape,
                            &mut paragraphs_with_shadows,
                            Some(target),
                            Some(shadow),
                            blur_filter.as_ref(),
                            None,
                            None,
                        )?;
                    }
                }
            }

            // 5. Stroke fills.
            for (i, (stroke_paragraphs, layer_opacity)) in stroke_paragraphs_list
                .iter_mut()
                .zip(stroke_opacities.iter())
                .enumerate()
            {
                if stroke_kinds[i] == StrokeKind::Inner {
                    let mut mask_builders = text_content.paragraph_builder_group_opaque();
                    let mut fill_builders =
                        text_content.paragraph_builder_group_from_text(None);
                    text::render_inner_stroke(
                        Some(self),
                        None,
                        shape,
                        &mut mask_builders,
                        stroke_paragraphs,
                        &mut fill_builders,
                        Some(target),
                        blur_filter.as_ref(),
                        text_stroke_blur_outset,
                        *layer_opacity,
                    )?;
                } else {
                    text::render_with_bounds_outset(
                        Some(self),
                        None,
                        shape,
                        stroke_paragraphs,
                        Some(target),
                        None,
                        blur_filter.as_ref(),
                        text_stroke_blur_outset,
                        None,
                        *layer_opacity,
                    )?;
                }
            }

            // 6. Inner shadows AFTER stroke fills (when !has_fills, so
            //    they appear over strokes — matches legacy blit order
            //    InnerShadows-after-STROKES for has_fills=false).
            if !has_fills {
                shadows::render_text_shadows(
                    self,
                    shape,
                    &mut paragraphs_with_shadows,
                    &mut stroke_paragraphs_with_shadows_list,
                    Some(target),
                    &inner_shadows,
                    &blur_filter,
                    &stroke_kinds,
                    &text_content,
                )?;
                if !has_visible_strokes {
                    for shadow in &inner_shadows {
                        text::render(
                            Some(self),
                            None,
                            shape,
                            &mut paragraphs_with_shadows,
                            Some(target),
                            Some(shadow),
                            blur_filter.as_ref(),
                            None,
                            None,
                        )?;
                    }
                }
            }
        }

        self.surfaces.canvas(target).restore();
        Ok(())
    }

    /// Phase C: direct-draw SVGRaw. Renders the parsed SVG DOM (or
    /// parses on-the-fly if not cached) into `target` with the full
    /// per-tile matrix + shape transform + svg_transform composition.
    ///
    /// Caveat: this helper does not write back the parsed DOM cache
    /// (`shape.svg = Some(dom)`) because it takes `&Shape`. The
    /// legacy path did `shape.to_mut().set_svg(dom)` to amortize the
    /// parse cost across re-renders. Re-introducing that cache
    /// requires either an external map (id → Dom) or making this
    /// helper take `Cow<Shape>` / `&mut Shape`. Phase C+1 follow-up.
    fn render_svg_into_target(
        &mut self,
        shape: &Shape,
        target: SurfaceId,
    ) -> Result<()> {
        let Type::SVGRaw(sr) = &shape.shape_type else {
            unreachable!("render_svg_into_target called with non-SVGRaw shape");
        };

        let scale = self.get_scale();
        let translation = self
            .surfaces
            .get_render_context_translation(self.render_area, scale);

        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);
        if let Some(svg_transform) = shape.svg_transform() {
            matrix.pre_concat(&svg_transform);
        }

        let font_manager_opt = if shape.svg.is_none() {
            Some(skia::FontMgr::from(self.fonts().font_provider().clone()))
        } else {
            None
        };

        let canvas = self.surfaces.canvas_and_mark_dirty(target);
        canvas.save();
        canvas.scale((scale, scale));
        canvas.translate(translation);
        canvas.concat(&matrix);

        if let Some(svg) = shape.svg.as_ref() {
            svg.render(canvas);
        } else if let Some(font_manager) = font_manager_opt {
            match skia::svg::Dom::from_str(&sr.content, font_manager) {
                Ok(dom) => dom.render(canvas),
                Err(e) => eprintln!("Error parsing SVG. Error: {}", e),
            }
        }

        canvas.restore();
        Ok(())
    }

/// Phase H.5: clipped-frame strokes helper.
    ///
    /// Direct-draw replacement for `render_shape_exit`'s clipped-frame
    /// strokes pass. Caller passes a stroke-only shape (cleared fills,
    /// cleared shadows, clip_content=false) + the frame's clip stack +
    /// target. No scratch chain. Inner shadows on shape.shadows already
    /// cleared by caller; inner shadows on individual strokes are stored
    /// in shape.shadows (also cleared) so per-stroke inner-shadow pass
    /// is a no-op and is dropped.
    fn render_clipped_strokes_into_target(
        &mut self,
        shape: &Shape,
        clip_bounds: Option<ClipStack>,
        target: SurfaceId,
    ) -> Result<()> {
        let visible_strokes: Vec<&Stroke> = shape.visible_strokes().collect();
        if visible_strokes.is_empty() {
            return Ok(());
        }
        let antialias =
            shape.should_use_antialias(self.get_scale(), self.options.antialias_threshold);

        self.surfaces.canvas(target).save();

        if let Some(clips) = clip_bounds.as_ref() {
            let scale = self.get_scale();
            for (mut bounds, corners, transform) in clips.iter() {
                self.surfaces.canvas(target).concat(&transform);
                let clip_outset = 0.5 / scale;
                bounds.outset((clip_outset, clip_outset));
                if let Some(corners) = corners {
                    let rrect = RRect::new_rect_radii(bounds, corners);
                    self.surfaces.canvas(target).clip_rrect(
                        rrect,
                        skia::ClipOp::Intersect,
                        false,
                    );
                } else {
                    self.surfaces.canvas(target).clip_rect(
                        bounds,
                        skia::ClipOp::Intersect,
                        false,
                    );
                }
                self.surfaces
                    .canvas(target)
                    .concat(&transform.invert().unwrap_or(Matrix::default()));
            }
        }

        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);
        self.surfaces.canvas_and_mark_dirty(target).concat(&matrix);

        strokes::render(
            self,
            shape,
            &visible_strokes,
            Some(target),
            antialias,
            None,
        )?;

        self.surfaces.canvas(target).restore();
        Ok(())
    }

    /// Phase H.4: drop-shadow silhouette helper.
    ///
    /// Direct-draw replacement for the legacy `render_shape` path used by
    /// `render_drop_black_shadow`. Caller passes a `plain_shape` (cleared
    /// shadows/blur, fills/strokes overridden to BLACK), the geometric
    /// `offset` (shadow offset in world coords) and `outset` (shadow
    /// spread). No scratch chain; paints fills + strokes onto `target`
    /// directly under the per-shape transform.
    ///
    /// Mirrors the legacy `render_shape` slow path's non-text/non-SVG
    /// branch with `apply_to_current_surface=false`: no backdrop blur,
    /// no layer-blur layer, no inner shadows.
    fn render_shape_silhouette_into_target(
        &mut self,
        plain_shape: &Shape,
        clip_bounds: Option<ClipStack>,
        offset: (f32, f32),
        outset: f32,
        target: SurfaceId,
    ) -> Result<()> {
        let antialias =
            plain_shape.should_use_antialias(self.get_scale(), self.options.antialias_threshold);

        // Save canvas state — may add clip, transform.
        self.surfaces.canvas(target).save();

        // Apply clip stack (mirrors legacy `render_shape` clipping block).
        if let Some(clips) = clip_bounds.as_ref() {
            let scale = self.get_scale();
            for (mut bounds, corners, transform) in clips.iter() {
                self.surfaces.canvas(target).concat(&transform);
                let clip_outset = 0.5 / scale;
                bounds.outset((clip_outset, clip_outset));
                if let Some(corners) = corners {
                    let rrect = RRect::new_rect_radii(bounds, corners);
                    self.surfaces.canvas(target).clip_rrect(
                        rrect,
                        skia::ClipOp::Intersect,
                        false,
                    );
                } else {
                    self.surfaces.canvas(target).clip_rect(
                        bounds,
                        skia::ClipOp::Intersect,
                        false,
                    );
                }
                self.surfaces
                    .canvas(target)
                    .concat(&transform.invert().unwrap_or(Matrix::default()));
            }
        }

        // Per-shape transform: centered shape.transform + offset translate.
        let center = plain_shape.center();
        let mut matrix = plain_shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);
        matrix.pre_translate(offset);
        self.surfaces.canvas_and_mark_dirty(target).concat(&matrix);

        fills::render(
            self,
            plain_shape,
            &plain_shape.fills,
            antialias,
            target,
            Some(outset),
        )?;

        let visible_strokes: Vec<&Stroke> = plain_shape.visible_strokes().collect();
        if !visible_strokes.is_empty() {
            strokes::render(
                self,
                plain_shape,
                &visible_strokes,
                Some(target),
                antialias,
                Some(outset),
            )?;
        }

        self.surfaces.canvas(target).restore();
        Ok(())
    }

    /// Phase F: text-glyph silhouette helper.
    ///
    /// Renders `shape` (must be `Type::Text`) into `target` as a
    /// drop-shadow silhouette, applying `shadow_paint`'s image_filter
    /// per-glyph (and per-stroke). Caller (typically
    /// `render_element_drop_shadows_and_composite` for text descendants
    /// of a shadowed container) is responsible for the SrcIn-colorize
    /// pass and the outer per-shadow `save_layer` that isolates the
    /// silhouette on `SurfaceId::DropShadows`.
    ///
    /// Replaces the V1 pattern of `render_shape(parent_shadows=Some(...))`
    /// — that arg is now gone. No `nested_*` state read.
    fn render_text_silhouette_into_target(
        &mut self,
        shape: &Shape,
        shadow_paint: &skia::Paint,
        target: SurfaceId,
    ) -> Result<()> {
        let Type::Text(text_content_orig) = &shape.shape_type else {
            unreachable!("render_text_silhouette_into_target called with non-Text shape");
        };

        let text_content = text_content_orig.new_bounds(shape.selrect());
        let blur_filter = shape.image_filter(1.);
        let mut paragraphs = text_content.paragraph_builder_group_from_text(Some(true));

        if !shape.has_visible_strokes() {
            text::render(
                Some(self),
                None,
                shape,
                &mut paragraphs,
                Some(target),
                Some(shadow_paint),
                blur_filter.as_ref(),
                None,
                None,
            )?;
        } else {
            let stroke_kinds: Vec<StrokeKind> =
                shape.visible_strokes().rev().map(|s| s.kind).collect();
            let (mut stroke_paragraphs_list, _opacities): (Vec<_>, Vec<_>) = shape
                .visible_strokes()
                .rev()
                .map(|stroke| {
                    text::stroke_paragraph_builder_group_from_text(
                        &text_content,
                        stroke,
                        &shape.selrect(),
                        Some(true),
                    )
                })
                .unzip();
            let shadows_vec = vec![shadow_paint.clone()];
            shadows::render_text_shadows(
                self,
                shape,
                &mut paragraphs,
                &mut stroke_paragraphs_list,
                Some(target),
                &shadows_vec,
                &blur_filter,
                &stroke_kinds,
                &text_content,
            )?;
        }

        Ok(())
    }


    pub fn cancel_animation_frame(&mut self) {
        if self.render_in_progress {
            if let Some(frame_id) = self.render_request_id {
                wapi::cancel_animation_frame!(frame_id);
            }
        }
    }

    pub fn render_from_cache(&mut self, shapes: ShapesPoolRef) {
        let _start = performance::begin_timed_log!("render_from_cache");
        performance::begin_measure!("render_from_cache");
        let scale = self.get_cached_scale();

        // Check if we have a valid cached viewbox (non-zero dimensions indicate valid cache)
        if self.cached_viewbox.area.width() > 0.0 {
            // Scale and translate the target according to the cached data
            let navigate_zoom = self.viewbox.zoom / self.cached_viewbox.zoom;

            let TileRect(start_tile_x, start_tile_y, _, _) =
                tiles::get_tiles_for_viewbox_with_interest(
                    self.cached_viewbox,
                    VIEWPORT_INTEREST_AREA_THRESHOLD,
                    scale,
                );
            let offset_x = self.viewbox.area.left * self.cached_viewbox.zoom * self.options.dpr();
            let offset_y = self.viewbox.area.top * self.cached_viewbox.zoom * self.options.dpr();
            let translate_x = (start_tile_x as f32 * tiles::TILE_SIZE) - offset_x;
            let translate_y = (start_tile_y as f32 * tiles::TILE_SIZE) - offset_y;
            let bg_color = self.background_color;

            // Setup canvas transform
            {
                let canvas = self.surfaces.canvas(SurfaceId::Target);
                canvas.save();
                canvas.scale((navigate_zoom, navigate_zoom));
                canvas.translate((translate_x, translate_y));
                canvas.clear(bg_color);
            }

            // Draw directly from cache surface, avoiding snapshot overhead
            self.surfaces.draw_cache_to_target();

            // Restore canvas state
            self.surfaces.canvas(SurfaceId::Target).restore();

            if self.options.is_debug_visible() {
                debug::render(self);
            }

            ui::render(self, shapes);
            debug::render_wasm_label(self);

            self.flush_and_submit();
        }
        performance::end_measure!("render_from_cache");
        performance::end_timed_log!("render_from_cache", _start);
    }

    /// Render a preview of the shapes during loading.
    /// This rebuilds tiles for touched shapes and renders synchronously.
    pub fn render_preview(&mut self, tree: ShapesPoolRef, timestamp: i32) -> Result<()> {
        let _start = performance::begin_timed_log!("render_preview");
        performance::begin_measure!("render_preview");

        // Enable fast_mode during preview to skip expensive effects (blur, shadows).
        // Restore the previous state afterward so the final render is full quality.
        let current_fast_mode = self.options.is_fast_mode();
        self.options.set_fast_mode(true);

        // Skip tile rebuilding during preview - we'll do it at the end
        // Just rebuild tiles for touched shapes and render synchronously
        self.rebuild_touched_tiles(tree);

        // Use the sync render path
        self.start_render_loop(None, tree, timestamp, true)?;

        self.options.set_fast_mode(current_fast_mode);

        performance::end_measure!("render_preview");
        performance::end_timed_log!("render_preview", _start);

        Ok(())
    }





    #[inline]
    #[inline]
    pub fn render_shape_enter(
        &mut self,
        element: &Shape,
        target_surface: SurfaceId,
        skip_layer: bool,
    ) {
        // Phase E: masked-group save_layer is now scheduler-emitted
        // via paired `BeginLayer { paint=SrcOver }` (outer) and
        // `BeginLayer { paint=DstIn }` (inner around mask child).
        // render_shape_enter no longer pushes its own layer for
        // masked groups — that would be a triple push for two
        // scheduler restores. The legacy `mask: bool` arg was for V1
        // mask-traversal and is now unused.
        if matches!(element.shape_type, Type::Group(_)) {
            let fills = &element.fills;
            self.nested_fills.push(fills.to_vec());
        }

        if let Type::Frame(_) = element.shape_type {
            self.nested_fills.push(Vec::new());
        }

        // Only create save_layer if actually needed
        // For simple shapes with default opacity and blend mode, skip expensive save_layer
        // Groups with masks need a layer to properly handle the mask rendering
        // V2c.2: when `skip_layer` is true, the scheduler emitted a
        // top-level `BeginLayer` step that already pushed the
        // save_layer for opacity/blend; we must not push it twice.
        let needs_layer = element.needs_layer();

        if needs_layer && !skip_layer {
            let mut paint = skia::Paint::default();
            paint.set_blend_mode(element.blend_mode().into());
            paint.set_alpha_f(element.opacity());

            // Skip frame-level blur in fast mode (pan/zoom)
            if !self.options.is_fast_mode() {
                if let Some(frame_blur) = Self::frame_clip_layer_blur(element) {
                    let scale = self.get_scale();
                    let sigma = radius_to_sigma(frame_blur.value * scale);
                    if let Some(filter) =
                        skia::image_filters::blur((sigma, sigma), None, None, None)
                    {
                        paint.set_image_filter(filter);
                    }
                }
            }

            let layer_rec = skia::canvas::SaveLayerRec::default().paint(&paint);
            self.surfaces.canvas(target_surface).save_layer(&layer_rec);
        }

        self.focus_mode.enter(&element.id);
    }

    #[inline]
    pub fn render_shape_exit(
        &mut self,
        element: &Shape,
        clip_bounds: Option<ClipStack>,
        target_surface: SurfaceId,
        skip_layer: bool,
    ) -> Result<()> {
        // Phase E: V1 `visited_mask` flag dropped. Masked-group
        // restore is now scheduler-emitted via paired `EndLayer`
        // (inner DstIn) + `EndLayer` (outer SrcOver) emitted by
        // `emit_masked_group_steps`. render_shape_exit no longer
        // pops anything for masked groups.

        match element.shape_type {
            Type::Frame(_) | Type::Group(_) => {
                self.nested_fills.pop();
            }
            _ => {}
        }

        //In clipped content strokes are drawn over the contained elements
        if element.clip() {
            let mut element_strokes: Cow<Shape> = Cow::Borrowed(element);
            element_strokes.to_mut().clear_fills();
            element_strokes.to_mut().clear_shadows();
            element_strokes.to_mut().clip_content = false;
            // Frame blur is applied at the save_layer level - avoid double blur on the stroke paint
            if Self::frame_clip_layer_blur(element).is_some() {
                element_strokes.to_mut().set_blur(None);
            }
            // Phase H.5: direct-draw strokes onto target_surface.
            self.render_clipped_strokes_into_target(
                &element_strokes,
                clip_bounds,
                target_surface,
            )?;
        }

        // Only restore if we created a layer (optimization for simple shapes)
        // Groups with masks need restore to properly handle the mask rendering
        // V2c.2: paired with the `skip_layer` gate in `render_shape_enter`.
        let needs_layer = element.needs_layer();

        if needs_layer && !skip_layer {
            self.surfaces.canvas(target_surface).restore();
        }

        self.focus_mode.exit(&element.id);
        Ok(())
    }

    pub fn get_current_tile_bounds(&mut self) -> Result<Rect> {
        let tiles::Tile(tile_x, tile_y) = self
            .current_tile
            .ok_or(Error::CriticalError("Current tile not found".to_string()))?;
        let scale = self.get_scale();
        let offset_x = self.viewbox.area.left * scale;
        let offset_y = self.viewbox.area.top * scale;
        Ok(Rect::from_xywh(
            (tile_x as f32 * tiles::TILE_SIZE) - offset_x,
            (tile_y as f32 * tiles::TILE_SIZE) - offset_y,
            tiles::TILE_SIZE,
            tiles::TILE_SIZE,
        ))
    }

    pub fn get_rect_bounds(&mut self, rect: skia::Rect) -> Rect {
        let scale = self.get_scale();
        let offset_x = self.viewbox.area.left * scale;
        let offset_y = self.viewbox.area.top * scale;
        Rect::from_xywh(
            (rect.left * scale) - offset_x,
            (rect.top * scale) - offset_y,
            rect.width() * scale,
            rect.height() * scale,
        )
    }

    pub fn get_shape_selrect_bounds(&mut self, shape: &Shape) -> Rect {
        let rect = shape.selrect();
        self.get_rect_bounds(rect)
    }

    pub fn get_shape_extrect_bounds(&mut self, shape: &Shape, tree: ShapesPoolRef) -> Rect {
        let scale = self.get_scale();
        let rect = self.get_cached_extrect(shape, tree, scale);
        self.get_rect_bounds(rect)
    }

    pub fn get_aligned_tile_bounds(&mut self, tile: tiles::Tile) -> Rect {
        let scale = self.get_scale();
        let start_tile_x =
            (self.viewbox.area.left * scale / tiles::TILE_SIZE).floor() * tiles::TILE_SIZE;
        let start_tile_y =
            (self.viewbox.area.top * scale / tiles::TILE_SIZE).floor() * tiles::TILE_SIZE;
        Rect::from_xywh(
            (tile.x() as f32 * tiles::TILE_SIZE) - start_tile_x,
            (tile.y() as f32 * tiles::TILE_SIZE) - start_tile_y,
            tiles::TILE_SIZE,
            tiles::TILE_SIZE,
        )
    }

    // Returns the bounds of the current tile relative to the viewbox,
    // aligned to the nearest tile grid origin.
    //
    // Unlike `get_current_tile_bounds`, which calculates bounds using the exact
    // scaled offset of the viewbox, this method snaps the origin to the nearest
    // lower multiple of `TILE_SIZE`. This ensures the tile bounds are aligned
    // with the global tile grid, which is useful for rendering tiles in a
    /// consistent and predictable layout.
    pub fn get_current_aligned_tile_bounds(&mut self) -> Result<Rect> {
        Ok(self.get_aligned_tile_bounds(
            self.current_tile
                .ok_or(Error::CriticalError("Current tile not found".to_string()))?,
        ))
    }

    /// Renders a drop shadow effect for the given shape.
    ///
    /// Creates a black shadow by converting the original shadow color to black,
    /// scaling the blur radius, and rendering the shape with the shadow offset applied.
    #[allow(clippy::too_many_arguments)]
    /// Renders element drop shadows to DropShadows surface and composites to Current.
    /// Used for both normal shadow rendering and pre-layer rendering (frame_clip_layer_blur).
    #[allow(clippy::too_many_arguments)]


    /*
     * Given a shape returns the TileRect with the range of tiles that the shape is in.
     * This is always limited to the interest area to optimize performance and prevent
     * processing unnecessary tiles outside the viewport. The interest area already
     * includes a margin (VIEWPORT_INTEREST_AREA_THRESHOLD) calculated via
     * get_tiles_for_viewbox_with_interest, ensuring smooth pan/zoom interactions.
     *
     * When the viewport changes (pan/zoom), the interest area is updated and shapes
     * are dynamically added to the tile index via the fallback mechanism in
     * render_shape_tree_partial_uncached, ensuring all shapes render correctly.
     */

    /*
     * Given a shape, check the indexes and update it's location in the tile set
     * returns the tiles that have changed in the process.
     */

    /*
     * Incremental version of update_shape_tiles for pan/zoom operations.
     * Updates the tile index and returns ONLY tiles that need cache invalidation.
     *
     * During pan operations, shapes don't move in world coordinates. The interest
     * area (viewport) moves, which changes which tiles we track in the index, but
     * tiles that were already cached don't need re-rendering just because the
     * viewport moved.
     *
     * This function:
     * 1. Updates the tile index (adds/removes shapes from tiles based on interest area)
     * 2. Returns empty vec for cache invalidation (pan doesn't change tile content)
     *
     * Tile cache invalidation only happens when shapes actually move or change,
     * which is handled by rebuild_touched_tiles, not during pan/zoom.
     */

    /*
     * Add the tiles forthe shape to the index.
     * returns the tiles that have been updated
     */


    /// Rebuild the tile index (shape→tile mapping) for all top-level shapes.
    /// This does NOT invalidate the tile texture cache — cached tile images
    /// survive so that fast-mode renders during pan still show shadows/blur.



    /*
     * Rebuild the tiles for the shapes that have been modified from the
     * last time this was executed.
     */

    /// Invalidates extended rectangles and updates tiles for a set of shapes
    ///
    /// This function takes a set of shape IDs and for each one:
    /// 1. Invalidates the extrect cache
    /// 2. Updates the tiles to ensure proper rendering
    ///
    /// This is useful when you have a pre-computed set of shape IDs that need to be refreshed,
    /// regardless of their relationship to other shapes (e.g., ancestors, descendants, or any other collection).

    /// Rebuilds tiles for shapes with modifiers and processes their ancestors
    ///
    /// This function applies transformation modifiers to shapes and updates their tiles.
    /// Additionally, it processes all ancestors of modified shapes to ensure their
    /// extended rectangles are properly recalculated and their tiles are updated.
    /// This is crucial for frames and groups that contain transformed children.

    pub fn get_scale(&self) -> f32 {
        // During export, use the export scale instead of the workspace zoom.
        if let Some((_, export_scale)) = self.export_context {
            return export_scale;
        }
        self.viewbox.zoom() * self.options.dpr()
    }

    pub fn get_cached_scale(&self) -> f32 {
        self.cached_viewbox.zoom() * self.options.dpr()
    }

    pub fn zoom_changed(&self) -> bool {
        (self.viewbox.zoom - self.cached_viewbox.zoom).abs() > f32::EPSILON
    }

    pub fn mark_touched(&mut self, uuid: Uuid) {
        self.touched_ids.insert(uuid);
    }

    #[allow(dead_code)]
    pub fn clean_touched(&mut self) {
        self.touched_ids.clear();
    }

    pub fn get_cached_extrect(&mut self, shape: &Shape, tree: ShapesPoolRef, scale: f32) -> Rect {
        shape.extrect(tree, scale)
    }

    pub fn set_view(&mut self, zoom: f32, x: f32, y: f32) {
        self.viewbox.set_all(zoom, x, y);
    }
}
