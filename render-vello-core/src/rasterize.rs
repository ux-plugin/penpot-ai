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

use render_core::kurbo::Affine;
use render_core::peniko::Color;
use render_core::schedule::PaintOp;

/// The **sink's** full backend seam: everything the GPU production sink ([`crate`]'s scheduler sink)
/// needs from a Vello flavor, so the sink body holds no concrete backend type.
///
/// It bundles the two operations that diverge between backends:
///
/// - **scene building** — turn a scheduler `Paint` step (a z-ordered run of [`PaintOp`]s) or a
///   gather coverage mask into a built scene. The hybrid backend routes this through its
///   `NeutralModelScene` walk (reading the live model + text + modifiers off its ABI globals); the
///   classic backend runs the shared [`crate::draw`] path over its `RenderingContext`. Either way the
///   sink just says *"draw these ops into this scene at this transform"*.
/// - **rasterization** — turn a built scene into pixels in a texture, clearing first (see
///   [`SceneRasterizer`] for why this is deliberately clear-only, with accumulation lifted into the
///   sink via the shared compositor).
///
/// Keeping both behind one trait is what lets the sink be written once: it allocates surfaces, runs
/// the schedule, and composites — all in backend-neutral terms — while each flavor supplies only how
/// a scene is built and rasterized.
pub trait RasterBackend {
    /// The backend's scene type (a `vello_hybrid::Scene`, or the classic `RenderingContext` wrapper).
    type Scene;

    /// A fresh, empty scene sized `width × height` device pixels, ready to be drawn into.
    fn new_scene(&self, width: u16, height: u16) -> Self::Scene;

    /// Draw a scheduler `Paint` step — a z-ordered run of shape bodies and layer brackets — for the
    /// live document into `scene` at `transform`. Coalescing several plain shapes into one scene is
    /// how a `Paint` becomes a single rasterize.
    fn build_bodies(&mut self, scene: &mut Self::Scene, transform: Affine, ops: &[PaintOp]);

    /// Fill exactly one node's silhouette in solid white into `scene` at `transform` — the coverage
    /// mask a gather multiplies into its blurred backdrop so it shows through the shape's outline.
    fn build_mask(&mut self, scene: &mut Self::Scene, transform: Affine, id: u128);

    /// Rasterize `scene` into `target` (a `width × height` texture), clearing to `base_color` first.
    /// Owns its encoder + submit.
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

    /// The [`wgpu::TextureUsages`] a texture must carry for this backend to rasterize into it. Hybrid
    /// renders as an attachment (`RENDER_ATTACHMENT`, the default); classic writes through a compute
    /// pass, so it overrides this with `STORAGE_BINDING`. The sink ORs it into every texture it
    /// rasterizes into — atlases (plus `COPY_SRC`) and surfaces (plus the compositor's own
    /// `RENDER_ATTACHMENT` / `TEXTURE_BINDING` / `COPY_DST`).
    fn rasterize_target_usage(&self) -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT
    }
}

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
