//! SSA-native fill renderer — ports `render::fills::render` to
//! `PaintCtx`-based explicit context.
//!
//! Port status: **solid-fill rect/circle/path subset**. Image fills,
//! image-filter fills, and nested-fill propagation land as the port
//! progresses. The legacy `render::fills::render` is still callable
//! via the legacy code path for parity reference.

use skia_safe::{self as skia, RRect};

use crate::error::Result;
use crate::shapes::{merge_fills, Fill, Frame, Rect, Shape, Type};

use super::PaintCtx;

/// Render `shape`'s fills into `ctx.surface`. The canvas transform
/// (scale + per-tile world→device translation) is applied here and
/// restored before returning.
pub fn render(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    fills: &[Fill],
    antialias: bool,
    outset: Option<f32>,
) -> Result<()> {
    if fills.is_empty() {
        return Ok(());
    }

    let scale = ctx.scale.max(1e-6);
    let inset = if shape.has_inner_stroke() {
        Some(1.0 / scale)
    } else {
        None
    };

    // Image fills not yet ported — fall through to solid path for
    // non-image fills; image fills produce no output until the port
    // catches up.
    let has_image_fills = fills.iter().any(|f| matches!(f, Fill::Image(_)));
    if has_image_fills {
        // TODO(ssa-port): port draw_image_fill path
        return Ok(());
    }

    let mut paint = merge_fills(fills, shape.selrect);
    paint.set_anti_alias(antialias);

    if shape.image_filter(1.).is_some() {
        // TODO(ssa-port): port image-filter offscreen path
        // (`render_with_filter_surface` equivalent).
        return Ok(());
    }

    draw_fill_to_surface(ctx, shape, &paint, outset, inset);
    Ok(())
}

fn draw_fill_to_surface(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    paint: &skia::Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    let canvas = ctx.surface.canvas();
    canvas.save();
    apply_tile_transform_with_shape(canvas, ctx, shape);

    match &shape.shape_type {
        Type::Rect(_) | Type::Frame(_) => {
            draw_rect(canvas, shape, paint, outset, inset);
        }
        Type::Circle => {
            draw_circle(canvas, shape, paint, outset, inset);
        }
        Type::Path(_) | Type::Bool(_) => {
            draw_path(canvas, shape, paint, outset, inset);
        }
        Type::Group(_) => {}
        _ => {}
    }

    canvas.restore();
}

/// Apply the canvas transform stack the legacy renderer uses:
///   1. scale to device pixels
///   2. translate so world (render_area.origin) is at the content
///      region origin (margin_w/scale, margin_h/scale in scaled coords)
///   3. concat the shape's local transform (center-pivoted)
fn apply_tile_transform_with_shape(canvas: &skia::Canvas, ctx: &PaintCtx<'_>, shape: &Shape) {
    let translation = ctx.tile_translation_device();
    canvas.scale((ctx.scale, ctx.scale));
    canvas.translate(translation);

    let center = shape.center();
    let mut matrix = shape.transform;
    matrix.post_translate(center);
    matrix.pre_translate(-center);
    canvas.concat(&matrix);
}

// ── Per-shape-type draw helpers (replaces Surfaces::draw_rect_to etc.) ──

fn draw_rect(
    canvas: &skia::Canvas,
    shape: &Shape,
    paint: &skia::Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    let mut rect = if let Some(s) = outset.filter(|&s| s > 0.0) {
        let mut r = shape.selrect;
        r.outset((s, s));
        r
    } else {
        shape.selrect
    };
    if let Some(eps) = inset.filter(|&e| e > 0.0) {
        rect.inset((eps, eps));
    }
    if let Some(corners) = shape.shape_type.corners() {
        let corners = if let Some(eps) = inset.filter(|&e| e > 0.0) {
            let mut c = corners;
            for r in c.iter_mut() {
                r.x = (r.x - eps).max(0.0);
                r.y = (r.y - eps).max(0.0);
            }
            c
        } else {
            corners
        };
        let rrect = RRect::new_rect_radii(rect, &corners);
        canvas.draw_rrect(rrect, paint);
    } else {
        canvas.draw_rect(rect, paint);
    }
}

fn draw_circle(
    canvas: &skia::Canvas,
    shape: &Shape,
    paint: &skia::Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    let mut rect = if let Some(s) = outset.filter(|&s| s > 0.0) {
        let mut r = shape.selrect;
        r.outset((s, s));
        r
    } else {
        shape.selrect
    };
    if let Some(eps) = inset.filter(|&e| e > 0.0) {
        rect.inset((eps, eps));
    }
    canvas.draw_oval(rect, paint);
}

fn draw_path(
    canvas: &skia::Canvas,
    shape: &Shape,
    paint: &skia::Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    let _ = (outset, inset); // path outset/inset is a more involved operation; defer
    let Some(path) = shape.shape_type.path() else {
        return;
    };
    let Some(transform) = shape.to_path_transform() else {
        return;
    };
    let sk_path = path.to_skia_path().make_transform(&transform);
    canvas.draw_path(&sk_path, paint);
}

// Silence the unused Frame import — kept for the upcoming image-fill port.
#[allow(dead_code)]
const _: Option<Frame> = None;
#[allow(dead_code)]
const _RECT: Option<Rect> = None;
