//! SSA-native mask group support.
//!
//! Mask groups wrap a container shape: the container's "mask shape"
//! defines an alpha mask that all child shapes' rendering must pass
//! through. Legacy implementation uses a two-pass `save_layer` with
//! `BlendMode::DstIn` — pass 1 draws children, pass 2 draws the mask
//! silhouette over them so only mask-covered pixels survive.
//!
//! Today: TODO(ssa-port::mask-full) — a faithful port needs:
//!   - New IR variants `Step::MaskBegin { mask_shape, write_to }` /
//!     `Step::MaskEnd { write_to }` (or fold into `BeginLayer`).
//!   - Schedule emission: for mask-group root, emit MaskBegin, then
//!     children's Paints, then MaskEnd.
//!   - Production sink handlers that push save_layer + draw mask
//!     silhouette + restore.
//!
//! Until then mask groups render WITHOUT masking — children show
//! through outside the mask region. Visually obvious; tracked here.

use crate::error::Result;
use crate::shapes::Shape;

use super::PaintCtx;

/// Begin a mask scope on the canvas. Stubbed — full impl awaits the
/// IR step variants.
pub fn begin(_ctx: &mut PaintCtx<'_>, _mask_shape: &Shape) -> Result<()> {
    // TODO(ssa-port::mask-full)
    Ok(())
}

/// End the matching mask scope. Stubbed.
pub fn end(_ctx: &mut PaintCtx<'_>, _mask_shape: &Shape) -> Result<()> {
    // TODO(ssa-port::mask-full)
    Ok(())
}
