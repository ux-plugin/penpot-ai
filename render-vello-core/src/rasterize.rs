//! The `SceneRasterizer` seam — the *one* operation that differs between Vello backends.
//!
//! Everything else the sink needs is already shared: the schedule (render-core), the tile cache /
//! atlas / effect-graph policy (render-core), and the device-generic effect executor ([`crate::blend`]
//! / [`crate::glass`] / [`crate::graph`]). What a backend must still supply is how it turns a built
//! scene into pixels in a texture:
//!
//! - **vello_hybrid**: `Renderer::render(scene, resources, device, queue, &mut encoder, size, view,
//!   bindings)` — the caller owns the encoder, and a second write to the same target can *load*
//!   (accumulate) rather than clear.
//! - **classic vello**: `Renderer::render_to_texture(device, queue, scene, view, &RenderParams)` —
//!   it owns its encoder/submit, and **always clears to `base_color`** (there is no load variant).
//!
//! That load-vs-clear difference is the real design point of the sink carve: the hybrid sink relies
//! on `render_load` to accumulate several paints into one tile surface, which classic cannot do — on
//! classic a tile's content is rendered as one scene (the scheduler's coalescing already batches most
//! of it) and anything that must layer on top is composited through [`crate::blend`], not loaded. The
//! trait therefore deliberately exposes only a *clear-and-render* rasterize; accumulation is the
//! sink's job, above this seam, using the shared compositor — so both backends express it the same
//! way.

use render_core::peniko::Color;

/// Turns a backend scene (built via the shared `RenderingContext` draw path) into pixels in a target
/// texture. Implemented once per Vello flavor; the sink is generic over it.
pub trait SceneRasterizer {
    /// The backend's scene-building type — a `vello_hybrid::Scene` or the classic wrapper. It also
    /// implements `RenderingContext` (so `scene.rs` can draw into it), but this trait does not need to
    /// know that: it only rasterizes an already-built scene.
    type Scene;

    /// A fresh, empty scene sized `width × height` device pixels, ready to be drawn into.
    fn new_scene(&self, width: u16, height: u16) -> Self::Scene;

    /// Rasterize `scene` into `target` (a `width × height` texture), clearing to `base_color` first.
    ///
    /// The implementation owns its encoder + submit. `target`'s required usages are the backend's
    /// business (classic needs `STORAGE_BINDING`; hybrid renders as an attachment); the sink allocates
    /// via the backend so it can set them.
    fn rasterize(
        &mut self,
        scene: &Self::Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: Color,
    );
}
