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

use render_core::kurbo::{Affine, Rect, Shape};
use render_core::peniko::Color;
use render_core::schedule::PaintOp;
use vello_example_scenes::RenderingContext;

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
    ///
    /// Bounded by `RenderingContext` so the seam can express a *clip* once, for both backends —
    /// see [`Self::build_bodies_clipped`].
    type Scene: RenderingContext;

    /// A fresh, empty scene sized `width × height` device pixels, ready to be drawn into.
    fn new_scene(&self, width: u16, height: u16) -> Self::Scene;

    /// Draw a scheduler `Paint` step — a z-ordered run of shape bodies and layer brackets — for the
    /// live document into `scene` at `transform`. Coalescing several plain shapes into one scene is
    /// how a `Paint` becomes a single rasterize.
    fn build_bodies(&mut self, scene: &mut Self::Scene, transform: Affine, ops: &[PaintOp]);

    /// [`Self::build_bodies`], clipped to `clip` — a rect in the **scene's own** pixel space.
    ///
    /// This is what makes it safe to batch several independent surfaces into ONE scene, the way the
    /// sink's atlas prepass does: each surface owns a cell of the atlas, and a shape is only
    /// guaranteed to stay inside its cell if it is clipped to it. Unclipped, anything bigger than a
    /// cell (a board border, a large bake) paints straight through into the neighbouring cells, which
    /// are then copied into the *wrong* surfaces — reproducing that shape one cell away.
    ///
    /// Defaulted in terms of `build_bodies` plus the `RenderingContext` clip both backends already
    /// implement, so no backend has to repeat it.
    fn build_bodies_clipped(
        &mut self,
        scene: &mut Self::Scene,
        transform: Affine,
        ops: &[PaintOp],
        clip: Rect,
    ) {
        // A clip path is captured under whatever transform is current at push time, so pin identity
        // first to express `clip` in raw scene pixels rather than in `transform`'s space.
        scene.set_transform(Affine::IDENTITY);
        scene.push_clip_layer(&clip.to_path(0.1));
        self.build_bodies(scene, transform, ops);
        scene.pop_layer();
    }

    /// Fill exactly one node's silhouette in solid white into `scene` at `transform` — the coverage
    /// mask a gather multiplies into its blurred backdrop so it shows through the shape's outline.
    fn build_mask(&mut self, scene: &mut Self::Scene, transform: Affine, id: u128);

    /// Rasterize `scene` into `target` (a `width × height` texture), clearing to `base_color` first.
    ///
    /// Records into the caller's `enc` and does **not** submit: an effect-heavy frame runs hundreds of
    /// these, and a submit each is a driver round-trip plus a GPU sync point. The sink owns one encoder
    /// per frame and submits once; ordering still holds, since commands in one encoder execute in
    /// order and read-after-write between them is ordered.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn rasterize(
        &mut self,
        scene: &Self::Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
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

    /// Whether this backend can draw an already-rendered surface as an **inline image** inside a scene
    /// being built — the primitive the tile-fuse needs to collapse a tile's plain bodies *and* its
    /// spread effect surfaces into ONE rasterize (instead of a plain render split by every effect
    /// composite). Classic does it via `register_texture` + an `ImageBrush` fill; hybrid has a
    /// different image model and keeps the composite path, so it defaults to `false`.
    fn inline_images_supported(&self) -> bool {
        false
    }

    /// Register `texture` (an `Rgba8Unorm`, `COPY_SRC` surface) for inline drawing this frame, returning
    /// an opaque handle to pass to [`Self::draw_inline_image`]. Paired with [`Self::unregister_inline_image`]
    /// once the scenes that use it have been rasterized. Only called when [`Self::inline_images_supported`].
    fn register_inline_image(&mut self, _texture: &wgpu::Texture) -> u64 {
        0
    }

    /// Draw a previously [`registered`](Self::register_inline_image) surface into `scene`, placing its
    /// whole extent at device-space `dst` (a rect in the scene's own pixels) at `alpha`. 1:1 in size,
    /// mirroring the composite blit it replaces.
    fn draw_inline_image(&mut self, _scene: &mut Self::Scene, _handle: u64, _dst: Rect, _alpha: f32) {}

    /// Release a handle from [`Self::register_inline_image`] after the frame's fused scenes are rendered.
    fn unregister_inline_image(&mut self, _handle: u64) {}

    /// Called once per frame, immediately after the sink submits its encoder.
    ///
    /// A backend that defers recycling while commands are unsubmitted reclaims here. Classic does:
    /// vello's engine holds retired buffers until this point, because returning one to its pool with
    /// commands still unsubmitted lets the next recording overwrite live data. Hybrid needs nothing.
    fn after_submit(&mut self) {}

    /// Whether the sink may record **several** [`Self::rasterize`] calls into one encoder before
    /// submitting (the batching that turns ~1-submit-per-step into ~steps/batch).
    ///
    /// Safe only if a rasterize does not alias GPU state across calls that share a submit. Default is
    /// `false` — the conservative choice for any new backend. vello's classic engine encodes fresh
    /// per-recording buffers into each `Recording`, so it overrides to `true`. vello_hybrid reuses a
    /// **persistent** `view_config` uniform buffer, rewritten via `queue.write_buffer` per render;
    /// since those writes apply at submit time, batching would make every draw in the batch read the
    /// last render's config — so hybrid keeps the default and submits per rasterize.
    fn batched_submits_safe(&self) -> bool {
        false
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
    /// Records into the caller's `enc` and does not submit — the sink submits once per frame.
    /// `target`'s required usages are the backend's business (classic needs `STORAGE_BINDING`; hybrid
    /// renders as an attachment); the sink allocates via the backend so it can set them.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn rasterize(
        &mut self,
        scene: &Self::Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: Color,
    );
}
