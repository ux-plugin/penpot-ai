//! Offscreen image-filter perf path for the SSA renderer.
//!
//! Mirrors legacy `render::filters::render_with_filter_surface` adapted
//! to `PaintCtx`. Drives the rendering into `ctx.filter_scratch` with a
//! fit-to-surface downscale so large-blur shapes don't blow up the GPU
//! kernel, then composites the result back to `ctx.surface`.
//!
//! Pattern (matches legacy):
//!   1. Compute world-space bounds = `image_filter.compute_fast_bounds(selrect)`.
//!   2. If bounds fit in `filter_scratch`, use it; otherwise downscale.
//!   3. `draw_fn` runs against `filter_scratch.canvas()` with the
//!      world→filter-surface transform applied. The caller is expected
//!      to draw with a paint that already has `image_filter` set, so the
//!      filter materializes inside the filter surface.
//!   4. Composite filter surface back to `ctx.surface` at world `bounds.left/top`.
//!
//! When this returns `Ok(false)` the caller should fall back to the
//! inline `paint.set_image_filter` path.

use skia_safe::{self as skia};

use crate::error::Result;

use super::PaintCtx;

/// Mirrors legacy `MIN_FIT_SCALE` / `MIN_COMBINED_SCALE` floors so we
/// don't render at sub-pixel scales (would either crash skia or produce
/// visible artifacts).
const MIN_FIT_SCALE: f32 = 0.1;
const MIN_COMBINED_SCALE: f32 = 0.03;

/// Run `draw_fn` against `ctx.filter_scratch` and composite the result
/// onto `ctx.surface`. Returns `Ok(true)` if the offscreen path
/// executed; `Ok(false)` if the caller should fall back to inline
/// filtering (e.g. degenerate bounds).
///
/// `draw_fn` receives the filter-scratch canvas with the tile transform
/// pre-applied — the caller draws in world coordinates, just as it
/// would on `ctx.surface.canvas()`.
pub fn with_filter_surface<F>(
    ctx: &mut PaintCtx<'_>,
    bounds: skia::Rect,
    draw_fn: F,
) -> Result<bool>
where
    F: FnOnce(&skia::Canvas) -> Result<()>,
{
    if !bounds.is_finite() || bounds.width() <= 0.0 || bounds.height() <= 0.0 {
        return Ok(false);
    }

    // Compute the device-space scale: legacy `compute_fast_bounds`
    // returns world coords; the filter surface holds device pixels.
    let device_w = (bounds.width() * ctx.scale).ceil().max(1.0) as i32;
    let device_h = (bounds.height() * ctx.scale).ceil().max(1.0) as i32;

    let (filter_w, filter_h) = {
        let img_info = ctx.filter_scratch.image_info();
        (img_info.width(), img_info.height())
    };

    let fit_scale = if device_w > filter_w || device_h > filter_h {
        let sx = filter_w as f32 / device_w as f32;
        let sy = filter_h as f32 / device_h as f32;
        sx.min(sy).max(MIN_FIT_SCALE)
    } else {
        1.0
    };
    let combined_scale = (fit_scale).max(MIN_COMBINED_SCALE);
    let total_scale = ctx.scale * combined_scale;

    // Prepare the filter surface — clear, translate so world `bounds.left/top`
    // lands at filter-surface (0, 0), and scale so 1 world unit → `total_scale`
    // filter-pixel units.
    {
        let canvas = ctx.filter_scratch.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.scale((total_scale, total_scale));
        canvas.translate((-bounds.left, -bounds.top));
        let result = draw_fn(canvas);
        canvas.restore();
        result?;
    }

    // Composite filter surface back to ctx.surface. We have to inverse
    // the scale/translate so the filter pixels land at world `bounds.left/top`.
    // Snapshot the tile-transform BEFORE borrowing the canvas (otherwise
    // the immutable `ctx.tile_transform_matrix()` call collides with the
    // active mutable `ctx.surface.canvas()` borrow).
    let tile = ctx.tile_transform_matrix();
    let sampling = ctx.sampling;
    let snapshot = ctx.filter_scratch.image_snapshot();
    {
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.reset_matrix();
        canvas.concat(&tile);
        canvas.scale((1.0 / combined_scale, 1.0 / combined_scale));
        canvas.translate((bounds.left * combined_scale, bounds.top * combined_scale));
        canvas.draw_image_with_sampling_options(
            &snapshot,
            (0.0, 0.0),
            sampling,
            None,
        );
        canvas.restore();
    }

    Ok(true)
}
