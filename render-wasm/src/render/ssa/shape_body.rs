//! SSA-native body composition. Port status: STUB.
//!
//! Mirrors legacy `RenderState::render_shape_into_target` →
//! `render_body_direct`: fills + noise + inner shadows + strokes +
//! stroke inner shadows + layer-blur isolation layer.

use crate::error::Result;
use crate::shapes::Shape;

use super::PaintCtx;

pub fn render(_ctx: &mut PaintCtx<'_>, _shape: &Shape) -> Result<()> {
    // TODO(ssa-port): port render_body_direct.
    Ok(())
}
