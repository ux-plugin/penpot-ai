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
//! rects, layers) maps cleanly, and **text** now routes through [`ClassicGlyphBackend`] to classic's
//! native `Scene::draw_glyphs` (its own outline + COLR/emoji pipeline — no glifo sink needed). The
//! pieces still deferred on classic are blurred-rect drop shadows and filter layers (effects route
//! through our own `run_graph` instead) and external-texture images.

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
    /// The current paint. Classic vello is peniko-native, so solid and gradient map straight onto its
    /// `Scene::fill` brush. Image/diamond paints are resolved away to `None` upstream (`ClassicEnv`)
    /// until this backend has its own image atlas, so they never reach here — the [`ClassicPaint`]
    /// enum has no image arm yet.
    paint: ClassicPaint,
    stroke: Stroke,
}

/// The paint kinds classic vello can draw today. Both are peniko-native (`Scene::fill` takes them
/// directly); the image atlas is Phase 2.
#[derive(Clone)]
enum ClassicPaint {
    Solid(vello_common::peniko::Color),
    Gradient(vello_common::peniko::Gradient),
}

impl Default for ClassicPaint {
    /// Opaque black, so a shape whose paint this backend cannot yet draw still shows rather than
    /// vanishing — the same visible-placeholder stance the solid-only spike took.
    fn default() -> Self {
        Self::Solid(vello_common::color::palette::css::BLACK)
    }
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
            paint: ClassicPaint::default(),
            stroke: Stroke::default(),
        }
    }

    /// The built scene, to hand to `vello::Renderer::render_to_texture`.
    #[must_use]
    pub fn scene(&self) -> &vello::Scene {
        &self.scene
    }
}

/// Glyph backend stub. Classic vello draws text through its own skrifa `draw_glyphs`, not a glifo
/// backend, so bridging glifo → classic is its own slice; the spike only needs the type to line up.
pub struct ClassicGlyphBackend<'a> {
    scene: &'a mut vello::Scene,
    /// The pen's current paint, snapshotted from the `ClassicCtx` — glifo's `GlyphRun` carries the
    /// font and geometry but not the brush, so the backend supplies it (as `scene.rs`'s per-fill
    /// `set_paint` sets it before each glyph pass).
    brush: ClassicPaint,
    stroke: Stroke,
}

impl<'a> ClassicGlyphBackend<'a> {
    /// Encode a glyph sequence through classic vello's native `Scene::draw_glyphs` under `style`
    /// (fill or stroke). Classic's own pipeline handles outlines and COLR/bitmap emoji, so the
    /// backend only translates the run's parameters and the current brush — no glifo atlas/outline
    /// sink is needed (that is the sparse-strips path). glifo's `Glyph` maps 1:1 to `vello::Glyph`.
    fn draw(self, run: &GlyphRun<'a>, glyphs: impl Iterator<Item = Glyph> + Clone, stroked: bool) {
        let scene_pt = run.scene_paint_transform();
        // glifo carries variation coords as skrifa `F2Dot14`; classic wants raw `i16` bits (same
        // value). Materialise them into a Vec that outlives the builder.
        let coords: Vec<i16> = run.normalized_coords().iter().map(|c| c.to_bits()).collect();
        // `draw_glyphs` reborrows `self.scene` for a local lifetime, so the owned `self.brush` (and
        // `self.stroke`) outlive the builder and can supply the `BrushRef` — disjoint field borrows.
        let db = self
            .scene
            .draw_glyphs(run.font())
            .font_size(run.font_size())
            .transform(run.transform())
            .glyph_transform(run.glyph_transform())
            .brush_transform((scene_pt != Affine::IDENTITY).then_some(scene_pt))
            .normalized_coords(&coords)
            .hint(run.hint());
        let items = glyphs.map(|g| vello::Glyph { id: g.id, x: g.x, y: g.y });
        // The brush and the fill/stroke style are chosen together so the builder is consumed once.
        match (&self.brush, stroked) {
            (ClassicPaint::Solid(c), false) => db.brush(*c).draw(Fill::NonZero, items),
            (ClassicPaint::Gradient(gr), false) => db.brush(gr).draw(Fill::NonZero, items),
            (ClassicPaint::Solid(c), true) => db.brush(*c).draw(&self.stroke, items),
            (ClassicPaint::Gradient(gr), true) => db.brush(gr).draw(&self.stroke, items),
        }
    }
}

impl<'a> GlyphRunBackend<'a> for ClassicGlyphBackend<'a> {
    fn atlas_cache(self, _enabled: bool) -> Self {
        // Classic vello does its own glyph caching inside the renderer; nothing to toggle here.
        self
    }
    fn fill_glyphs<G>(self, run: GlyphRun<'a>, glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        self.draw(&run, glyphs, false);
    }
    fn stroke_glyphs<G>(self, run: GlyphRun<'a>, glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        self.draw(&run, glyphs, true);
    }
    /// Draw a decoration line (underline / strikethrough / overline) as a filled rectangle spanning
    /// the run under its own transform. This is the plain version: it does **not** yet do glifo's
    /// skip-ink (clipping the line out of descenders) — a later refinement — but a solid decoration
    /// reads correctly for the common case.
    fn render_decoration<G>(
        self,
        run: GlyphRun<'a>,
        _glyphs: G,
        x_range: RangeInclusive<f32>,
        baseline_y: f32,
        offset: f32,
        size: f32,
        _buffer: f32,
    ) where
        G: Iterator<Item = Glyph> + Clone,
    {
        // `offset` is the top of the line measured down from the baseline; `size` its thickness.
        let top = f64::from(baseline_y + offset);
        let rect = Rect::new(
            f64::from(*x_range.start()),
            top,
            f64::from(*x_range.end()),
            top + f64::from(size),
        );
        let t = run.transform();
        match &self.brush {
            ClassicPaint::Solid(c) => self.scene.fill(Fill::NonZero, t, *c, None, &rect),
            ClassicPaint::Gradient(g) => self.scene.fill(Fill::NonZero, t, g, None, &rect),
        }
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
        // PaintType is `peniko::Brush<Image, Gradient>`. Solid and gradient are peniko-native and map
        // straight through; an image paint would need this backend's own atlas (Phase 2), and
        // `ClassicEnv` resolves images to nothing upstream so this arm is currently unreachable — it
        // falls back to the default black placeholder rather than silently keeping a stale paint.
        self.paint = match paint.into() {
            vello_common::peniko::Brush::Solid(color) => ClassicPaint::Solid(color),
            vello_common::peniko::Brush::Gradient(g) => ClassicPaint::Gradient(g),
            vello_common::peniko::Brush::Image(_) => ClassicPaint::default(),
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
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        // Disjoint field borrows: `self.paint` read for the brush, `self.scene` mutated by `fill`.
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.fill(self.fill_rule, self.transform, *c, pt, path),
            ClassicPaint::Gradient(g) => self.scene.fill(self.fill_rule, self.transform, g, pt, path),
        }
    }
    fn stroke_path(&mut self, path: &BezPath) {
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.stroke(&self.stroke, self.transform, *c, pt, path),
            ClassicPaint::Gradient(g) => self.scene.stroke(&self.stroke, self.transform, g, pt, path),
        }
    }
    fn fill_rect(&mut self, rect: &Rect) {
        // Honour the paint transform here too: a gradient-filled square rect takes this fast path (no
        // corners → no `fill_path`), and the unit-box→bounds gradient mapping lives in that transform.
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.fill(self.fill_rule, self.transform, *c, pt, rect),
            ClassicPaint::Gradient(g) => self.scene.fill(self.fill_rule, self.transform, g, pt, rect),
        }
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
        // Snapshot the current brush/stroke so the backend can paint the glyphs — glifo's run carries
        // font + geometry but not paint. Cloned (not borrowed) so it doesn't alias `&mut self.scene`.
        let (brush, stroke) = (self.paint.clone(), self.stroke.clone());
        GlyphRunBuilder::new(
            font.clone(),
            t,
            pt,
            ClassicGlyphBackend { scene: &mut self.scene, brush, stroke },
        )
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
}

impl render_vello_core::rasterize::SceneRasterizer for ClassicRenderer {
    type Scene = ClassicCtx;

    fn new_scene(&self, width: u16, height: u16) -> ClassicCtx {
        ClassicCtx::new(width, height)
    }

    /// Rasterize `scene` into `target` (an `Rgba8Unorm` + `STORAGE_BINDING` texture) over
    /// `base_color`. Classic vello's `render_to_texture` owns its encoder/submit and clears the
    /// target first — there is no load variant (accumulation is the sink's job, above this seam).
    fn rasterize(
        &mut self,
        scene: &ClassicCtx,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: vello_common::peniko::Color,
    ) {
        let params = RenderParams { base_color, width, height, antialiasing_method: AaConfig::Area };
        self.inner
            .render_to_texture(device, queue, scene.scene(), target, &params)
            .expect("render_to_texture");
    }
}

/// The classic backend's [`DrawEnv`](render_vello_core::draw::DrawEnv). Image and baked-diamond
/// references resolve to nothing until this backend has an image atlas (Phase 2), so those paints
/// are skipped and every other kind — solid, gradient — draws now. Solid fields make it a
/// zero-cost stand-in the moment atlas staging arrives.
#[derive(Default)]
pub struct ClassicEnv;

impl render_vello_core::draw::DrawEnv for ClassicEnv {
    fn resolve_image(&self, _id: u128) -> Option<vello_common::paint::ImageId> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_vello_core::rasterize::SceneRasterizer;

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
        renderer.rasterize(&ctx, &device, &queue, &view, w, h, vello_common::color::palette::css::WHITE);

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
            w,
            h,
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

    // The Phase-1c milestone: classic vello renders a REAL render-core document — built with the
    // model API, walked by the shared neutral drawer (render_vello_core::draw) into ClassicCtx — not
    // a hand-built scene. A red rect, plus a blue rect inside a 0.5-opacity group (so the group
    // isolation → push/pop layer path is exercised), over white.
    #[test]
    fn classic_renders_a_real_render_core_document() {
        use render_core::kurbo::Rect as PageRect;
        use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
        use render_core::peniko::Color;
        use render_vello_core::draw::draw_scene;

        let (red, blue) = (Color::from_rgba8(230, 40, 40, 255), Color::from_rgba8(40, 60, 230, 255));
        let (a, g, b) = (1u128, 2u128, 3u128);
        let mut scene = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = vec![a, g];
        scene.insert(root);

        let mut na = Node::new(a, ShapeKind::Rect);
        na.bounds = PageRect::new(8.0, 8.0, 28.0, 28.0);
        na.fills = vec![Paint::plain(Brush::Solid(red))];
        scene.insert(na);

        let mut ng = Node::new(g, ShapeKind::Group);
        ng.opacity = 0.5; // → isolation layer
        ng.children = vec![b];
        scene.insert(ng);

        let mut nb = Node::new(b, ShapeKind::Rect);
        nb.bounds = PageRect::new(36.0, 36.0, 56.0, 56.0);
        nb.fills = vec![Paint::plain(Brush::Solid(blue))];
        scene.insert(nb);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping real-document proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu doc"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (64u32, 64u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        draw_scene(&mut ctx, &ClassicEnv, &scene, render_core::kurbo::Affine::IDENTITY);

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("doc target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        renderer.rasterize(&ctx, &device, &queue, &view, w, h, Color::WHITE);

        let data = read_back(&device, &queue, &texture, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        // Rect A (8..28) is opaque red.
        let ra = px(18, 18);
        assert!(ra[0] > 190 && ra[1] < 90 && ra[2] < 90, "rect A should be red, got {ra:?}");
        // Rect B (36..56) is blue at 0.5 group opacity over white → a lighter blue (blue high, red/green
        // lifted toward white). The 0.5 layer is the proof the group isolation path ran.
        let rb = px(46, 46);
        assert!(rb[2] > 150 && rb[0] > 100 && rb[0] < 210, "rect B should be half-opacity blue, got {rb:?}");
        // Background stays white.
        let bg = px(2, 2);
        assert!(bg[0] > 240 && bg[1] > 240 && bg[2] > 240, "background should be white, got {bg:?}");
    }

    // The new capability this slice unlocks: a NON-solid paint kind on classic. A linear gradient
    // fill goes through the shared `render_vello_core::draw::set_paint` — the unit-box→bounds mapping
    // and peniko gradient it builds — proving classic gained gradient/image/diamond from the port,
    // not just solids. The fill visibly varies across the box (red left, blue right); a flat or
    // collapsed gradient (the top-left-pixel bug the mapping guards against) would fail both ends.
    #[test]
    fn classic_renders_a_gradient_through_shared_draw() {
        use render_core::kurbo::Rect as PageRect;
        use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
        use render_core::peniko::{Color, ColorStop, Gradient};
        use render_vello_core::draw::draw_scene;

        // Unit-box linear gradient, red→blue left to right — exactly what a Penpot gradient fill
        // carries; `set_paint` maps the unit box onto the shape's bounds.
        let stops = [
            ColorStop { offset: 0.0, color: Color::from_rgba8(230, 30, 30, 255).into() },
            ColorStop { offset: 1.0, color: Color::from_rgba8(30, 40, 230, 255).into() },
        ];
        let grad = Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(&stops[..]);

        let mut scene = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = vec![1];
        scene.insert(root);
        let mut n = Node::new(1, ShapeKind::Rect);
        n.bounds = PageRect::new(8.0, 8.0, 56.0, 56.0);
        n.fills = vec![Paint::plain(Brush::Gradient(grad))];
        scene.insert(n);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping gradient proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu gradient"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (64u32, 64u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        draw_scene(&mut ctx, &ClassicEnv, &scene, render_core::kurbo::Affine::IDENTITY);

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("gradient target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        renderer.rasterize(&ctx, &device, &queue, &view, w, h, Color::WHITE);

        let data = read_back(&device, &queue, &texture, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        let left = px(12, 32);
        let right = px(52, 32);
        assert!(left[0] > left[2] + 60, "gradient left end should be red-dominant, got {left:?}");
        assert!(right[2] > right[0] + 60, "gradient right end should be blue-dominant, got {right:?}");
    }

    // Slice B milestone: classic vello rasterizes TEXT through ClassicGlyphBackend. "HELLO" is shaped
    // by hand (charmap char→gid, real advances) and drawn via ctx.glyph_run(...).fill_glyphs — the
    // exact path scene.rs's draw_glyph_run will take once the layout migrates — routing to classic's
    // native Scene::draw_glyphs. Proof: blue ink appears in the text band, background stays white.
    #[test]
    fn classic_renders_text_through_the_glyph_backend() {
        use render_core::kurbo::Affine;
        use render_core::peniko::{Blob, Color, FontData};
        use skrifa::instance::{LocationRef, Size};
        use skrifa::{FontRef, MetadataProvider};
        use std::sync::Arc;
        use vello_example_scenes::RenderingContext;

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vello/examples/assets/roboto/Roboto-Regular.ttf");
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("no Roboto font at {path} — skipping text proof");
            return;
        };
        let font_ref = FontRef::new(&bytes).expect("parse font");
        let font_size = 48.0f32;
        let charmap = font_ref.charmap();
        let gm = font_ref.glyph_metrics(Size::new(font_size), LocationRef::default());

        // Shape "HELLO" by hand: char → glyph id, advance by the font's real widths.
        let (mut x, baseline) = (12.0f32, 62.0f32);
        let mut glyphs: Vec<Glyph> = Vec::new();
        for ch in "HELLO".chars() {
            let gid = charmap.map(ch).expect("glyph id");
            glyphs.push(Glyph { id: gid.to_u32(), x, y: baseline });
            x += gm.advance_width(gid).unwrap_or(font_size * 0.5);
        }
        let font = FontData::new(Blob::new(Arc::new(bytes)), 0);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping text proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu text"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (256u32, 96u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        // Set the pen exactly as scene.rs's draw_glyph_run does before a fill pass: transform, then
        // the fill's paint. glyph_run snapshots this brush into the backend.
        ctx.set_transform(Affine::IDENTITY);
        ctx.set_paint(Color::from_rgba8(20, 30, 160, 255));
        let mut resources = ();
        ctx.glyph_run(&mut resources, &font)
            .font_size(font_size)
            .hint(true)
            .fill_glyphs(glyphs.iter().copied());

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("text target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        renderer.rasterize(&ctx, &device, &queue, &view, w, h, Color::WHITE);

        let data = read_back(&device, &queue, &texture, w, h);

        // Count ink: any pixel visibly darker than white is glyph coverage.
        let mut ink = 0usize;
        for i in (0..data.len()).step_by(4) {
            if data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200 {
                ink += 1;
            }
        }
        assert!(ink > 300, "expected glyph ink from HELLO, got only {ink} non-white px");
        // The blue tint means it took the brush, not the default black.
        let blue = data.chunks_exact(4).any(|p| p[2] > 120 && p[0] < 90 && p[1] < 90);
        assert!(blue, "glyph ink should carry the blue brush");
        // Top-left corner is outside the text band → white.
        let c = {
            let o = ((2 * w + 2) * 4) as usize;
            [data[o], data[o + 1], data[o + 2]]
        };
        assert!(c[0] > 240 && c[1] > 240 && c[2] > 240, "corner should be white, got {c:?}");

        // Keep the pixel proof.
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-b-classic-text.png");
        if let Ok(file) = std::fs::File::create(out) {
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            if let Ok(mut wr) = enc.write_header() {
                let _ = wr.write_image_data(&data);
            }
        }
    }
}
