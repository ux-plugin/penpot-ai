//! SSA-native stroke renderer.
//!
//! Port status: solid-fill stroke on rect / circle / path. The
//! following advanced paths are **not yet ported** and produce no
//! output when encountered:
//!
//! - Image strokes (`Fill::Image`)
//! - Strokes with shape-level blur or shadow
//! - Merged strokes (multiple strokes with shared geometry fused
//!   into one draw call)
//! - Path stroke caps (arrow / triangle / square cap rendering for
//!   open paths)
//!
//! The legacy `render::strokes::render` still handles these paths;
//! the SSA renderer will pick them up port by port.

use skia_safe::{self as skia, Paint, RRect};

use crate::error::Result;
use crate::shapes::{Corners, Fill, Rect, Shape, Stroke, StrokeKind, Type};

use super::PaintCtx;

/// Render `strokes` for `shape` into `ctx.surface`.
pub fn render(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    strokes: &[&Stroke],
    antialias: bool,
    outset: Option<f32>,
) -> Result<()> {
    if strokes.is_empty() {
        return Ok(());
    }

    // Skip advanced paths for now.
    if strokes.iter().any(|s| matches!(s.fill, Fill::Image(_))) {
        return Ok(());
    }
    if shape.image_filter(1.).is_some() {
        return Ok(());
    }

    let scale = ctx.scale;

    let canvas = ctx.surface.canvas();
    canvas.save();
    ctx.apply_tile_and_shape_transform(canvas, shape);

    let selrect = shape.selrect;
    let svg_attrs = shape.svg_attrs.as_ref();

    for stroke in strokes.iter().rev() {
        match &shape.shape_type {
            shape_type @ (Type::Rect(_) | Type::Frame(_)) => {
                let paint = stroke.to_paint(&selrect, svg_attrs, antialias);
                draw_stroke_on_rect(
                    canvas,
                    stroke,
                    &selrect,
                    &shape_type.corners(),
                    &paint,
                    scale,
                    None,
                    None,
                    antialias,
                );
            }
            Type::Circle => {
                let paint = stroke.to_paint(&selrect, svg_attrs, antialias);
                draw_stroke_on_circle(canvas, stroke, &selrect, &paint, scale, antialias);
            }
            shape_type @ (Type::Path(_) | Type::Bool(_)) => {
                if let Some(path) = shape_type.path() {
                    let is_open = path.is_open();
                    let mut paint =
                        stroke.to_stroked_paint(is_open, &selrect, svg_attrs, antialias);
                    if let Some(s) = outset.filter(|&s| s > 0.0) {
                        let current_width = paint.stroke_width();
                        let outset_growth = match stroke.render_kind(is_open) {
                            StrokeKind::Center => s * 2.0,
                            StrokeKind::Inner | StrokeKind::Outer => s * 4.0,
                        };
                        paint.set_stroke_width(current_width + outset_growth);
                    }
                    if let Some(transform) = shape.to_path_transform() {
                        let sk_path = path.to_skia_path().make_transform(&transform);
                        canvas.draw_path(&sk_path, &paint);
                    }
                }
            }
            _ => {}
        }
    }

    canvas.restore();
    Ok(())
}

// ── Duplicated draw helpers from legacy `render::strokes` ──
// Bodies are verbatim copies; the legacy private originals remain
// untouched for the legacy run_schedule path. Deletion = `git rm
// render/strokes.rs` once the full port is done.

#[allow(clippy::too_many_arguments)]
fn draw_stroke_on_rect(
    canvas: &skia::Canvas,
    stroke: &Stroke,
    rect: &Rect,
    corners: &Option<Corners>,
    paint: &Paint,
    scale: f32,
    shadow: Option<&skia::ImageFilter>,
    blur: Option<&skia::ImageFilter>,
    antialias: bool,
) {
    let stroke_rect = stroke.aligned_rect(rect, scale);
    let mut paint = paint.clone();

    let filter = crate::render::filters::compose_filters(blur, shadow);
    paint.set_image_filter(filter);

    let draw_stroke = || match corners {
        Some(radii) => {
            let radii = stroke.outer_corners(radii);
            let rrect = RRect::new_rect_radii(stroke_rect, &radii);
            canvas.draw_rrect(rrect, &paint);
        }
        None => {
            canvas.draw_rect(stroke_rect, &paint);
        }
    };

    if let Some(clip_op) = stroke.clip_op() {
        let layer_rec = skia::canvas::SaveLayerRec::default();
        canvas.save_layer(&layer_rec);
        match corners {
            Some(radii) => {
                let rrect = RRect::new_rect_radii(*rect, radii);
                canvas.clip_rrect(rrect, clip_op, antialias);
            }
            None => {
                canvas.clip_rect(*rect, clip_op, antialias);
            }
        }
        draw_stroke();
        canvas.restore();
    } else if stroke.kind == StrokeKind::Inner
        && (stroke.width >= rect.width() || stroke.width >= rect.height())
    {
        canvas.save();
        match corners {
            Some(radii) => {
                let rrect = RRect::new_rect_radii(*rect, radii);
                canvas.clip_rrect(rrect, skia::ClipOp::Intersect, antialias);
            }
            None => {
                canvas.clip_rect(*rect, skia::ClipOp::Intersect, antialias);
            }
        }
        let mut inner_paint = paint.clone();
        inner_paint.set_stroke_width(stroke.width * 2.0);
        match corners {
            Some(radii) => {
                let rrect = RRect::new_rect_radii(*rect, radii);
                canvas.draw_rrect(rrect, &inner_paint);
            }
            None => {
                canvas.draw_rect(*rect, &inner_paint);
            }
        }
        canvas.restore();
    } else {
        draw_stroke();
    }
}

fn draw_stroke_on_circle(
    canvas: &skia::Canvas,
    stroke: &Stroke,
    rect: &Rect,
    paint: &Paint,
    scale: f32,
    antialias: bool,
) {
    let stroke_rect = stroke.aligned_rect(rect, scale);
    let _ = antialias;
    canvas.draw_oval(stroke_rect, paint);
}
