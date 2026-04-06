use super::{RenderState, SurfaceId};
use crate::shapes::{noise::render_noise, Shape};

/// Render the noise effect for a shape onto the fills surface.
pub fn render_shape_noise(render_state: &mut RenderState, shape: &Shape, surface_id: SurfaceId) {
    let noise = match shape.noise.as_ref() {
        Some(n) if !n.hidden => n,
        _ => return,
    };

    let bounds = shape.selrect();
    let canvas = render_state.surfaces.canvas_and_mark_dirty(surface_id);
    render_noise(canvas, noise, &bounds);
}
