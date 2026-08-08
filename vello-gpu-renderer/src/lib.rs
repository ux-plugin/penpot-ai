//! R1 viability spike: `RenderingContext` for classic `vello::Scene`.
//!
//! `scene.rs` (the neutral model → GPU-scene translation) is written against the
//! [`RenderingContext`] trait, not a concrete `Scene`. vello_hybrid and vello_cpu implement it; this
//! proves classic `vello` can too — which is the make-or-break for reusing the whole draw path on a
//! third, compute-based backend (see `render-vello/docs/classic-vello-backend-plan.md`).
//!
//! The trait is *stateful* (`set_transform`, `set_paint`, then `fill_path`); classic `vello::Scene`
//! is *immediate* (`fill(rule, transform, brush, …)`). So this is a wrapper, [`ClassicCtx`], that
//! accumulates the pen state and flushes it on each draw. The core paint path (fills, strokes, paths,
//! rects, layers) maps cleanly; the pieces that are a later slice on classic — text (needs a glifo
//! backend bridging to `draw_glyphs`), blurred-rect drop shadows, filter layers (effects route
//! through our own `run_graph` instead), and external-texture images — are stubbed here and called
//! out as the Phase-2 work items. The spike's job is to show the *shape* holds and compiles.

use glifo::{Glyph, GlyphRun, GlyphRunBackend, GlyphRunBuilder};
use vello::{AaConfig, RenderParams, Renderer, RendererOptions};
use std::ops::RangeInclusive;
use vello_common::filter_effects::Filter;
use vello_common::kurbo::Affine;
use vello_example_scenes::{
    BezPath, BlendMode, Fill, FontData, ImageQuality, Mask, PaintType, Rect, RenderingContext,
    SampleRect, Stroke, TextureId,
};

/// Stateful adapter: a classic `vello::Scene` plus the pen state the immediate-mode API needs
/// supplied per call. One of these is built per surface the sink rasterizes.
pub struct ClassicCtx {
    scene: vello::Scene,
    width: u16,
    height: u16,
    transform: Affine,
    paint_transform: Affine,
    fill_rule: Fill,
    /// Solid paint only, for the spike. A gradient/image paint records `None` and draws nothing —
    /// the full `PaintType` → `peniko` brush mapping is Phase-2 work.
    solid: Option<vello_common::peniko::Color>,
    stroke: Stroke,
}

impl ClassicCtx {
    /// A fresh context over a new `width × height` scene.
    #[must_use]
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            scene: vello::Scene::new(),
            width,
            height,
            transform: Affine::IDENTITY,
            paint_transform: Affine::IDENTITY,
            fill_rule: Fill::NonZero,
            solid: None,
            stroke: Stroke::default(),
        }
    }

    /// The built scene, to hand to `vello::Renderer::render_to_texture`.
    #[must_use]
    pub fn scene(&self) -> &vello::Scene {
        &self.scene
    }

    /// The current solid brush, defaulting to opaque black so a missing/unsupported paint still draws
    /// something visible in the spike rather than nothing.
    fn brush(&self) -> vello_common::peniko::Color {
        self.solid.unwrap_or(vello_common::color::palette::css::BLACK)
    }
}

/// Glyph backend stub. Classic vello draws text through its own skrifa `draw_glyphs`, not a glifo
/// backend, so bridging glifo → classic is its own slice; the spike only needs the type to line up.
pub struct ClassicGlyphBackend<'a> {
    _scene: &'a mut vello::Scene,
}

impl<'a> GlyphRunBackend<'a> for ClassicGlyphBackend<'a> {
    fn atlas_cache(self, _enabled: bool) -> Self {
        self
    }
    fn fill_glyphs<G>(self, _run: GlyphRun<'a>, _glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text: bridge glifo glyph runs to vello::Scene::draw_glyphs (Phase 2)")
    }
    fn stroke_glyphs<G>(self, _run: GlyphRun<'a>, _glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text (Phase 2)")
    }
    fn render_decoration<G>(
        self,
        _run: GlyphRun<'a>,
        _glyphs: G,
        _x_range: RangeInclusive<f32>,
        _baseline_y: f32,
        _offset: f32,
        _size: f32,
        _buffer: f32,
    ) where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text decorations (Phase 2)")
    }
}

impl RenderingContext for ClassicCtx {
    type Resources = ();
    type GlyphRunBackend<'a> = ClassicGlyphBackend<'a>;

    fn width(&self) -> u16 {
        self.width
    }
    fn height(&self) -> u16 {
        self.height
    }

    fn set_transform(&mut self, transform: Affine) {
        self.transform = transform;
    }
    fn set_paint_transform(&mut self, transform: Affine) {
        self.paint_transform = transform;
    }
    fn set_fill_rule(&mut self, fill_rule: Fill) {
        self.fill_rule = fill_rule;
    }
    fn set_paint(&mut self, paint: impl Into<PaintType>) {
        // PaintType is `peniko::Brush<Image, Gradient>`; the spike keeps only the solid case.
        self.solid = match paint.into() {
            vello_common::peniko::Brush::Solid(color) => Some(color),
            _ => None,
        };
    }
    fn set_stroke(&mut self, stroke: Stroke) {
        self.stroke = stroke;
    }

    // Effects do not go through the Scene on classic — the sink runs blur/glass/shadow/custom through
    // our own `run_graph` — so the filter hooks are inert here.
    fn set_filter_effect(&mut self, _filter: Filter) {}
    fn reset_filter_effect(&mut self) {}
    fn push_filter_layer(&mut self, _filter: Filter) {}

    fn fill_path(&mut self, path: &BezPath) {
        let brush = self.brush();
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        self.scene.fill(self.fill_rule, self.transform, brush, pt, path);
    }
    fn stroke_path(&mut self, path: &BezPath) {
        let brush = self.brush();
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        self.scene.stroke(&self.stroke, self.transform, brush, pt, path);
    }
    fn fill_rect(&mut self, rect: &Rect) {
        let brush = self.brush();
        self.scene.fill(self.fill_rule, self.transform, brush, None, rect);
    }

    fn fill_blurred_rounded_rect(&mut self, _rect: &Rect, _radius: f32, _std_dev: f32) {
        // Sparse-strips convenience for drop shadows; on classic these route through our own blur in
        // `run_graph`. Phase 2 either emulates it or drops the call at the sink.
        todo!("classic-vello blurred rounded rect (drop-shadow) — route via run_graph (Phase 2)")
    }

    fn glyph_run<'a>(
        &'a mut self,
        _resources: &'a mut Self::Resources,
        font: &FontData,
    ) -> GlyphRunBuilder<'a, Self::GlyphRunBackend<'a>> {
        let (t, pt) = (self.transform, self.paint_transform);
        GlyphRunBuilder::new(font.clone(), t, pt, ClassicGlyphBackend { _scene: &mut self.scene })
    }

    fn push_clip_layer(&mut self, path: &BezPath) {
        self.scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, self.transform, path);
    }
    fn push_clip_path(&mut self, path: &BezPath) {
        // No standalone clip-path stack on classic; model it as a clip layer.
        self.scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, self.transform, path);
    }
    fn push_layer(
        &mut self,
        clip: Option<&BezPath>,
        blend_mode: Option<BlendMode>,
        alpha: Option<f32>,
        _mask: Option<Mask>,
        _filter: Option<Filter>,
    ) {
        let blend = blend_mode.unwrap_or_default();
        let alpha = alpha.unwrap_or(1.0);
        match clip {
            Some(path) => self.scene.push_layer(Fill::NonZero, blend, alpha, self.transform, path),
            None => {
                // An unclipped layer: clip to a rect large enough to cover any surface, at identity.
                let full = Rect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6);
                self.scene.push_layer(Fill::NonZero, blend, alpha, Affine::IDENTITY, &full);
            }
        }
    }
    fn pop_layer(&mut self) {
        self.scene.pop_layer();
    }
    fn pop_clip_path(&mut self) {
        self.scene.pop_layer();
    }

    fn draw_texture_rects(
        &mut self,
        _texture_id: TextureId,
        _quality: ImageQuality,
        _rects: impl IntoIterator<Item = SampleRect>,
    ) {
        // Externally-bound textures are a hybrid capability (the trait leaks its TextureId/SampleRect
        // here). Classic uploads images through vello's own image path — a later slice; unadvertised.
        unimplemented!("classic-vello external textures are not supported")
    }
}

/// The classic-Vello `SceneRasterizer` (Phase 2, part 1): rasterizes a [`ClassicCtx`]'s scene into a
/// texture via classic vello's compute pipeline. This is the one operation that differs from
/// vello_hybrid — hybrid takes a caller-owned encoder + `TextureBindings`; classic manages its own
/// encoder/submit internally through `render_to_texture`. The target must be `Rgba8Unorm` with
/// `STORAGE_BINDING` set (vello writes it from a compute shader).
pub struct ClassicRenderer {
    inner: Renderer,
}

impl ClassicRenderer {
    /// Build the renderer for a device (compiles the shader permutations).
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        Self { inner: Renderer::new(device, RendererOptions::default()).expect("vello renderer") }
    }

    /// Rasterize `ctx`'s scene into `view` (an `Rgba8Unorm` + `STORAGE_BINDING` texture) over
    /// `base_color`.
    pub fn rasterize(
        &mut self,
        ctx: &ClassicCtx,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        view: &wgpu::TextureView,
        base_color: vello_common::peniko::Color,
    ) {
        let params = RenderParams {
            base_color,
            width: u32::from(ctx.width),
            height: u32::from(ctx.height),
            antialiasing_method: AaConfig::Area,
        };
        self.inner
            .render_to_texture(device, queue, ctx.scene(), view, &params)
            .expect("render_to_texture");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The whole point of the spike: the impl exists and a scene can be driven through the trait
    // exactly as `scene.rs` would, with no GPU. If this compiles and runs, R1's core is proven.
    #[test]
    fn a_scene_can_be_driven_through_the_rendering_context_trait() {
        fn draw<C: RenderingContext>(ctx: &mut C) {
            // A solid rect...
            ctx.set_fill_rule(Fill::NonZero);
            ctx.set_transform(Affine::translate((10.0, 10.0)));
            ctx.set_paint(vello_common::peniko::Brush::Solid(
                vello_common::color::palette::css::REBECCA_PURPLE,
            ));
            ctx.fill_rect(&Rect::new(0.0, 0.0, 40.0, 40.0));
            // ...inside an isolating layer (a group), the PushLayer/PopLayer the schedule emits.
            ctx.push_layer(None, Some(BlendMode::default()), Some(0.5), None, None);
            let mut path = BezPath::new();
            path.move_to((0.0, 0.0));
            path.line_to((30.0, 0.0));
            path.line_to((30.0, 30.0));
            path.close_path();
            ctx.fill_path(&path);
            ctx.pop_layer();
        }

        let mut ctx = ClassicCtx::new(256, 256);
        draw(&mut ctx);
        // A non-empty scene came out the other side.
        assert_eq!(ctx.width(), 256);
        assert!(ctx.scene().encoding().n_paths > 0, "expected encoded paths in the classic scene");
    }

    // The end-to-end pixel proof: build a scene through the trait, rasterize it with classic vello's
    // compute pipeline to a real GPU texture, read it back, and check the pixels. Needs a wgpu device;
    // skipped (not failed) on a machine with no suitable adapter (e.g. CI with no GPU).
    #[test]
    fn classic_vello_rasterizes_our_scene_to_a_texture() {
        let instance = wgpu::Instance::default();
        let Ok(adapter) = pollster::block_on(
            instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
        ) else {
            eprintln!("no wgpu adapter — skipping GPU render proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu spike"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        // 64×64 so bytes-per-row = 64·4 = 256 (already the required 256-byte alignment).
        let (w, h) = (64u32, 64u32);
        let mut ctx = ClassicCtx::new(w as u16, h as u16);
        // A purple square from (16,16) to (48,48) over a white background.
        ctx.set_paint(vello_common::peniko::Brush::Solid(
            vello_common::color::palette::css::REBECCA_PURPLE,
        ));
        ctx.fill_rect(&Rect::new(16.0, 16.0, 48.0, 48.0));

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vello-gpu target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut renderer = ClassicRenderer::new(&device);
        renderer.rasterize(&ctx, &device, &queue, &view, vello_common::color::palette::css::WHITE);

        // Copy the texture into a mappable buffer and read it back.
        let bytes_per_row = w * 4;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(bytes_per_row * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);

        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let data = slice.get_mapped_range();

        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = (y * bytes_per_row + x * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        // Centre (32,32) is inside the square → purple (rebecca purple ≈ #663399).
        let c = px(32, 32);
        assert!(c[0] > 60 && c[0] < 130 && c[2] > 120 && c[1] < 90, "centre should be purple, got {c:?}");
        // A corner (4,4) is background → white.
        let bg = px(4, 4);
        assert!(bg[0] > 240 && bg[1] > 240 && bg[2] > 240, "corner should be white, got {bg:?}");
    }

    /// Copy a texture into a mappable buffer and return its bytes (row-major RGBA8). `w·4` must be a
    /// multiple of 256 (the tests use w=64 → 256).
    fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
        let bpr = w * 4;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(bpr * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        slice.get_mapped_range().to_vec()
    }

    // Phase 1b: the shared device-generic effect executor (render-vello-core) runs on classic vello's
    // OWN wgpu device — proving the classic sink reuses our blur/glass/blit unchanged. Rasterize a
    // sharp square, blur it through run_graph, and confirm the edge bled (soft) rather than a hard step.
    #[test]
    fn classic_device_runs_the_shared_effect_executor() {
        use render_core::effect_graph::background_blur_graph;
        use render_vello_core::blend::{Blit, Compositor};
        use render_vello_core::glass::GlassPipeline;
        use render_vello_core::graph::{lower_graph, run_graph};

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping executor proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu executor"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (64u32, 64u32);
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut ctx = ClassicCtx::new(w as u16, h as u16);
        ctx.set_paint(vello_common::peniko::Brush::Solid(
            vello_common::color::palette::css::REBECCA_PURPLE,
        ));
        ctx.fill_rect(&Rect::new(16.0, 16.0, 48.0, 48.0));

        // The rasterized square: STORAGE_BINDING (vello writes it) + TEXTURE_BINDING (the blur samples it).
        let src = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("rasterized"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
        ClassicRenderer::new(&device).rasterize(
            &ctx,
            &device,
            &queue,
            &src_view,
            vello_common::color::palette::css::WHITE,
        );

        // Blur it with the SHARED executor (our own pipelines) on classic's device.
        let compositor = Compositor::new(&device, format);
        let glass = GlassPipeline::new(&device, format);
        let passes = lower_graph(&background_blur_graph(6.0), None);
        let (_blurred, blurred_view) =
            run_graph(&compositor, &glass, &device, &queue, &[&src_view], &passes, w, h, format)
                .expect("blur produced a texture");

        // Blit the blurred result into a COPY_SRC target to read it back.
        let dst = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("readback-target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        compositor.blit(
            &device,
            &mut enc,
            &dst_view,
            (w as f32, h as f32),
            &Blit {
                src: &blurred_view,
                dst: (0.0, 0.0, w as f32, h as f32),
                src_rect: (0.0, 0.0, w as f32, h as f32),
                src_size: (w as f32, h as f32),
                alpha: 1.0,
            },
        );
        queue.submit([enc.finish()]);

        let data = read_back(&device, &queue, &dst, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        // Centre stays strongly purple (square is 32px wide; 3σ=18 < 16 half-width → centre untouched).
        let c = px(32, 32);
        assert!(c[2] > 110 && c[1] < 120, "blurred centre should stay purple, got {c:?}");
        // 4px OUTSIDE the sharp left edge (x=16): a hard render is pure white here; the blur bleeds
        // purple, pulling green down and leaving blue above green. That delta is the proof it ran.
        let bleed = px(12, 32);
        assert!(bleed[1] < 245 && bleed[2] > bleed[1], "edge should show blur bleed, got {bleed:?}");
    }
}
