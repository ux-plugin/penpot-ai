//! SSA-native shadow renderers.
//!
//! Port status:
//! - Drop shadows: leaf-shape path ported (rect/circle/path/bool).
//!   Frame/group recursive child silhouette draws are TODO.
//! - Fill inner shadows: ported.
//! - Stroke inner shadows: TODO (depends on full strokes port).
//! - Text shadows: TODO (depends on text port).
//!
//! Drop shadow flow:
//!   1. Snapshot transform values BEFORE borrowing scratch canvas.
//!   2. Clear `drop_shadows_scratch` + concat tile+shape transform.
//!   3. For each shadow: `save_layer{paint=drop_shadow_filter}` →
//!      draw black silhouette → `restore`. The filter handles offset,
//!      blur, spread, and colorization.
//!   4. Snapshot scratch content region; composite onto `ctx.surface`.
//!
//! Inner shadow flow (simpler): the filter is applied directly to the
//! draw paint and silhouette is drawn straight onto `ctx.surface`.
//! Matches legacy `render_fill_inner_shadow`.

use skia_safe::{self as skia, Paint, RRect};

use crate::error::Result;
use crate::shapes::{Shape, Stroke, Type};

use super::PaintCtx;

pub fn render_drop_shadows(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    if ctx.options.is_fast_mode() {
        return Ok(());
    }
    if shape.drop_shadows_visible().next().is_none() {
        return Ok(());
    }
    let antialias = shape.should_use_antialias(ctx.scale, ctx.options.antialias_threshold);

    // Snapshot transform + shadows BEFORE borrowing the scratch canvas.
    // The scratch canvas gets the tile transform only; each shape
    // (parent + each recursive child) applies its OWN centered shape
    // transform via a save/concat/restore around its silhouette draw.
    let tile_xform = ctx.tile_transform_matrix();
    let shadows: Vec<_> = shape.drop_shadows_visible().cloned().collect();

    // For Frame/Group with recursive children, gather descendants whose
    // silhouettes should fuse into the same shadow. Matches legacy
    // `get_simplified_children`'s contract (skips flatten-able children
    // by walking into them).
    let recursive_children: Vec<Shape> = match &shape.shape_type {
        Type::Frame(_) | Type::Group(_) if shape.is_recursive() => {
            collect_silhouette_children(ctx, shape)
        }
        _ => Vec::new(),
    };

    // Phase 1: draw all drop shadows into the scratch surface.
    {
        let canvas = ctx.drop_shadows_scratch.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.concat(&tile_xform);

        for shadow in &shadows {
            let Some(filter) = shadow.get_drop_shadow_filter() else {
                continue;
            };
            let mut shadow_paint = Paint::default();
            shadow_paint.set_image_filter(filter);
            shadow_paint.set_anti_alias(antialias);

            let layer_rec = skia::canvas::SaveLayerRec::default().paint(&shadow_paint);
            canvas.save_layer(&layer_rec);

            // The drop_shadow_filter produces colored shadow pixels
            // from the source's alpha; source rgb is unused. Use black
            // so the alpha equals the silhouette.
            let mut silhouette = Paint::default();
            silhouette.set_color(skia::Color::BLACK);
            silhouette.set_anti_alias(antialias);

            // Frame/group: draw the container's own silhouette plus
            // every recursive child's silhouette accumulated into the
            // same save_layer. The single filter then operates on the
            // fused alpha mask. Each shape gets its OWN centered shape
            // transform — selrect is in shape-local coords, not world.
            draw_with_shape_transform(canvas, shape, &silhouette);
            for child in &recursive_children {
                draw_with_shape_transform(canvas, child, &silhouette);
            }

            canvas.restore();
        }

        canvas.restore();
    }

    // Phase 2: composite the scratch's CONTENT REGION onto ctx.surface
    // at the same content origin. Both surfaces share the same layout
    // (1024×1024 with 256-px margins), so we draw with identity matrix.
    let m = ctx.margins;
    let content_rect = skia::IRect::from_xywh(
        m.width,
        m.height,
        crate::tiles::TILE_SIZE as i32,
        crate::tiles::TILE_SIZE as i32,
    );
    if let Some(img) = ctx
        .drop_shadows_scratch
        .image_snapshot_with_bounds(content_rect)
    {
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.draw_image(&img, (m.width as f32, m.height as f32), None);
        canvas.restore();
    }
    Ok(())
}

pub fn render_fill_inner_shadows(ctx: &mut PaintCtx<'_>, shape: &Shape, antialias: bool) {
    if !shape.has_fills() {
        return;
    }
    if shape.inner_shadows_visible().next().is_none() {
        return;
    }
    let shape_xform = ctx.tile_and_shape_transform_matrix(shape);
    let shadows: Vec<_> = shape.inner_shadows_visible().cloned().collect();

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.concat(&shape_xform);
    for shadow in &shadows {
        let paint = shadow.get_inner_shadow_paint(antialias, shape.image_filter(1.).as_ref());
        draw_silhouette(canvas, shape, &paint);
    }
    canvas.restore();
}

/// Stroke inner shadows. Only fires when the shape has no fills (when
/// it has fills the fill inner shadow path handles the silhouette).
/// For each visible inner shadow, draw the stroke with that shadow's
/// filter so the alpha mask carries the inner-shadow look.
pub fn render_stroke_inner_shadows(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    stroke: &Stroke,
    antialias: bool,
) -> Result<()> {
    if shape.has_fills() {
        return Ok(());
    }
    let shadows: Vec<_> = shape.inner_shadows_visible().cloned().collect();
    for shadow in &shadows {
        let filter = shadow.get_inner_shadow_filter();
        super::strokes::render_single(
            ctx,
            shape,
            stroke,
            filter.as_ref(),
            antialias,
            None, // Inner shadows don't use spread
        )?;
    }
    Ok(())
}

pub fn render_text_shadows(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _antialias: bool,
) -> Result<()> {
    // TODO(ssa-port::shadows::text) — depends on text port.
    Ok(())
}

/// Walk a Frame/Group's children (recursively through flatten-able
/// containers) and collect non-hidden, non-text descendants whose
/// silhouettes should fuse with the parent's drop shadow. Mirrors
/// legacy `get_simplified_children` (in `render/v1.rs`) — but returns
/// owned `Shape` clones because the tree's borrow lifetime doesn't
/// match the scratch canvas borrow lifetime.
fn collect_silhouette_children(ctx: &PaintCtx<'_>, parent: &Shape) -> Vec<Shape> {
    let mut out = Vec::new();
    walk_children(ctx, parent, &mut out);
    out
}

fn walk_children(ctx: &PaintCtx<'_>, parent: &Shape, out: &mut Vec<Shape>) {
    for child_id in parent.children_ids_iter(false) {
        let Some(child) = ctx.tree.get(child_id) else {
            continue;
        };
        if child.hidden {
            continue;
        }
        // Text children render via a different path in legacy; for the
        // SSA port we skip text silhouettes for now (text drop shadows
        // are P3's territory and have their own glyph-rendered shadow).
        if matches!(child.shape_type, Type::Text(_)) {
            continue;
        }
        if child.can_flatten() {
            // Flatten-able container — descend into its children
            // without including the container itself.
            walk_children(ctx, child, out);
        } else {
            out.push(child.clone());
        }
    }
}

/// Concat the shape's own centered transform on top of the existing
/// canvas matrix (which carries only the tile transform), then draw
/// the silhouette, then restore. Used for the recursive frame/group
/// path where each child gets its own transform.
fn draw_with_shape_transform(canvas: &skia::Canvas, shape: &Shape, paint: &Paint) {
    let center = shape.center();
    let mut shape_matrix = shape.transform;
    shape_matrix.post_translate(center);
    shape_matrix.pre_translate(-center);
    canvas.save();
    canvas.concat(&shape_matrix);
    draw_silhouette(canvas, shape, paint);
    canvas.restore();
}

/// Draw the shape's silhouette (geometry-only, given paint) on the
/// current canvas. Caller must have already set up the transform.
fn draw_silhouette(canvas: &skia::Canvas, shape: &Shape, paint: &Paint) {
    match &shape.shape_type {
        Type::Rect(_) | Type::Frame(_) => {
            let rect = shape.selrect;
            if let Some(corners) = shape.shape_type.corners() {
                let rrect = RRect::new_rect_radii(rect, &corners);
                canvas.draw_rrect(rrect, paint);
            } else {
                canvas.draw_rect(rect, paint);
            }
        }
        Type::Circle => {
            canvas.draw_oval(shape.selrect, paint);
        }
        Type::Path(_) | Type::Bool(_) => {
            if let Some(path) = shape.shape_type.path() {
                if let Some(transform) = shape.to_path_transform() {
                    let sk_path = path.to_skia_path(shape.svg_attrs.as_ref()).make_transform(&transform);
                    canvas.draw_path(&sk_path, paint);
                }
            }
        }
        _ => {}
    }
}
