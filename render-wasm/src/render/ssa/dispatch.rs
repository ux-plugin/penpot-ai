//! SSA-native effect dispatcher.
//!
//! Replaces the legacy `RenderState::scheduler_render_effects` —
//! routes each `EffectKey` to the right SSA-native renderer with an
//! explicit `PaintCtx`.
//!
//! Mirrors the legacy dispatch's variant order; the SSA schedule
//! builder emits effects in the same order so the visual outputs
//! match step-for-step (modulo backward-compat artifacts in the
//! legacy path).

use crate::error::Result;
use crate::shapes::Shape;
use crate::tile_grid::{EffectKey, GatherFx, LocalFx, ScatterFx};

use super::PaintCtx;

/// Route one effect to its renderer.
pub fn dispatch_effect(
    _ctx: &mut PaintCtx<'_>,
    _shape: &Shape,
    effect: EffectKey,
) -> Result<()> {
    match effect {
        EffectKey::Gather(GatherFx::BackgroundBlur) => {
            // TODO(ssa-port): route to render::ssa::gather::render_bg_blur
            Ok(())
        }
        EffectKey::Gather(GatherFx::Glass) => {
            // TODO(ssa-port): route to render::ssa::glass::render
            Ok(())
        }
        EffectKey::Scatter(ScatterFx::DropShadows) => {
            // TODO(ssa-port): route to render::ssa::shadows::render_drop
            Ok(())
        }
        EffectKey::Scatter(ScatterFx::Blit) => {
            // TODO(ssa-port): route to render::ssa::scatter::render_blit
            Ok(())
        }
        EffectKey::Local(LocalFx::ShapeBody) => {
            // TODO(ssa-port): route to render::ssa::shape_body::render
            Ok(())
        }
        EffectKey::Local(LocalFx::LayerBlur) => {
            // TODO(ssa-port): route to render::ssa::local::render_layer_blur
            Ok(())
        }
    }
}
