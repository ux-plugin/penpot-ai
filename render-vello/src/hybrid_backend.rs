//! The **vello_hybrid** implementation of [`RasterBackend`] — the sink's backend seam for this crate.
//!
//! It wraps the two concrete objects the frame owns — the `vello_hybrid::Renderer` and the
//! `AnyScene<Scene>` scene source — and encapsulates everything the hybrid flavor does differently:
//!
//! - **scene building** goes through the `NeutralModelScene` walk, scoped by the `PAINT_BATCH` /
//!   `MASK_ONLY` thread-locals (see [`crate::scene`]). Those globals are a hybrid-only detail; the
//!   classic backend will build the same scenes through the shared [`render_vello_core::draw`] path
//!   instead, so they never leak into the generic sink.
//! - **rasterization** is `Renderer::render` (a clear-and-render; the sink lifts accumulation above
//!   this seam via the shared compositor, so no `render_load` is needed here).
//!
//! Timing is kept where it was — around building and rasterizing — so the profiler overlay reads the
//! same as before the sink was made generic.

use render_core::kurbo::Affine;
use render_core::peniko::Color;
use render_core::schedule::PaintOp;
use render_vello_core::rasterize::RasterBackend;
use vello_example_scenes::AnyScene;
use vello_hybrid::{RenderSize, Renderer, Scene, TextureBindings};

/// Borrows the frame's renderer + scene source for the duration of one [`crate::sink::Sink::execute`].
/// Constructed at the top of the frame and passed by `&mut` into the (now generic) sink.
pub(crate) struct HybridBackend<'a> {
    pub renderer: &'a mut Renderer,
    pub scene_source: &'a mut AnyScene<Scene>,
}

impl RasterBackend for HybridBackend<'_> {
    type Scene = Scene;

    fn new_scene(&self, width: u16, height: u16) -> Scene {
        Scene::new(width, height)
    }

    fn build_bodies(&mut self, scene: &mut Scene, transform: Affine, ops: &[PaintOp]) {
        let _tsc = crate::prof::now();
        crate::scene::set_paint_batch(ops);
        self.scene_source.render(scene, transform);
        crate::scene::clear_paint_batch();
        crate::prof::add_scene(crate::prof::now() - _tsc);
    }

    fn build_mask(&mut self, scene: &mut Scene, transform: Affine, id: u128) {
        crate::scene::set_mask_only(Some(id));
        self.scene_source.render(scene, transform);
        crate::scene::set_mask_only(None);
    }

    fn rasterize(
        &mut self,
        scene: &Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        // Hybrid's `render` always clears to transparent, which is exactly what every sink surface
        // wants; the neutral `base_color` is honored by the classic backend, not needed here.
        _base_color: Color,
    ) {
        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hybrid rasterize") });
        let size = RenderSize { width, height };
        let _trd = crate::prof::now();
        let res = self.renderer.render(
            scene,
            self.scene_source.resources_mut(),
            device,
            queue,
            &mut enc,
            &size,
            target,
            &TextureBindings::new(),
        );
        crate::prof::add_render(crate::prof::now() - _trd);
        crate::prof::inc_render();
        if let Err(e) = res {
            log::warn!("hybrid rasterize skipped: {e:?}");
        }
        let _tsu = crate::prof::now();
        queue.submit([enc.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
    }
}
