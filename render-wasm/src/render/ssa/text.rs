//! SSA-native text renderer.
//!
//! MVP port: handles text fills + inner-strokes (via
//! `text::render_inner_stroke`) + regular strokes. Text-specific drop
//! shadows and layer blur are TODO (they share the legacy
//! `render_text_shadows` path which needs `render_with_filter_surface`
//! support on `PaintCtx`).
//!
//! The bulk of the rendering pipeline (paragraph layout, glyph
//! placement, blur layering, decoration drawing) is reused unchanged
//! from `crate::render::text` via `pub(crate)` helpers — this file is
//! only the thin wrapper that sets up the tile+shape transform on
//! `ctx.surface.canvas()` and forwards to those helpers.

use skia_safe::{self as skia, Paint};

use crate::error::Result;
use crate::render::text;
use crate::shapes::{Shape, Stroke, StrokeKind, Type};

use super::PaintCtx;

pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let Type::Text(text_content_orig) = &shape.shape_type else {
        return Ok(());
    };

    let scale = ctx.scale.max(1e-6);
    let fast_mode = ctx.options.is_fast_mode();

    // Snapshot transform values BEFORE borrowing canvas.
    let xform = ctx.tile_and_shape_transform_matrix(shape);

    let text_content = text_content_orig.new_bounds(shape.selrect());
    let count_inner_strokes = shape.count_visible_inner_strokes();
    let text_fill_inset = (count_inner_strokes > 0).then(|| 1.0 / scale);

    // Build paragraph builders for fills.
    let mut fill_paragraphs = text_content.paragraph_builder_group_from_text(None);

    // Build paragraph builders for each visible stroke (reverse order
    // so the bottom-of-stack stroke draws last → on top).
    let stroke_kinds: Vec<StrokeKind> =
        shape.visible_strokes().rev().map(|s| s.kind).collect();
    let (mut stroke_paragraphs_list, stroke_opacities): (Vec<_>, Vec<_>) = shape
        .visible_strokes()
        .rev()
        .map(|stroke| {
            text::stroke_paragraph_builder_group_from_text(&text_content, stroke, &shape.selrect(), None)
        })
        .unzip();

    // Apply tile+shape transform once on the tile output surface.
    {
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.concat(&xform);

        // Fills pass.
        text::render_text_on_canvas(
            canvas,
            shape,
            &mut fill_paragraphs,
            None,           // shadow
            None,           // blur
            text_fill_inset,
            None,           // layer_opacity
        );

        // Strokes (incl. inner strokes for text).
        if !fast_mode {
            for (i, (stroke_paragraphs, layer_opacity)) in stroke_paragraphs_list
                .iter_mut()
                .zip(stroke_opacities.iter())
                .enumerate()
            {
                if i < stroke_kinds.len() && stroke_kinds[i] == StrokeKind::Inner {
                    let mut mask_builders = text_content.paragraph_builder_group_opaque();
                    let mut fill_builders = text_content.paragraph_builder_group_from_text(None);
                    text::render_inner_stroke(
                        None,
                        Some(canvas),
                        shape,
                        &mut mask_builders,
                        stroke_paragraphs,
                        &mut fill_builders,
                        None,
                        None,
                        0.0,
                        *layer_opacity,
                    )?;
                } else {
                    text::render(
                        None,
                        Some(canvas),
                        shape,
                        stroke_paragraphs,
                        None,
                        None,
                        None,
                        None,
                        *layer_opacity,
                    )?;
                }
            }
        }

        canvas.restore();
    }

    // Suppress unused-warning until text drop shadows are ported.
    let _ = (text_content, fast_mode);
    let _ = Stroke::max_bounds_width(shape.visible_strokes(), false);

    Ok(())
}

/// Text drop shadows: for each visible drop shadow, run the text draw
/// inside a `save_layer { image_filter = drop_shadow_filter }`. Uses the
/// `text_drop_shadows_scratch` so the shadow filter snaps glyphs to
/// shadow pixels independent of the body text on `ctx.surface`.
pub fn render_drop_shadows(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    if ctx.options.is_fast_mode() {
        return Ok(());
    }
    let Type::Text(text_content_orig) = &shape.shape_type else {
        return Ok(());
    };
    if shape.drop_shadows_visible().next().is_none() {
        return Ok(());
    }

    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let text_content = text_content_orig.new_bounds(shape.selrect());
    let shadows: Vec<_> = shape.drop_shadows_visible().cloned().collect();

    // Phase 1: draw each shadow's text into the scratch surface.
    {
        let canvas = ctx.text_drop_shadows_scratch.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.concat(&xform);

        for shadow in &shadows {
            let Some(filter) = shadow.get_drop_shadow_filter() else {
                continue;
            };
            let mut shadow_paint = Paint::default();
            shadow_paint.set_image_filter(filter);

            // Fresh paragraph builder group per shadow — the legacy
            // path doesn't reuse builders across draws.
            let mut paragraphs = text_content.paragraph_builder_group_from_text(None);
            text::render_text_on_canvas(
                canvas,
                shape,
                &mut paragraphs,
                Some(&shadow_paint),
                None, // blur
                None, // fill_inset
                None, // layer_opacity
            );
        }

        canvas.restore();
    }

    // Phase 2: composite scratch's content region onto ctx.surface,
    // same pattern as `shadows::render_drop_shadows`.
    let m = ctx.margins;
    let content_rect = skia::IRect::from_xywh(
        m.width,
        m.height,
        crate::tiles::TILE_SIZE as i32,
        crate::tiles::TILE_SIZE as i32,
    );
    if let Some(img) = ctx
        .text_drop_shadows_scratch
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
