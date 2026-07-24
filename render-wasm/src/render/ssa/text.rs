//! SSA-native text renderer.
//!
//! Handles text fills, noise, inner shadows, inner-strokes (via
//! `text::render_inner_stroke`) and regular strokes. Drop shadows render
//! via `render_drop_shadows` (dispatched as a separate `DropShadows`
//! effect); layer blur wraps the whole body via `Local(LayerBlur)`.
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

        canvas.restore();
    }

    // Noise overlay — same slot in the stack as `render_body_direct` gives
    // every other shape: fills → noise → strokes. (Borrows ctx, so it sits
    // between the two canvas blocks.)
    super::noise::render_text_noise(ctx, shape);

    // Inner shadows — glyph coverage run through the inner-shadow filter,
    // under the strokes (render_body_direct's fills → noise → inner
    // shadows → strokes order; legacy text kept inner shadows before
    // stroke fills for the same stacking).
    super::shadows::render_text_inner_shadows(ctx, shape);

    // Strokes (incl. inner strokes for text).
    if !fast_mode {
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.concat(&xform);

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

        canvas.restore();
    }

    // Suppress unused-warning until text drop shadows are ported.
    let _ = (text_content, fast_mode);
    let _ = Stroke::max_bounds_width(shape.visible_strokes(), false);

    Ok(())
}

/// Draw the text fill glyphs FLAT onto the active canvas — no isolating
/// `save_layer`, the same way `fills::render` draws shape geometry.
///
/// The scatter/texture path needs this. `render_blit` wraps the body in
/// a `save_layer` whose `image_filter` is the displacement map; that
/// filter reads the layer raster as its implicit source. The nested
/// `save_layer` the normal `render`/`draw_text` path opens stops the
/// displacement filter from picking up the glyphs at all (text vanishes
/// at any radius > 0). Painting the glyphs flat — like a shape fill —
/// lets the displacement warp them. Strokes are not handled here yet.
pub fn render_glyphs_flat(ctx: &mut PaintCtx<'_>, shape: &Shape) {
    let Type::Text(text_content_orig) = &shape.shape_type else {
        return;
    };

    // Snapshot the transform BEFORE borrowing the canvas.
    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let text_content = text_content_orig.new_bounds(shape.selrect());
    let mut paragraphs = text_content.paragraph_builder_group_from_text(None);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);
    text::paint_text(canvas, shape, &mut paragraphs);
    canvas.restore();
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
    // See `get_drop_shadow_filter_capped` — bound the kernel to the tile margin
    // so the per-tile filter cost doesn't scale with zoom.
    let max_dev_sigma = ctx.margins.width as f32 / 3.0;
    let scale = ctx.scale;

    // Phase 1: draw each shadow's text into the scratch surface.
    {
        let canvas = ctx.text_drop_shadows_scratch.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.concat(&xform);

        for shadow in &shadows {
            let Some(filter) = shadow.get_drop_shadow_filter_capped(scale, max_dev_sigma) else {
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
