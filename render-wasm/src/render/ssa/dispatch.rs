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

use super::{shape_body, PaintCtx};

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
            // TODO(ssa-port::gather)
            Ok(())
        }
        EffectKey::Gather(GatherFx::Glass) => {
            // TODO(ssa-port::glass)
            Ok(())
        }
        EffectKey::Scatter(ScatterFx::DropShadows) => {
            // TODO(ssa-port::shadows)
            Ok(())
        }
        EffectKey::Scatter(ScatterFx::Blit) => {
            // TODO(ssa-port::scatter)
            Ok(())
        }
        EffectKey::Local(LocalFx::LayerBlur) => {
            // TODO(ssa-port::local)
            Ok(())
        }
    }
}
