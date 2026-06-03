//! SSA-native gather effect renderer (BackgroundBlur).
//!
//! Consumes the `gather_backdrop` field of `PaintCtx` (a `(skia::Image,
//! world_extent_rect)` pair populated by the `paint_gather` handler in
//! `production_sink.rs`). Mirrors `render::render_state::render_background_blur_from_image`
//! with the source surface translation rewritten in terms of the
//! per-tile `world_origin` carried on `PaintCtx`.
//!
//! Flow:
//!   1. Build a clamped-sigma blur image filter from the shape's
//!      `background_blur` params.
//!   2. Apply `scale * tile_translation * shape_centered_transform` to
//!      the target canvas so the clip path lands at the right world
//!      position.
//!   3. Clip to the shape's geometry (rect / rrect / circle / path).
//!   4. Reset matrix and draw the backdrop image at its world extent
//!      origin (mapped through the same translation) with the blur
//!      filter applied. `BlendMode::Src` so the clip replaces (not
//!      composites over) existing content.

use skia_safe::{self as skia, RRect};

use crate::error::Result;
use crate::shapes::{radius_to_sigma, Frame, Rect, Shape, Type};

use super::PaintCtx;

/// Render the gather's BackgroundBlur effect into `ctx.surface`. No-op
/// when there is no backdrop attached to the ctx (mis-emitted schedule)
/// or no background blur on the shape.
pub fn render_background_blur(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    if ctx.options.is_fast_mode() {
        return Ok(());
    }
    if matches!(shape.shape_type, Type::Text(_)) || matches!(shape.shape_type, Type::SVGRaw(_)) {
        return Ok(());
    }
    let Some(blur) = shape.background_blur.filter(|b| !b.hidden) else {
        return Ok(());
    };
    let Some((backdrop_img, extent)) = ctx.gather_backdrop.clone() else {
        return Ok(());
    };

    let scale = ctx.scale;
    let scaled_sigma = radius_to_sigma(blur.value * scale);
    // Cap sigma so the 3σ kernel stays inside the tile margin — same
    // rationale as legacy v2 path.
    let margin_w = ctx.margins.width as f32;
    let max_sigma = (margin_w / 3.0).max(1.0);
    let sigma = scaled_sigma.min(max_sigma);

    let Some(blur_filter) =
        skia::image_filters::blur((sigma, sigma), skia::TileMode::Clamp, None, None)
    else {
        return Ok(());
    };

    // Tile-space translation: same `tile_translation_device()` PaintCtx
    // already builds. Apply scale + translate + shape transform so clip
    // path maps from shape-local to device pixels.
    let translation = ctx.tile_translation_device();
    let center = shape.center();
    let mut matrix = shape.transform;
    matrix.post_translate(center);
    matrix.pre_translate(-center);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.scale((scale, scale));
    canvas.translate(translation);
    canvas.concat(&matrix);

    // Clip to shape geometry.
    match &shape.shape_type {
        Type::Rect(Rect {
            corners: Some(corners),
        })
        | Type::Frame(Frame {
            corners: Some(corners),
            ..
        }) => {
            let rrect = RRect::new_rect_radii(shape.selrect, corners);
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

    // Reset matrix so we can place the backdrop image at exact device
    // pixels. The clip survives reset_matrix (stored in device coords).
    canvas.reset_matrix();

    // Image origin: top-left of `extent` in DEVICE pixels on this
    // surface. Same `(world_point + translation) * scale` mapping
    // legacy v2 uses for Current-equivalent surfaces. Keep sub-pixel
    // (no `.round()`) so adjacent tiles' bg-blur draws align — rounding
    // independently can put neighbor draws 1 device pixel apart.
    let img_x = (extent.left + translation.x) * scale;
    let img_y = (extent.top + translation.y) * scale;

    let mut paint = skia::Paint::default();
    paint.set_image_filter(blur_filter);
    // SrcOver (not Src) so the blurred backdrop composites on top of
    // the body content already on this surface, instead of replacing
    // it (which would expose backdrop transparent edges and erase
    // the body where the backdrop is empty).
    paint.set_blend_mode(skia::BlendMode::SrcOver);
    canvas.draw_image(&backdrop_img, (img_x, img_y), Some(&paint));

    canvas.restore();
    Ok(())
}
