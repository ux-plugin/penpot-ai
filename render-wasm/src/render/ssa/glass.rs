//! SSA-native glass effect renderer — full port of the legacy 3-pass
//! glass pipeline.
//!
//! Pipeline matches `render::glass::render_glass_with_backdrop_image`:
//!
//!   1. **Displacement field** — F16 SkSL pass computing per-pixel
//!      refraction vector + specular + mask from the rounded-box SDF
//!      and surface profile (`GLASS_DISPLACEMENT_SKSL`).
//!   2. **Refraction** — applies the displacement + chromatic
//!      aberration to the unblurred backdrop, producing a refracted
//!      image (`GLASS_REFRACTION_SKSL`).
//!   3. **Optional blur** — Skia image filter on the refracted image
//!      (only when `total_blur_sigma > 0.5`).
//!   4. **Composite** — `GLASS_SKSL` blends refracted+blurred + original
//!      backdrop + displacement under frost / specular / mask
//!      (`make_glass_composite_shader`).
//!
//! Differences from the legacy entry point:
//! - The backdrop comes from `ctx.gather_backdrop` — a world-space
//!   fused image at `extent.left/top`. We build a `backdrop_local_matrix`
//!   so the shader sees `backdrop.sample(world_pixel(fragCoord))`.
//! - The output surface is the per-tile pool surface (1024×1024 with
//!   margins). `iw, ih` are the FULL surface dims; the shader runs
//!   over the whole surface but is clipped to the shape's geometry.
//! - All helpers (`render_displacement_pass`, `render_refraction_pass`,
//!   `make_blurred_shader`, `make_glass_composite_shader`, `clip_to_shape`)
//!   are reused as `pub(crate)` from `render::glass` — identical
//!   shader compilations and uniform math, so the SSA path renders
//!   pixel-identical to legacy for the same inputs.

use skia_safe::{self as skia};

use crate::error::Result;
use crate::shapes::{Shape, Type};

use super::PaintCtx;

pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    if ctx.options.is_fast_mode() {
        return Ok(());
    }
    let Some(glass) = shape.glass.as_ref().filter(|g| !g.hidden) else {
        return Ok(());
    };
    let Some((backdrop_img, extent)) = ctx.gather_backdrop.clone() else {
        return Ok(());
    };

    let selrect = shape.selrect;
    if selrect.width() <= 0.0 || selrect.height() <= 0.0 {
        return Ok(());
    }

    let scale = ctx.scale;
    let sampling =
        skia::SamplingOptions::new(skia::FilterMode::Linear, skia::MipmapMode::None);

    // ── Canvas transform setup ──────────────────────────────────────
    // Same math as legacy `render_glass_with_backdrop_image`: build
    // `ctm = scale × translation × local_matrix` and map the shape
    // center through it to get the box center in device pixels.
    let translation = ctx.tile_translation_device();
    let center = shape.center();
    let mut local_matrix = shape.transform;
    local_matrix.post_translate(center);
    local_matrix.pre_translate(-center);

    let mut ctm = skia::Matrix::new_identity();
    ctm.pre_scale((scale, scale), None);
    ctm.pre_translate(translation);
    ctm.pre_concat(&local_matrix);

    let box_center_dev = ctm.map_point((center.x, center.y));
    let box_half_w_dev = selrect.width() * 0.5 * scale;
    let box_half_h_dev = selrect.height() * 0.5 * scale;

    // First corner radius in device pixels (matches legacy behaviour —
    // the displacement pass uses a single radius for all corners).
    let corner_radius_dev: f32 = match &shape.shape_type {
        Type::Rect(data) => data
            .corners
            .as_ref()
            .map(|c| c[0].x * scale)
            .unwrap_or(0.0),
        Type::Frame(data) => data
            .corners
            .as_ref()
            .map(|c| c[0].x * scale)
            .unwrap_or(0.0),
        _ => 0.0,
    };

    // ── Output surface dimensions (the per-tile pool surface) ──────
    let iw = ctx.surface.width();
    let ih = ctx.surface.height();

    // ── Backdrop local matrix ──────────────────────────────────────
    // Output fragCoord (fx, fy) is in device pixels of the pool tile
    // surface. To sample the world-space fused backdrop at the same
    // world point, we need:
    //
    //   world_x        = (fx - margin_w) / scale + world_clip.left
    //   backdrop_pixel = (world_x - extent.left) * scale
    //                  = fx - margin_w + (world_clip.left - extent.left) * scale
    //
    // So the shader needs `backdrop.sample(fragCoord + offset)` with:
    //
    //   offset_x = -margin_w + (world_clip.left - extent.left) * scale
    //
    // Skia's localMatrix is applied INVERSELY at sampling time
    // (`shader.eval(p) = image.sample(p − localMatrix_translate)`),
    // so we pass `translate(−offset)`.
    let margin_w_dev = ctx.margins.width as f32;
    let margin_h_dev = ctx.margins.height as f32;
    let offset_x = -margin_w_dev + (ctx.world_clip.left - extent.left) * scale;
    let offset_y = -margin_h_dev + (ctx.world_clip.top - extent.top) * scale;
    let backdrop_local_matrix = if offset_x == 0.0 && offset_y == 0.0 {
        None
    } else {
        Some(skia::Matrix::translate((-offset_x, -offset_y)))
    };

    // Original (unblurred) backdrop shader — passes through the
    // refraction pass directly; the composite pass also reads it as
    // the un-refracted reference for mask blending.
    let original_shader = match backdrop_img.to_shader(
        (skia::TileMode::Clamp, skia::TileMode::Clamp),
        sampling,
        backdrop_local_matrix.as_ref(),
    ) {
        Some(s) => s,
        None => return Ok(()),
    };

    // ── Pass 1: Displacement field (F16) ───────────────────────────
    let displacement_shader = match crate::render::glass::render_displacement_pass(
        ctx.gpu,
        iw,
        ih,
        box_center_dev,
        box_half_w_dev,
        box_half_h_dev,
        corner_radius_dev,
        glass,
        scale,
    ) {
        Some(s) => s,
        None => return Ok(()),
    };

    // ── Pass 2: Refraction + chromatic aberration ──────────────────
    let refracted_image = match crate::render::glass::render_refraction_pass(
        ctx.gpu,
        iw,
        ih,
        original_shader.clone(),
        displacement_shader.clone(),
        glass,
        scale,
    ) {
        Some(img) => img,
        None => return Ok(()),
    };

    // ── Optional blur of refracted image (matches legacy 0.5 cut-off) ─
    let total_sigma = glass.total_blur_sigma() * scale;
    let blurred_shader = if total_sigma > 0.5 {
        crate::render::glass::make_blurred_shader(
            ctx.gpu,
            &refracted_image,
            total_sigma,
            sampling,
        )
        .unwrap_or_else(|| {
            refracted_image
                .to_shader(
                    (skia::TileMode::Clamp, skia::TileMode::Clamp),
                    sampling,
                    None,
                )
                .unwrap_or_else(|| original_shader.clone())
        })
    } else {
        match refracted_image.to_shader(
            (skia::TileMode::Clamp, skia::TileMode::Clamp),
            sampling,
            None,
        ) {
            Some(s) => s,
            None => return Ok(()),
        }
    };

    // ── Pass 3: Composite (frost + specular + mask blend) ──────────
    let glass_shader = match crate::render::glass::make_glass_composite_shader(
        iw,
        ih,
        glass,
        scale,
        blurred_shader,
        original_shader,
        displacement_shader,
    ) {
        Some(s) => s,
        None => return Ok(()),
    };

    // ── Draw onto the output surface ───────────────────────────────
    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.scale((scale, scale));
    canvas.translate(translation);
    canvas.concat(&local_matrix);

    // Clip to the shape's geometry — uses the same helper the legacy
    // path uses so corner radii / paths / circles render identically.
    crate::render::glass::clip_to_shape(canvas, shape);

    // Reset to device-pixel space so the glass shader (whose uniforms
    // are in device pixels) runs at the correct resolution.
    canvas.reset_matrix();

    let mut paint = skia::Paint::default();
    paint.set_shader(glass_shader);
    // BlendMode::Src — same as legacy. Replaces (does NOT composite)
    // pixels under the glass clip. Subsequent body draws layer on top.
    paint.set_blend_mode(skia::BlendMode::Src);
    canvas.draw_paint(&paint);

    canvas.restore();

    // DEBUG: full glass parameter dump for the trace. Confirms which
    // shape param (frost, specular, blur) is producing the visible
    // result — easy to spot a glass with all defaults at zero.
    let dbg_value = format!(
        "{{\"shape\":{:?},\"tile\":[{},{}],\"sigma_world\":{:.3},\"sigma_dev\":{:.3},\"frost\":{:.3},\"spec_op\":{:.3},\"spec_sat\":{:.3},\"refr_idx\":{:.3},\"thickness\":{:.3},\"selrect\":[{:.1},{:.1},{:.1},{:.1}]}}",
        shape.id.to_string(),
        ctx.tile.x(),
        ctx.tile.y(),
        glass.total_blur_sigma(),
        total_sigma,
        glass.frost,
        glass.specular_opacity,
        glass.specular_saturation,
        glass.refractive_index,
        glass.glass_thickness,
        shape.selrect.left,
        shape.selrect.top,
        shape.selrect.width(),
        shape.selrect.height(),
    );
    crate::render::ssa::debug::event(
        "ssa-glass-params",
        &dbg_value,
        "render/ssa/glass.rs::render",
    );

    Ok(())
}
