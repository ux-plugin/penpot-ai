//! SSA-native shadow renderers.
//!
//! Port status:
//! - Drop shadows: leaf-shape path ported (rect/circle/path/bool).
//!   Frame/group recursive child silhouette draws are TODO.
//! - Fill inner shadows: ported.
//! - Stroke inner shadows: TODO (depends on full strokes port).
//! - Text drop shadows: in `ssa::text::render_drop_shadows`.
//! - Text inner shadows: `render_text_inner_shadows` below.
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
use crate::shapes::{Brush, Shape, Stroke, StrokeKind, Type, WidthProfile};

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

/// Inner shadows for text shapes. The "silhouette" a text shape feeds the
/// inner-shadow filter is its glyph coverage: per shadow, open a
/// `save_layer` whose paint carries `get_inner_shadow_paint` (the
/// `drop_shadow_only ∘ dilate ∘ blend(SrcIn)` chain — it consumes the
/// layer's alpha and emits only the shadow clipped inside it) and render
/// the text into the layer. Same pattern the legacy export path uses in
/// `render::shadows::render_text_shadows`. Called from `ssa::text::render`
/// between noise and strokes, mirroring `render_body_direct`'s
/// fills → noise → inner shadows → strokes order for shapes.
pub fn render_text_inner_shadows(ctx: &mut PaintCtx<'_>, shape: &Shape) {
    let Type::Text(text_content_orig) = &shape.shape_type else {
        return;
    };
    if shape.inner_shadows_visible().next().is_none() {
        return;
    }
    let antialias = shape.should_use_antialias(ctx.scale, ctx.options.antialias_threshold);
    let shadows: Vec<_> = shape.inner_shadows_visible().cloned().collect();

    // Snapshot the transform and build the shadow-source paragraphs BEFORE
    // borrowing the canvas (mirrors `ssa::text::render`). `Some(true)` is
    // the legacy shadow-source variant: span fills are opaque-ised so the
    // filter sees full glyph alpha, but fully-transparent spans keep their
    // alpha — invisible text casts no shadow.
    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let text_content = text_content_orig.new_bounds(shape.selrect());
    let mut shadow_paragraphs = text_content.paragraph_builder_group_from_text(Some(true));

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    for shadow in &shadows {
        let paint = shadow.get_inner_shadow_paint(antialias, shape.image_filter(1.).as_ref());
        canvas.save_layer(&skia::canvas::SaveLayerRec::default().paint(&paint));
        crate::render::text::render_text_on_canvas(
            canvas,
            shape,
            &mut shadow_paragraphs,
            None, // shadow
            None, // blur
            None, // fill_inset
            None, // layer_opacity
        );
        canvas.restore();
    }

    canvas.restore();
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
    draw_drop_silhouette(canvas, shape, paint);
    canvas.restore();
}

/// The variable-width ribbon outline for a ribbon stroke (Power / Texture / a
/// plain stroke carrying width points), or `None` for a plain / pattern stroke.
fn ribbon_for_stroke(stroke: &Stroke, spine: &skia::Path) -> Option<skia::Path> {
    match stroke.brush {
        Some(Brush::Power { profile, nib }) => {
            crate::render::brush::power_ribbon(spine, stroke.width, profile, nib, &stroke.width_points)
        }
        Some(Brush::Texture { .. }) => crate::render::brush::power_ribbon(
            spine,
            stroke.width,
            WidthProfile::Uniform,
            0.0,
            &stroke.width_points,
        ),
        None if stroke.width_points.len() >= 4 => crate::render::brush::power_ribbon(
            spine,
            stroke.width,
            WidthProfile::Uniform,
            0.0,
            &stroke.width_points,
        ),
        _ => None,
    }
}

/// The true painted silhouette of one stroke, as a fillable path: the
/// variable-width RIBBON for a ribbon stroke, otherwise the stroked outline of
/// `geom` honouring width, alignment (inner/center/outer), and dashes — mirroring
/// `draw_inner/outer_stroke_path` (doubled width clipped to the shape). `None`
/// for a zero-width or unstrokeable stroke.
fn stroke_silhouette_path(stroke: &Stroke, geom: &skia::Path, is_open: bool) -> Option<skia::Path> {
    if let Some(ribbon) = ribbon_for_stroke(stroke, geom) {
        return Some(ribbon);
    }
    let w = stroke.width;
    if w <= 0.0 {
        return None;
    }
    let kind = stroke.render_kind(is_open);
    // Inner/outer paint a doubled-width centered band then clip to the shape;
    // center is a plain w-wide band.
    let stroke_w = if matches!(kind, StrokeKind::Center) { w } else { w * 2.0 };
    let mut sp = Paint::default();
    sp.set_style(skia::PaintStyle::Stroke);
    sp.set_stroke_width(stroke_w);
    if !stroke.dashes.is_empty() {
        if let Some(dash) = skia::PathEffect::dash(&stroke.dashes, 0.0) {
            sp.set_path_effect(dash);
        }
    }
    let mut outline = skia::Path::default();
    if !skia::path_utils::fill_path_with_paint(geom, &sp, &mut outline, None, None) {
        return None;
    }
    match kind {
        StrokeKind::Center => Some(outline),
        StrokeKind::Inner => outline.op(geom, skia::PathOp::Intersect),
        StrokeKind::Outer => outline.op(geom, skia::PathOp::Difference),
    }
}

/// Drop-shadow silhouette for any leaf shape: follows what is actually painted —
/// the fill interior only when the shape has a fill (frames always fill their
/// rect, as containers), plus each visible stroke's true shape (ribbon outline,
/// or the aligned/dashed stroke band). This is why a stroke-only shape no longer
/// casts a filled-center shadow and a variable-width stroke's shadow follows the
/// ribbon rather than the vector path — now for rect / circle / frame too.
fn draw_drop_silhouette(canvas: &skia::Canvas, shape: &Shape, paint: &Paint) {
    // Geometry path (+ whether it's an open contour) in the space the current
    // canvas expects, per shape type.
    let geom: Option<(skia::Path, bool)> = match &shape.shape_type {
        Type::Path(_) | Type::Bool(_) => shape.shape_type.path().and_then(|p| {
            shape.to_path_transform().map(|t| {
                let sk = p.to_skia_path(shape.svg_attrs.as_ref()).make_transform(&t);
                (sk, p.is_open())
            })
        }),
        Type::Rect(_) | Type::Frame(_) | Type::Circle => {
            crate::render::strokes::closed_primitive_path(&shape.shape_type, &shape.selrect)
                .map(|p| (p, false))
        }
        _ => None,
    };
    let Some((geom, is_open)) = geom else {
        // Text / other: leave to the geometry silhouette (handled elsewhere).
        draw_silhouette(canvas, shape, paint);
        return;
    };

    // Frames are containers — their rect always casts a shadow even without a
    // fill; other shapes fill only when they actually have a fill.
    let always_fill = matches!(shape.shape_type, Type::Frame(_));
    if always_fill || shape.has_fills() {
        canvas.draw_path(&geom, paint);
    }
    // Each stroke's silhouette is built on the SAME spine the visible render uses,
    // including that stroke's Dynamic (hand-drawn) perturbation — otherwise the
    // shadow follows the un-perturbed vector path instead of the wiggled stroke.
    let seed = crate::render::dynamic::seed_from_bytes(shape.id.as_bytes());
    for stroke in shape.visible_strokes() {
        let spine = match &stroke.dynamic {
            Some(dynamic) => crate::render::dynamic::apply_dynamic(&geom, dynamic, seed),
            None => geom.clone(),
        };
        if let Some(sil) = stroke_silhouette_path(stroke, &spine, is_open) {
            canvas.draw_path(&sil, paint);
        }
    }
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
