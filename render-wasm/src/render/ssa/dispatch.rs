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
use crate::shapes::{Shape, Type};
use crate::tile_grid::{EffectKey, GatherFx, LocalFx, ScatterFx};

use super::{gather, local, shadows, shape_body, text, PaintCtx};

/// Route one effect to its renderer. Unported effects are no-ops for
/// now — those scenes render incompletely. The ported set grows as
/// each renderer's body is filled in.
pub fn dispatch_effect(
    ctx: &mut PaintCtx<'_>,
    shape: &Shape,
    effect: EffectKey,
) -> Result<()> {
    match effect {
        EffectKey::Local(LocalFx::ShapeBody) => shape_body::render(ctx, shape),
        // ── Not yet ported — these arms return Ok(()) so the dispatcher
        // can still execute the schedule. Scenes that depend on these
        // effects render with that effect missing until the port lands.
        EffectKey::Gather(GatherFx::BackgroundBlur) => {
            gather::render_background_blur(ctx, shape)
        }
        EffectKey::Gather(GatherFx::Glass) => {
            super::glass::render(ctx, shape)
        }
        EffectKey::Scatter(ScatterFx::DropShadows) => {
            // Text shapes use the glyph-aware shadow path; everything
            // else uses the silhouette path (which now also handles
            // recursive Frame/Group children).
            if matches!(shape.shape_type, Type::Text(_)) {
                text::render_drop_shadows(ctx, shape)
            } else {
                shadows::render_drop_shadows(ctx, shape)
            }
        }
        EffectKey::Scatter(ScatterFx::Blit) => {
            super::scatter::render_blit(ctx, shape)
        }
        EffectKey::Local(LocalFx::LayerBlur) => local::render_layer_blur(ctx, shape),
    }
}
