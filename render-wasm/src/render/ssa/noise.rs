//! SSA-native noise renderer.
//!
//! Port of `render::noise::render_shape_noise`. The bulk of the noise
//! pipeline (shader compilation, slot quantile math, blur passes)
//! lives in `render::noise` and is reused via `pub(crate)`-exported
//! helpers. This file is just the thin entry that:
//!
//!   1. Sets up the tile+shape transform on `ctx.surface.canvas()`.
//!   2. Computes the noise parameters from `shape.noise`.
//!   3. Calls the legacy `build_noise_shader` + `draw_noise_pass`
//!      helpers with the prepared canvas.

use skia_safe as skia;

use crate::render::noise::{build_noise_shader, draw_noise_pass, percentile_threshold};
use crate::shapes::{NoiseEffect, Shape, SlotKind, Type, MAX_NOISE_SLOTS};

use super::PaintCtx;

pub fn render_shape_noise(ctx: &mut PaintCtx<'_>, shape: &Shape) {
    let noise = match shape.noise.as_ref() {
        Some(n) if !n.hidden && !n.slots.is_empty() => n,
        _ => return,
    };

    let bounds = shape.selrect();
    let blend_mode = if noise.apply_to_fill {
        skia::BlendMode::SrcATop
    } else {
        skia::BlendMode::SrcOver
    };

    // Snapshot transform BEFORE borrowing canvas.
    let xform = ctx.tile_and_shape_transform_matrix(shape);

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);
    canvas.clip_rect(bounds, skia::ClipOp::Intersect, true);

    draw_noise_passes(canvas, noise, bounds, blend_mode);

    canvas.restore();
}

/// Noise overlay for text shapes — always masked to the glyph coverage.
///
/// Text has no fillable path: the generic renderer's two modes both collapse
/// to the bounding box (`SrcATop` tints everything already painted beneath
/// the box; `SrcOver` covers the whole rect), which reads as "noise on the
/// box", never "noise on the text". The glyphs *are* the shape, so both
/// `apply_to_fill` settings mask to them: draw the noise into an isolated
/// layer and intersect it with an opaque glyph mask via `SrcIn` — the
/// glyph-masking idiom from `render::text::render_inner_stroke_on_canvas`,
/// also used by `ssa::glass`.
pub fn render_text_noise(ctx: &mut PaintCtx<'_>, shape: &Shape) {
    let Type::Text(text_content_orig) = &shape.shape_type else {
        return;
    };
    let noise = match shape.noise.as_ref() {
        Some(n) if !n.hidden && !n.slots.is_empty() => n,
        _ => return,
    };

    let bounds = shape.selrect();

    // Snapshot the transform and build the glyph mask BEFORE borrowing the
    // canvas (mirrors `ssa::text::render`).
    let xform = ctx.tile_and_shape_transform_matrix(shape);
    let text_content = text_content_orig.new_bounds(shape.selrect());
    let mut mask_paragraphs = text_content.paragraph_builder_group_opaque();

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&xform);

    // Isolation layer: the SrcIn pass must composite against the glyph mask
    // only, not the surface beneath.
    canvas.save_layer(&skia::canvas::SaveLayerRec::default());

    // 1. Destination = opaque glyph coverage, drawn with the same transform
    //    as the text body so the mask lines up exactly with the glyphs.
    crate::render::text::render_text_on_canvas(
        canvas,
        shape,
        &mut mask_paragraphs,
        None, // shadow
        None, // blur
        None, // fill_inset
        None, // layer_opacity
    );

    // 2. Source = the noise passes, kept only where the mask has alpha.
    let mut src_in = skia::Paint::default();
    src_in.set_blend_mode(skia::BlendMode::SrcIn);
    canvas.save_layer(&skia::canvas::SaveLayerRec::default().paint(&src_in));
    canvas.clip_rect(bounds, skia::ClipOp::Intersect, true);
    draw_noise_passes(canvas, noise, bounds, skia::BlendMode::SrcOver);
    canvas.restore(); // SrcIn layer

    canvas.restore(); // isolation layer → masked noise composites onto tile
    canvas.restore(); // outer save
}

/// The shared noise pass pipeline: parameter derivation (density →
/// threshold, slot quantile splits, softness → sigma) plus the one- or
/// two-pass shader draw, onto an already transformed-and-clipped canvas.
fn draw_noise_passes(
    canvas: &skia::Canvas,
    noise: &NoiseEffect,
    bounds: skia::Rect,
    blend_mode: skia::BlendMode,
) {
    let size = noise.noise_size.max(1.0);
    let freq = 1.0 / size;
    let density = noise.density.clamp(0.0, 1.0);
    let slot_count = noise.slots.len().clamp(1, MAX_NOISE_SLOTS);

    let target_p_less = if slot_count <= 1 {
        1.0 / (density + 1.0)
    } else {
        1.0 - density
    };
    let threshold = percentile_threshold(target_p_less);

    let (split_1, split_2, split_3) = match slot_count {
        2 => (percentile_threshold(1.0 / 2.0), 0.0, 0.0),
        3 => (percentile_threshold(1.0 / 3.0), percentile_threshold(2.0 / 3.0), 0.0),
        4 => (
            percentile_threshold(1.0 / 4.0),
            percentile_threshold(2.0 / 4.0),
            percentile_threshold(3.0 / 4.0),
        ),
        _ => (0.0, 0.0, 0.0),
    };

    let has_prism = noise.slots.iter().any(|s| s.kind == SlotKind::Prism);
    let has_solid = noise.slots.iter().any(|s| s.kind == SlotKind::Solid);
    let sigma = noise.softness.clamp(0.0, 1.0) * size * 0.6;

    if sigma > 0.0 && has_prism && has_solid {
        if let (Some(prism_mask), Some(prism_color)) = (
            build_noise_shader(
                noise, freq, threshold, split_1, split_2, split_3, slot_count, bounds,
                Some(SlotKind::Prism), false,
            ),
            build_noise_shader(
                noise, freq, threshold, split_1, split_2, split_3, slot_count, bounds,
                Some(SlotKind::Prism), true,
            ),
        ) {
            draw_noise_pass(canvas, prism_mask, Some(prism_color), bounds, blend_mode, sigma);
        }
        if let Some(solid_shader) = build_noise_shader(
            noise, freq, threshold, split_1, split_2, split_3, slot_count, bounds,
            Some(SlotKind::Solid), false,
        ) {
            draw_noise_pass(canvas, solid_shader, None, bounds, blend_mode, 0.0);
        }
    } else {
        let pass_sigma = if has_prism { sigma } else { 0.0 };
        let mask = build_noise_shader(
            noise, freq, threshold, split_1, split_2, split_3, slot_count, bounds, None, false,
        );
        let color = if pass_sigma > 0.0 {
            build_noise_shader(
                noise, freq, threshold, split_1, split_2, split_3, slot_count, bounds, None, true,
            )
        } else {
            None
        };
        if let Some(mask) = mask {
            draw_noise_pass(canvas, mask, color, bounds, blend_mode, pass_sigma);
        }
    }
}
