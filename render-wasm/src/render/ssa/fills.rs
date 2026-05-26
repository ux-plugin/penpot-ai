//! SSA-native fill renderer — ports `render::fills::render` to
//! `PaintCtx`-based explicit context. Same Skia draw code, just
//! reading context from `ctx` instead of `&mut RenderState`.
//!
//! Port status: STUB. Body fills in incrementally.

use crate::error::Result;
use crate::shapes::{Fill, Shape};

use super::PaintCtx;

/// Render the shape's fills into `ctx.surface`.
///
/// `outset`: extra padding around the shape silhouette (used when
/// strokes need to grow the fill bound). Same as legacy.
pub fn render(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    _fills: &[Fill],
    _antialias: bool,
    _outset: Option<f32>,
) -> Result<()> {
    // TODO(ssa-port): port body of render::fills::render here.
    // For now: no-op so the dispatcher compiles. Will not produce
    // pixels until ported. The legacy `render::fills::render` is
    // still callable via the legacy path for parity reference.
    Ok(())
}
