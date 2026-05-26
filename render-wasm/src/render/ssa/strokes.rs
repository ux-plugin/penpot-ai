//! SSA-native stroke renderer. Port status: STUB.

use crate::error::Result;
use crate::shapes::{Shape, Stroke};

use super::PaintCtx;

pub fn render(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _strokes: &[&Stroke],
    _antialias: bool,
    _outset: Option<f32>,
) -> Result<()> {
    // TODO(ssa-port): port body of render::strokes::render here.
    Ok(())
}
