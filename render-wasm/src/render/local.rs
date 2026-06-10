//! Layer-blur cache-qualification predicate.
//!
//! Originally a full V2c.1 leaf layer-blur cache implementation. The
//! cache + per-tile blit lived here; the rest of `render/local.rs` was
//! deleted in Phase B of the legacy-deletion plan (V2 orchestrator
//! cut). What remains is the qualification predicate used by
//! `tile_grid::paint_plan_for_shape` to decide whether a shape's body
//! qualifies for the `LocalFx::LayerBlur` effect dispatch — SSA's
//! `render::ssa::local::render_layer_blur` does the actual work.

use crate::shapes::{BlurType, Shape, Type};

/// Returns `true` when `shape` is a leaf with a non-trivial layer-blur
/// effect that the SSA layer-blur path should handle. Returns `false`
/// for shapes outside scope (SVG, inner shadows, no blur, hidden
/// blur, zero sigma, scatter/glass/bg-blur which use their own
/// pipelines).
pub fn shape_qualifies_for_layer_blur_cache(shape: &Shape) -> bool {
    // SVG: blur is handled inside the SVG DOM render path, not via
    // save_layer. Text *does* qualify — `ssa::local::render_layer_blur`
    // wraps the glyph body (`ssa::text::render`) in the blur save_layer
    // just like any other leaf shape.
    if matches!(shape.shape_type, Type::SVGRaw(_)) {
        return false;
    }

    if shape
        .blur
        .filter(|b| !b.hidden && b.blur_type == BlurType::LayerBlur && b.value > 0.0)
        .is_none()
    {
        return false;
    }

    // Inner shadows + scatter + glass + bg-blur each want their own
    // cache plumbing; the leaf layer-blur fast path keeps out.
    if shape.inner_shadows_visible().next().is_some() {
        return false;
    }
    if shape
        .texture
        .as_ref()
        .is_some_and(|t| !t.hidden && t.radius > 0.0)
    {
        return false;
    }
    if shape.glass.as_ref().is_some_and(|g| !g.hidden) {
        return false;
    }
    if shape.background_blur.is_some_and(|b| !b.hidden) {
        return false;
    }

    true
}
