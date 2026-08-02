use skia_safe::{self as skia, Matrix, RRect, Rect};

use rustc_hash::FxHashSet as HashSet;

use super::gpu_state::GpuState;

use super::options::RenderOptions;
pub use super::surfaces::{SurfaceId, Surfaces};

use super::ui;

use crate::error::{Error, Result};
use crate::performance;
use crate::shapes::{
    radius_to_sigma, Blur, BlurType, Corners, Fill, Shadow, Shape, Type,
};
use crate::state::ShapesPoolRef;
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
#[derive(Clone)]
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

    /// Set (create or replace) an image from a GL framebuffer texture (bottom-left origin).
    /// Overwrites, so a live-rendered source can refresh under a stable id every frame.
    pub fn set_image_from_gl_texture(
        &mut self,
        id: Uuid,
        is_thumbnail: bool,
        texture_id: u32,
        width: i32,
        height: i32,
    ) -> Result<()> {
        self.images
            .set_image_from_gl_texture(id, is_thumbnail, texture_id, width, height)
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

            ui::render(self, shapes);

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

impl Drop for RenderState {
    fn drop(&mut self) {
        self.gpu_state.context.free_gpu_resources();
    }
}
