//! SSA-native body composition.
//!
//! Mirrors legacy `RenderState::render_body_direct`: fills + noise +
//! inner shadows + strokes + stroke inner shadows + layer-blur layer.
//!
//! Port status: **fills only**. Strokes, inner shadows, noise,
//! layer-blur, text, svg routes land as those modules port. Until
//! then the SSA dispatcher's ShapeBody arm produces fill-only output;
//! complex shapes degrade to fill silhouette.

use crate::error::Result;
use crate::shapes::{Shape, Type};

use super::{fills, noise, shadows, strokes, PaintCtx};

/// Mirror of `RenderState::render_shape_into_target`'s body-paint
/// path. Routes text/svg to (currently stubbed) helpers, everything
/// else through `render_body_direct`.
pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    // Containers without own visible content paint nothing themselves.
    let empty_container = matches!(shape.shape_type, Type::Group(_) | Type::Frame(_))
        && shape.fills.is_empty()
        && shape.visible_strokes().next().is_none();
    if empty_container {
        return Ok(());
    }

    match &shape.shape_type {
        Type::Text(_) => super::text::render(ctx, shape),
        Type::SVGRaw(_) => super::svg::render(ctx, shape),
        _ => render_body_direct(ctx, shape),
    }
}

/// Direct-draw body: fills (TODO: + strokes + inner shadows + noise +
/// layer blur). For now only the fill pass is wired.
fn render_body_direct(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let antialias = shape.should_use_antialias(ctx.scale, ctx.options.antialias_threshold);

    // 1. Fills
    let fills_vec: Vec<_> = shape.fills.iter().cloned().collect();
    fills::render(ctx, shape, &fills_vec, antialias, None)?;

    // 1b. Noise overlay
    noise::render_shape_noise(ctx, shape);

    // 2. Fill inner shadows
    shadows::render_fill_inner_shadows(ctx, shape, antialias);

    // 3. Strokes
    let stroke_refs: Vec<_> = shape.visible_strokes().collect();
    if !stroke_refs.is_empty() {
        strokes::render(ctx, shape, &stroke_refs, antialias, None)?;
    }

    // 4. Stroke inner shadows (only fires when shape.has_fills() is
    // false — otherwise fill inner shadows already covered the mask).
    if !stroke_refs.is_empty() && !shape.has_fills() {
        for stroke in &stroke_refs {
            shadows::render_stroke_inner_shadows(ctx, shape, stroke, antialias)?;
        }
    }

    Ok(())
}

fn render_text(_ctx: &mut PaintCtx<'_>, _shape: &Shape) -> Result<()> {
    // TODO(ssa-port::text)
    Ok(())
}

fn render_svg(_ctx: &mut PaintCtx<'_>, _shape: &Shape) -> Result<()> {
    // TODO(ssa-port::svg)
    Ok(())
}
