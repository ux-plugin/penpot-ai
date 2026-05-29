//! SSA-native local effects — for now just layer blur. Mirrors
//! `render::local` (which uses a per-shape image cache and a 2-step
//! schedule). The SSA variant is simpler: one save_layer with a blur
//! `ImageFilter` wrapping the shape body draw — Skia's GPU blur is
//! fast enough that the per-shape pre-cache isn't worth the schedule
//! complexity until perf says otherwise.

use skia_safe::{self as skia, Paint};

use crate::error::Result;
use crate::shapes::{BlurType, Shape};

use super::{shape_body, PaintCtx};

/// `Local(LayerBlur)` effect — wraps the body draw in a save_layer
/// with a Gaussian blur applied at compose. Falls back to plain body
/// render if the shape has no qualifying layer blur (fast_mode, no
/// blur, hidden, wrong blur_type).
pub fn render_layer_blur(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let Some(blur) = shape.blur else {
        return shape_body::render(ctx, shape);
    };
    if blur.hidden || ctx.options.is_fast_mode() {
        return shape_body::render(ctx, shape);
    }
    if !matches!(blur.blur_type, BlurType::LayerBlur) {
        return shape_body::render(ctx, shape);
    }

    let sigma = blur.sigma();
    if sigma <= 0.0 {
        return shape_body::render(ctx, shape);
    }
    let Some(filter) = skia::image_filters::blur((sigma, sigma), None, None, None) else {
        return shape_body::render(ctx, shape);
    };

    let mut paint = Paint::default();
    paint.set_image_filter(filter);

    {
        let canvas = ctx.surface.canvas();
        let layer_rec = skia::canvas::SaveLayerRec::default().paint(&paint);
        canvas.save_layer(&layer_rec);
    }

    shape_body::render(ctx, shape)?;

    {
        let canvas = ctx.surface.canvas();
        canvas.restore();
    }
    Ok(())
}
