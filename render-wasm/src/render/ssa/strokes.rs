//! SSA-native stroke renderer.
//!
//! Port covers:
//! - Solid/gradient strokes on rect / circle / path (inner/center/outer).
//! - Image strokes (`Fill::Image`) via the SrcIn layer-mask trick.
//! - Merged strokes (multiple share kind/width/style/caps → one draw).
//! - Open-path stroke caps (arrow / triangle / square / round / etc.).
//! - Inner-stroke clipping when stroke width exceeds shape dimension.
//! - Per-stroke shadow filter (used by stroke inner shadows).
//!
//! Reuses legacy `render::strokes::{draw_stroke_on_rect, draw_stroke_on_circle,
//! draw_stroke_on_path, handle_stroke_caps}` (promoted to `pub(crate)`)
//! — the canvas-only helpers don't depend on RenderState so they port 1:1.
//! Only the RenderState-touching pieces (image lookup, sampling) are
//! re-implemented against `PaintCtx`.

use skia_safe::{self as skia, ImageFilter, Paint};

use crate::error::{Error, Result};
use crate::render::{get_dest_rect, get_source_rect};
use crate::render::strokes as legacy;
use crate::shapes::{merge_fills, Fill, ImageFill, Shape, Stroke, StrokeKind, Type};

use super::PaintCtx;

/// Render `strokes` for `shape` into `ctx.surface`.
///
/// Mirrors `render::strokes::render` — picks merged vs per-stroke based
/// on whether they share geometry. Image fills force per-stroke.
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

    let has_image_fills = strokes.iter().any(|s| matches!(s.fill, Fill::Image(_)));
    let can_merge =
        !has_image_fills && strokes.len() > 1 && legacy::strokes_share_geometry(strokes);

    if can_merge {
        render_merged(ctx, shape, strokes, antialias, outset)
    } else {
        for stroke in strokes.iter().rev() {
            render_single(ctx, shape, stroke, None, antialias, outset)?;
        }
        Ok(())
    }
}

/// Render one stroke with an optional shadow filter applied to the
/// paint. Used by `render/ssa/shadows.rs::render_stroke_inner_shadows`
/// to draw each stroke with its shadow filter.
pub fn render_single(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    stroke: &Stroke,
    shadow: Option<&ImageFilter>,
    antialias: bool,
    outset: Option<f32>,
) -> Result<()> {
    // Image strokes go through their own pipeline (no shadow param —
    // image strokes don't carry shadows in legacy either).
    if shadow.is_none()
        && !matches!(shape.shape_type, Type::Text(_))
        && matches!(stroke.fill, Fill::Image(_))
    {
        if let Fill::Image(image_fill) = &stroke.fill {
            return draw_image_stroke(ctx, shape, stroke, image_fill, antialias);
        }
    }

    let scale = ctx.scale;
    let blur = shape.image_filter(1.);
    let selrect = shape.selrect;
    let svg_attrs = shape.svg_attrs.as_ref();
    let path_transform = shape.to_path_transform();
    let xform = ctx.tile_and_shape_transform_matrix(shape);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    let seed = crate::render::dynamic::seed_from_bytes(shape.id.as_bytes());
    legacy::draw_body_stroke(
        canvas,
        &shape.shape_type,
        stroke,
        &selrect,
        svg_attrs,
        path_transform.as_ref(),
        scale,
        shadow,
        blur.as_ref(),
        None,
        outset,
        seed,
        antialias,
    );

    canvas.restore();
    Ok(())
}

/// Merged-strokes path: all strokes share geometry, so we draw once with
/// a paint whose shader is the merged-fill shader.
fn render_merged(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    strokes: &[&Stroke],
    antialias: bool,
    outset: Option<f32>,
) -> Result<()> {
    let representative = *strokes
        .last()
        .expect("render_merged expects at least one stroke");

    let fills: Vec<Fill> = strokes.iter().map(|s| s.fill.clone()).collect();

    let selrect = if let Some(s) = outset.filter(|&s| s > 0.0) {
        let mut r = shape.selrect;
        r.outset((s, s));
        r
    } else {
        shape.selrect
    };

    let merged = merge_fills(&fills, selrect);
    let scale = ctx.scale;
    let svg_attrs = shape.svg_attrs.as_ref();
    let path_transform = shape.to_path_transform();
    let blur = shape.image_filter(1.);
    let xform = ctx.tile_and_shape_transform_matrix(shape);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    let seed = crate::render::dynamic::seed_from_bytes(shape.id.as_bytes());
    legacy::draw_body_stroke(
        canvas,
        &shape.shape_type,
        representative,
        &selrect,
        svg_attrs,
        path_transform.as_ref(),
        scale,
        None,
        blur.as_ref(),
        Some(merged.shader()),
        None,
        seed,
        antialias,
    );

    canvas.restore();
    Ok(())
}

/// Port of `render::strokes::draw_image_stroke_in_container` adapted to
/// `PaintCtx`. Same SrcIn layer-mask approach: paint the stroke shape
/// as a mask, then draw the image with `BlendMode::SrcIn` so only the
/// stroke region survives.
fn draw_image_stroke(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    stroke: &Stroke,
    image_fill: &ImageFill,
    antialias: bool,
) -> Result<()> {
    // Pull everything we need from ctx BEFORE borrowing the canvas.
    let Some(image) = ctx.images.get(&image_fill.id()).cloned() else {
        return Ok(());
    };
    let sampling = ctx.sampling;
    let scale = ctx.scale;
    let size = image.dimensions();
    let container = shape.selrect;
    let path_transform = shape.to_path_transform();
    let svg_attrs = shape.svg_attrs.as_ref();
    let shape_filter = shape.image_filter(1.);
    let xform = ctx.tile_and_shape_transform_matrix(shape);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    // Outer save_layer with shape image filter (if any).
    let mut pb = Paint::default();
    pb.set_blend_mode(skia::BlendMode::SrcOver);
    pb.set_anti_alias(antialias);
    if let Some(filter) = shape_filter.clone() {
        pb.set_image_filter(filter);
    }
    let layer_rec = skia::canvas::SaveLayerRec::default().paint(&pb);
    canvas.save_layer(&layer_rec);

    // Draw the stroke as a mask (filling the stroke region with default paint).
    let outer_rect = stroke.aligned_rect(&container, scale);
    match &shape.shape_type {
        shape_type @ (Type::Rect(_) | Type::Frame(_)) => {
            let paint = stroke.to_paint(&outer_rect, svg_attrs, antialias);
            legacy::draw_stroke_on_rect(
                canvas,
                stroke,
                &container,
                &shape_type.corners(),
                &paint,
                scale,
                None,
                None,
                antialias,
            );
        }
        Type::Circle => {
            let paint = stroke.to_paint(&outer_rect, svg_attrs, antialias);
            legacy::draw_stroke_on_circle(
                canvas, stroke, &container, &paint, scale, None, None, antialias,
            );
        }
        shape_type @ (Type::Path(_) | Type::Bool(_)) => {
            if let Some(p) = shape_type.path() {
                canvas.save();
                let path = p.to_skia_path(svg_attrs).make_transform(
                    &path_transform
                        .ok_or(Error::CriticalError("No path transform".to_string()))?,
                );
                let stroke_kind = stroke.render_kind(p.is_open());
                match stroke_kind {
                    StrokeKind::Inner => {
                        canvas.clip_path(&path, skia::ClipOp::Intersect, antialias);
                    }
                    StrokeKind::Center => {}
                    StrokeKind::Outer => {
                        canvas.clip_path(&path, skia::ClipOp::Difference, antialias);
                    }
                }
                let is_open = p.is_open();
                let paint =
                    stroke.to_stroked_paint(is_open, &outer_rect, svg_attrs, antialias);
                canvas.draw_path(&path, &paint);
                if stroke.render_kind(is_open) == StrokeKind::Outer {
                    let mut thin_paint = paint.clone();
                    thin_paint.set_stroke_width(1. / scale);
                    canvas.draw_path(&path, &thin_paint);
                }
                legacy::handle_stroke_caps(
                    &path,
                    stroke,
                    canvas,
                    is_open,
                    &paint,
                    shape_filter.as_ref(),
                    antialias,
                );
                canvas.restore();
            }
        }
        _ => {}
    }

    // Now draw the image with SrcIn so only the stroke mask region survives.
    let mut image_paint = Paint::default();
    image_paint.set_blend_mode(skia::BlendMode::SrcIn);
    image_paint.set_anti_alias(antialias);
    if let Some(filter) = shape_filter.clone() {
        image_paint.set_image_filter(filter);
    }

    let src_rect = get_source_rect(size, &container, image_fill);
    let dest_rect = get_dest_rect(&container, stroke.delta());

    canvas.clip_rect(dest_rect, skia::ClipOp::Intersect, antialias);
    canvas.draw_image_rect_with_sampling_options(
        &image,
        Some((&src_rect, skia::canvas::SrcRectConstraint::Strict)),
        dest_rect,
        sampling,
        &image_paint,
    );

    // Clear the inner stroke region for outer-kind paths.
    if let Type::Path(p) = &shape.shape_type {
        if stroke.render_kind(p.is_open()) == StrokeKind::Outer {
            let path = p.to_skia_path(svg_attrs).make_transform(
                &path_transform
                    .ok_or(Error::CriticalError("No path transform".to_string()))?,
            );
            let mut clear_paint = Paint::default();
            clear_paint.set_blend_mode(skia::BlendMode::Clear);
            clear_paint.set_anti_alias(antialias);
            canvas.draw_path(&path, &clear_paint);
        }
    }

    canvas.restore(); // save_layer
    canvas.restore(); // outer save + matrix
    Ok(())
}

