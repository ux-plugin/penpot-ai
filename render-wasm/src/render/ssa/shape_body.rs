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

use super::{fills, strokes, PaintCtx};

/// Mirror of `RenderState::render_shape_into_target`'s body-paint
/// path. Routes text/svg to (currently stubbed) helpers, everything
/// else through `render_body_direct`.
pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    // Containers without own visible content: nothing to paint.
    if matches!(shape.shape_type, Type::Group(_) | Type::Frame(_))
        && shape.fills.is_empty()
        && shape.visible_strokes().next().is_none()
    {
        return Ok(());
    }

    match &shape.shape_type {
        Type::Text(_) => render_text(ctx, shape),
        Type::SVGRaw(_) => render_svg(ctx, shape),
        _ => render_body_direct(ctx, shape),
    }
}

/// Direct-draw body: fills (TODO: + strokes + inner shadows + noise +
/// layer blur). For now only the fill pass is wired.
fn render_body_direct(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let antialias = shape.should_use_antialias(ctx.scale, ctx.options.antialias_threshold);

    // 1. Fills + noise (noise TODO)
    let fills_vec: Vec<_> = shape.fills.iter().cloned().collect();
    fills::render(ctx, shape, &fills_vec, antialias, None)?;

    // 2. Fill inner shadows — TODO(ssa-port::shadows)

    // 3. Strokes
    let stroke_refs: Vec<_> = shape.visible_strokes().collect();
    if !stroke_refs.is_empty() {
        strokes::render(ctx, shape, &stroke_refs, antialias, None)?;
    }

    // 4. Stroke inner shadows — TODO(ssa-port::shadows)

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
