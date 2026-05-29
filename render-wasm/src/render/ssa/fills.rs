//! SSA-native fill renderer — ports `render::fills::render` to
//! `PaintCtx`-based explicit context.
//!
//! Port status: **solid-fill rect/circle/path subset**. Image fills,
//! image-filter fills, and nested-fill propagation land as the port
//! progresses. The legacy `render::fills::render` is still callable
//! via the legacy code path for parity reference.

use skia_safe::{self as skia, Paint, PathBuilder, RRect};

use crate::error::Result;
// See `render/ssa/strokes.rs` for the `Rect` type story. We don't
// actually use Rect in this file's bodies (only as a dead-code
// placeholder); the placeholder uses `skia::Rect` via the alias.
use crate::math::Rect;
use crate::render::get_source_rect;
use crate::shapes::{merge_fills, Fill, Frame, ImageFill, Shape, Type};

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

    // Image fills get drawn one-by-one (each through draw_image_fill)
    // since they need per-fill clipping and src-rect computation.
    let has_image_fills = fills.iter().any(|f| matches!(f, Fill::Image(_)));
    if has_image_fills {
        for fill in fills.iter().rev() {
            render_single_fill(ctx, shape, fill, antialias, outset, inset)?;
        }
        return Ok(());
    }

    let mut paint = merge_fills(fills, shape.selrect);
    paint.set_anti_alias(antialias);

    if let Some(image_filter) = shape.image_filter(1.) {
        // Inline filter application via save_layer (set_image_filter on
        // a Paint causes skia to allocate its own offscreen and apply
        // the filter on draw). The offscreen perf optimisation helper
        // lives in `render/ssa/filter.rs` but isn't wired here yet —
        // its coord math interacts with `tile_and_shape_transform_matrix`
        // in ways that need pixel-diff validation against legacy
        // before becoming the default.
        paint.set_image_filter(image_filter);
    }

    draw_fill_to_surface(ctx, shape, &paint, outset, inset);
    Ok(())
}

/// Draw one fill (handles `Fill::Image` and solid/gradient).
fn render_single_fill(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    fill: &Fill,
    antialias: bool,
    outset: Option<f32>,
    inset: Option<f32>,
) -> Result<()> {
    let mut paint = fill.to_paint(&shape.selrect, antialias);
    if let Some(image_filter) = shape.image_filter(1.) {
        paint.set_image_filter(image_filter);
    }

    match fill {
        Fill::Image(image_fill) => {
            draw_image_fill(ctx, shape, image_fill, &paint, antialias);
        }
        _ => {
            draw_fill_to_surface(ctx, shape, &paint, outset, inset);
        }
    }
    Ok(())
}

/// Port of legacy `render::fills::draw_image_fill` — clips to the
/// shape's geometry, then `draw_image_rect_with_sampling_options`.
fn draw_image_fill(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    image_fill: &ImageFill,
    paint: &Paint,
    antialias: bool,
) {
    // Pull everything we need from ctx BEFORE borrowing the canvas.
    let Some(image) = ctx.images.get(&image_fill.id()).cloned() else {
        return;
    };
    let sampling = ctx.sampling;
    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let container = shape.selrect;
    let path_transform = shape.to_path_transform();
    let src_rect = get_source_rect(image.dimensions(), &container, image_fill);

    let mut image_paint = skia::Paint::default();
    image_paint.set_anti_alias(antialias);
    if let Some(filter) = shape.image_filter(1.) {
        image_paint.set_image_filter(filter);
    }

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    let layer_rec = skia::canvas::SaveLayerRec::default().paint(&image_paint);
    canvas.save_layer(&layer_rec);

    // Clip to the shape's geometry — image must not bleed outside.
    match &shape.shape_type {
        Type::Rect(crate::shapes::Rect {
            corners: Some(corners),
        })
        | Type::Frame(Frame {
            corners: Some(corners),
            ..
        }) => {
            let rrect = RRect::new_rect_radii(container, corners);
            canvas.clip_rrect(rrect, skia::ClipOp::Intersect, antialias);
        }
        Type::Rect(_) | Type::Frame(_) => {
            canvas.clip_rect(container, skia::ClipOp::Intersect, antialias);
        }
        Type::Circle => {
            let oval_path = {
                let mut pb = PathBuilder::new();
                pb.add_oval(container, None, None);
                pb.detach()
            };
            canvas.clip_path(&oval_path, skia::ClipOp::Intersect, antialias);
        }
        Type::Path(_) | Type::Bool(_) => {
            if let Some(path) = shape.shape_type.path() {
                if let Some(pxf) = path_transform {
                    canvas.clip_path(
                        &path.to_skia_path().make_transform(&pxf),
                        skia::ClipOp::Intersect,
                        antialias,
                    );
                }
            }
        }
        _ => {
            // SVGRaw, Text, Group: fall through without extra clipping.
        }
    }

    canvas.draw_image_rect_with_sampling_options(
        &image,
        Some((&src_rect, skia::canvas::SrcRectConstraint::Strict)),
        container,
        sampling,
        paint,
    );

    canvas.restore(); // save_layer
    canvas.restore(); // save + matrix
}

fn draw_fill_to_surface(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    paint: &skia::Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    // Snapshot the combined tile+shape matrix BEFORE taking the
    // canvas borrow — `ctx.surface.canvas()` reborrows `ctx`, so
    // calling `&self` helpers afterward triggers E0502.
    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let canvas = ctx.surface.canvas();
    canvas.save();
    // `reset_matrix()` is CRITICAL: pool-reused surfaces inherit the
    // matrix from the previous tile's paint. Without resetting,
    // `concat()` compounds onto that leftover, producing a staircase
    // of cumulatively-offset draws across tiles. Legacy
    // `update_render_context` does the same reset for the same reason
    // (see `surfaces.rs::update_render_context`).
    canvas.reset_matrix();
    canvas.concat(&xform);

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
