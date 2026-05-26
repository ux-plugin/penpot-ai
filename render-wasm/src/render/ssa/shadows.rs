//! SSA-native shadow renderers. Port status: STUB.

use crate::error::Result;
use crate::shapes::{Shape, Stroke};

use super::PaintCtx;

pub fn render_fill_inner_shadows(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _antialias: bool,
) {
}

pub fn render_stroke_inner_shadows(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _stroke: &Stroke,
    _antialias: bool,
) -> Result<()> {
    Ok(())
}

pub fn render_text_shadows(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _antialias: bool,
) -> Result<()> {
    Ok(())
}
