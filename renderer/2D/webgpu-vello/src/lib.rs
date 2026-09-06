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

#[cfg(target_arch = "wasm32")]
mod renderer;
pub mod walk;
/// GPU walk kernel (V1) — compute-pass port of the scheduler's per-shape walk, diffed against the
/// render-core CPU oracle. See [`walk_gpu`].
pub mod walk_gpu;
#[cfg(target_arch = "wasm32")]
pub use renderer::{create_focus_renderer, ClassicFocusRenderer};

/// Whether the current device can bind `rgba8unorm` as a read-write storage texture — the single-
/// accumulator fast path. Written once at device creation (the wasm shell probes the adapter; a
/// native harness probes and sets it itself), read by the sink driver via
/// [`RasterBackend::rw_accumulator`](render_core::vello::rasterize::RasterBackend::rw_accumulator).
static RW_ACCUMULATOR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_rw_accumulator_supported(on: bool) {
    RW_ACCUMULATOR.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Host-visible capability probe: `true` once a device with `rgba8unorm` read-write storage exists
/// (browser: the `texture-formats-tier2` feature was granted; native: Metal/Vulkan/D3D caps).
#[unsafe(no_mangle)]
pub extern "C" fn wv_rw_supported() -> bool {
    RW_ACCUMULATOR.load(std::sync::atomic::Ordering::Relaxed)
}

pub use render_core::vello::abi;

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
    /// The host images this backend has staged, keyed by the [`vello_common::paint::ImageId`] the sink
    /// resolved a fill to. Shared (an `Rc`) with the owning [`ClassicBackend`] so every per-surface
    /// `ClassicCtx` sees the same uploads. Classic vello carries pixels in the scene encoding (there is
    /// no external atlas handle like hybrid's), so `set_paint` looks the pixels up here and attaches
    /// them as a peniko `ImageBrush`.
    images: ImageMap,
}

/// Shared `ImageId → pixels` map (see [`ClassicCtx::images`]).
type ImageMap = std::rc::Rc<std::cell::RefCell<std::collections::HashMap<vello_common::paint::ImageId, vello_common::peniko::ImageData>>>;

/// The paint kinds classic vello can draw today — all peniko-native, so `Scene::fill` takes them
/// directly.
#[derive(Clone)]
enum ClassicPaint {
    Solid(vello_common::peniko::Color),
    Gradient(vello_common::peniko::Gradient),
    Image(vello_common::peniko::ImageBrush),
}

impl Default for ClassicPaint {
    /// Opaque black, so a shape whose paint this backend cannot yet draw still shows rather than
    /// vanishing — the same visible-placeholder stance the solid-only spike took.
    fn default() -> Self {
        Self::Solid(vello_common::color::palette::css::BLACK)
    }
}

impl ClassicCtx {
    /// Splice an encoded body fragment under `matrix` — the cached-walk fast path.
    pub(crate) fn append_fragment(&mut self, frag: &vello::Scene, matrix: Affine) {
        self.scene.append(frag, Some(matrix));
    }

    /// Surrender the encoded scene — a finished fragment for [`crate::walk::BodyCache`].
    pub(crate) fn into_fragment(self) -> vello::Scene {
        self.scene
    }

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
            images: ImageMap::default(),
        }
    }

    /// The built scene, to hand to `vello::Renderer::render_to_texture`.
    #[must_use]
    pub fn scene(&self) -> &vello::Scene {
        &self.scene
    }

    /// Emit a `CMD_EFFECT` boundary marker over `shape` into the z-ordered stream — the front-end
    /// carries `effect_id` + `params` + the coverage; `fine` steps over it and the effect runs as a
    /// post-fine dispatch. Forwards to [`vello::Scene::draw_effect`].
    pub fn draw_effect(&mut self, transform: Affine, shape: &impl vello::kurbo::Shape, effect_id: u32, params: [f32; 4]) {
        self.scene.draw_effect(transform, shape, effect_id, params);
    }

    /// Point this context at the backend's shared image map, so an image fill resolves its pixels.
    fn share_images(&mut self, images: ImageMap) {
        self.images = images;
    }

    /// Insert one decoded image under `id` into this context's map — the atlas-free equivalent of
    /// staging, for callers (examples/tests) that drive a `ClassicCtx` directly rather than through
    /// `ClassicBackend::upload_pending_images`. Pair with `render_core::vello::abi::record_image` so
    /// the shared `resolve_image` maps a content id onto `id`.
    pub fn register_image(&mut self, id: vello_common::paint::ImageId, data: vello_common::peniko::ImageData) {
        self.images.borrow_mut().insert(id, data);
    }

    /// Draw a registered surface `img` into this scene with its top-left at `(ox, oy)`, 1:1 in size —
    /// the tile-fuse's inline replacement for a spread effect's composite blit. `alpha < 1` is applied
    /// through a clipped opacity layer over the placement rect.
    pub fn fill_image(&mut self, img: &vello_common::peniko::ImageData, ox: f64, oy: f64, alpha: f32) {
        use vello_common::peniko::ImageBrush;
        let (iw, ih) = (f64::from(img.width), f64::from(img.height));
        let xf = Affine::translate((ox, oy));
        let rect = Rect::new(0.0, 0.0, iw, ih);
        let brush = ImageBrush::new(img.clone());
        if alpha < 0.999 {
            self.scene.push_layer(Fill::NonZero, vello_common::peniko::BlendMode::default(), alpha, xf, &rect);
            self.scene.fill(Fill::NonZero, xf, &brush, None, &rect);
            self.scene.pop_layer();
        } else {
            self.scene.fill(Fill::NonZero, xf, &brush, None, &rect);
        }
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
        let coords: Vec<i16> = run.normalized_coords().iter().map(|c| c.to_bits()).collect();
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
        match (&self.brush, stroked) {
            (ClassicPaint::Solid(c), false) => db.brush(*c).draw(Fill::NonZero, items),
            (ClassicPaint::Gradient(gr), false) => db.brush(gr).draw(Fill::NonZero, items),
            (ClassicPaint::Image(b), false) => db.brush(b).draw(Fill::NonZero, items),
            (ClassicPaint::Solid(c), true) => db.brush(*c).draw(&self.stroke, items),
            (ClassicPaint::Gradient(gr), true) => db.brush(gr).draw(&self.stroke, items),
            (ClassicPaint::Image(b), true) => db.brush(b).draw(&self.stroke, items),
        }
    }
}

impl<'a> GlyphRunBackend<'a> for ClassicGlyphBackend<'a> {
    fn atlas_cache(self, _enabled: bool) -> Self {
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
            ClassicPaint::Image(b) => self.scene.fill(Fill::NonZero, t, b, None, &rect),
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
        self.paint = match paint.into() {
            vello_common::peniko::Brush::Solid(color) => ClassicPaint::Solid(color),
            vello_common::peniko::Brush::Gradient(g) => ClassicPaint::Gradient(g),
            vello_common::peniko::Brush::Image(img) => {
                let sampler = img.sampler;
                match img.image {
                    vello_common::paint::ImageSource::OpaqueId { id, .. } => self
                        .images
                        .borrow()
                        .get(&id)
                        .map_or_else(ClassicPaint::default, |data| {
                            ClassicPaint::Image(vello_common::peniko::ImageBrush {
                                image: data.clone(),
                                sampler,
                            })
                        }),
                    vello_common::paint::ImageSource::Pixmap(_) => ClassicPaint::default(),
                }
            }
        };
    }
    fn set_stroke(&mut self, stroke: Stroke) {
        self.stroke = stroke;
    }

    fn set_filter_effect(&mut self, _filter: Filter) {}
    fn reset_filter_effect(&mut self) {}
    fn push_filter_layer(&mut self, _filter: Filter) {
        let full = Rect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6);
        self.scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, Affine::IDENTITY, &full);
    }

    fn fill_path(&mut self, path: &BezPath) {
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.fill(self.fill_rule, self.transform, *c, pt, path),
            ClassicPaint::Gradient(g) => self.scene.fill(self.fill_rule, self.transform, g, pt, path),
            ClassicPaint::Image(b) => self.scene.fill(self.fill_rule, self.transform, b, pt, path),
        }
    }
    fn stroke_path(&mut self, path: &BezPath) {
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.stroke(&self.stroke, self.transform, *c, pt, path),
            ClassicPaint::Gradient(g) => self.scene.stroke(&self.stroke, self.transform, g, pt, path),
            ClassicPaint::Image(b) => self.scene.stroke(&self.stroke, self.transform, b, pt, path),
        }
    }
    fn fill_rect(&mut self, rect: &Rect) {
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        match &self.paint {
            ClassicPaint::Solid(c) => self.scene.fill(self.fill_rule, self.transform, *c, pt, rect),
            ClassicPaint::Gradient(g) => self.scene.fill(self.fill_rule, self.transform, g, pt, rect),
            ClassicPaint::Image(b) => self.scene.fill(self.fill_rule, self.transform, b, pt, rect),
        }
    }

    fn fill_blurred_rounded_rect(&mut self, rect: &Rect, radius: f32, std_dev: f32) {
        let color = match &self.paint {
            ClassicPaint::Solid(c) => *c,
            ClassicPaint::Gradient(_) | ClassicPaint::Image(_) => {
                vello_common::color::palette::css::BLACK
            }
        };
        self.scene.draw_blurred_rounded_rect(
            self.transform,
            *rect,
            color,
            f64::from(radius),
            f64::from(std_dev),
        );
    }

    fn glyph_run<'a>(
        &'a mut self,
        _resources: &'a mut Self::Resources,
        font: &FontData,
    ) -> GlyphRunBuilder<'a, Self::GlyphRunBackend<'a>> {
        let (t, pt) = (self.transform, self.paint_transform);
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
    /// Build the renderer for a device (compiles the shader permutations). Area AA only: the whole
    /// classic path renders with `AaConfig::Area`, and the msaa variants are not just dead weight —
    /// `fine` is the largest shader in the pipeline, compiling it twice more dominates startup, and
    /// the fork's window-skip code trips Tint's uniformity analysis inside `fill_path_ms`'s
    /// workgroup barriers, so the msaa modules fail CreateShaderModule on WebGPU anyway.
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let options = RendererOptions {
            antialiasing_support: vello::AaSupport::area_only(),
            ..RendererOptions::default()
        };
        Self { inner: Renderer::new(device, options).expect("vello renderer") }
    }
}

impl ClassicRenderer {
    /// Hand vello's retired buffers back to its pool. Safe only after the caller submitted the
    /// encoder the recordings went into — see `Renderer::release_pending`.
    pub fn release_pending(&mut self) {
        self.inner.release_pending();
    }

    /// Register a GPU surface with vello so scenes on this renderer can draw it as an image (the
    /// tile-fuse). The texture must be `Rgba8Unorm` + `COPY_SRC`; the returned handle is drawn via an
    /// `ImageBrush` and released with [`Self::unregister_texture`] once the frame is rendered.
    pub fn register_texture(&mut self, texture: wgpu::Texture) -> vello_common::peniko::ImageData {
        self.inner.register_texture(texture)
    }

    /// Release a surface registered with [`Self::register_texture`].
    pub fn unregister_texture(&mut self, handle: vello_common::peniko::ImageData) {
        self.inner.unregister_texture(handle);
    }

    /// SPIKE — prove `register_texture` round-trips before the tile-assembly refactor is built on it.
    ///
    /// (1) render a two-colour pattern (red left, blue right) into an offscreen texture; (2) register
    /// that GPU texture with vello; (3) build a second scene that draws a green background, a solid
    /// magenta rect *directly*, and the registered texture *as an image*; (4) render it to `target`.
    /// If the screenshot shows the red/blue pattern where the image was placed, in the right spot with
    /// the right colours, next to the magenta rect, the round-trip works. Throwaway.
    ///
    /// Renders into an offscreen `SIDE`×`SIDE` storage texture (classic writes its target from a
    /// compute shader, so the target needs `STORAGE_BINDING` — the swapchain view can't be one), then
    /// copies it to a mappable buffer and returns the raw RGBA bytes. The harness paints them into a 2D
    /// canvas so the round-trip can be seen and pixel-checked. `SIDE` is 512 so `bytes_per_row`
    /// (512·4 = 2048) is already 256-aligned — no row padding to unpick.
    pub async fn spike(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> Vec<u8> {
        use vello::Scene;
        use vello_common::kurbo::Rect;
        use vello_common::peniko::color::palette::css;

        const SIDE: u32 = 512;
        let params = |cw: u32, ch: u32, bg| RenderParams {
            base_color: bg,
            width: cw,
            height: ch,
            antialiasing_method: AaConfig::Area,
        };
        let storage_tex = |label, side| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };

        let half_red = css::RED.with_alpha(0.5);

        let pat_side = 200u32;
        let tex = storage_tex("spike pattern", pat_side);
        let tview = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let mut pat = Scene::new();
        pat.fill(Fill::NonZero, Affine::IDENTITY, half_red, None, &Rect::new(0.0, 0.0, 200.0, 200.0));
        self.inner
            .render_to_texture(device, queue, &pat, &tview, &params(pat_side, pat_side, css::TRANSPARENT))
            .expect("spike: render pattern");

        let img = self.inner.register_texture(tex);

        let out_tex = storage_tex("spike out", SIDE);
        let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let mut out = Scene::new();
        let full = f64::from(SIDE);
        out.fill(Fill::NonZero, Affine::IDENTITY, css::GREEN, None, &Rect::new(0.0, 0.0, full, full));
        out.fill(Fill::NonZero, Affine::IDENTITY, half_red, None, &Rect::new(40.0, 40.0, 180.0, 180.0));
        let brush = vello_common::peniko::ImageBrush::new(img.clone());
        out.fill(
            Fill::NonZero,
            Affine::translate((250.0, 100.0)),
            &brush,
            None,
            &Rect::new(0.0, 0.0, 200.0, 200.0),
        );
        out.draw_effect(Affine::IDENTITY, &Rect::new(100.0, 100.0, 300.0, 300.0), 7, [0.0, 0.0, 0.0, 0.0]);
        out.fill(Fill::NonZero, Affine::IDENTITY, css::BLUE, None, &Rect::new(150.0, 150.0, 250.0, 250.0));

        self.inner
            .render_to_texture(device, queue, &out, &out_view, &params(SIDE, SIDE, css::WHITE))
            .expect("spike: render output");
        self.inner.unregister_texture(img);

        let bpr = SIDE * 4;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike readback"),
            size: u64::from(bpr) * u64::from(SIDE),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("spike copy") });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &out_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(SIDE),
                },
            },
            wgpu::Extent3d { width: SIDE, height: SIDE, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);

        let slice = readback.slice(..);
        let (tx, rx) = futures_intrusive::channel::shared::oneshot_channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        rx.receive().await.expect("spike: map channel").expect("spike: map failed");
        let data = slice.get_mapped_range().to_vec();
        drop(slice);
        readback.unmap();
        data
    }
}

impl ClassicBackend {
    /// The region atlas view for a fine dispatch, or a persistent 1x1 dummy when none is bound
    /// (the binding layout always carries the slot).
    fn region_views(&mut self, device: &wgpu::Device) -> (wgpu::TextureView, wgpu::TextureView) {
        let dummy = self.region_dummy_view(device);
        let chain = if std::mem::take(&mut self.region_chain_write) {
            dummy.clone()
        } else {
            self.region_chain.clone().unwrap_or_else(|| dummy.clone())
        };
        let values = if std::mem::take(&mut self.region_values_write) {
            dummy
        } else {
            self.region_atlas.clone().unwrap_or(dummy)
        };
        (values, chain)
    }

    fn region_dummy_view(&mut self, device: &wgpu::Device) -> wgpu::TextureView {
        if self.region_dummy.is_none() {
            let t = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("wv region dummy"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.region_dummy = Some(t.create_view(&wgpu::TextureViewDescriptor::default()));
        }
        self.region_dummy.clone().expect("dummy just built")
    }

    /// SPIKE accessor — reach the vello renderer from the focus renderer. Throwaway.
    pub fn renderer_mut(&mut self) -> &mut ClassicRenderer {
        &mut self.renderer
    }
}

impl render_core::vello::rasterize::SceneRasterizer for ClassicRenderer {
    type Scene = ClassicCtx;

    fn new_scene(&self, width: u16, height: u16) -> ClassicCtx {
        ClassicCtx::new(width, height)
    }

    /// Rasterize `scene` into `target` (an `Rgba8Unorm` + `STORAGE_BINDING` texture) over
    /// `base_color`, recording into the caller's encoder. Clears the target first — there is no load
    /// variant (accumulation is the sink's job, above this seam).
    fn rasterize(
        &mut self,
        scene: &ClassicCtx,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: vello_common::peniko::Color,
    ) {
        let params = RenderParams { base_color, width, height, antialiasing_method: AaConfig::Area };
        self.inner
            .render_to_texture_into(device, queue, scene.scene(), target, &params, enc)
            .expect("render_to_texture_into");
    }
}

/// The classic backend's [`DrawEnv`](render_core::vello::draw::DrawEnv). Image and baked-diamond
/// references resolve through the shared ABI map — the SAME lookup the hybrid backend uses — once
/// [`ClassicBackend::upload_pending_images`] has staged the pixels; an unstaged reference resolves to
/// `None` for that frame and appears the next (matching hybrid). Fonts resolve the same way.
#[derive(Default)]
pub struct ClassicEnv;

impl render_core::vello::draw::DrawEnv for ClassicEnv {
    /// Resolve a content reference to the id [`ClassicBackend::upload_pending_images`] recorded for it,
    /// via the shared ABI map (same lookup the hybrid backend uses). `None` until the pixels are staged
    /// — then the shape draws nothing that frame and appears the next, matching hybrid.
    fn resolve_image(&self, id: u128) -> Option<vello_common::paint::ImageId> {
        render_core::vello::abi::resolve_image(id)
    }
    /// The font-family name to select in the Parley `FontContext`, resolved through the SHARED ABI
    /// aliasing — the same per-(id, weight, italic) alias the hybrid backend uses, and the same name
    /// [`ClassicBackend::sync_fonts`] registers each uploaded face under. (Before font staging this
    /// returned a single [`DEFAULT_FONT_ALIAS`]; now real host fonts resolve.)
    fn font_alias(&self, id: u128, weight: u16, italic: bool) -> String {
        render_core::vello::abi::font_alias(id, weight, italic)
    }
}

/// The single family name the classic backend registers its one face under until real font staging
/// exists — shared by [`ClassicEnv::font_alias`] and any caller that registers a face for it.
pub const DEFAULT_FONT_ALIAS: &str = "vello-gpu-font";

/// The classic backend as the sink's [`RasterBackend`](render_core::vello::rasterize::RasterBackend) —
/// the full seam `render_core::vello::sink::Sink` drives, so classic runs the *same* scheduler +
/// tile-cache + effect pipeline hybrid does.
///
/// It composes the pieces the earlier slices proved: scene *building* is classic's own
/// [`draw_paint_batch`](crate::walk::draw_paint_batch) over [`ClassicCtx`] — leaning on the shared
/// leaf paint (`render_core::vello::draw::paint_body`) and reading the live model off the shared ABI,
/// as the hybrid `NeutralModelScene` does with its own walk; *rasterization* is
/// [`ClassicRenderer`]'s `render_to_texture`. It owns the Parley [`TextState`](render_core::vello::text::TextState)
/// so text laid out across a frame reuses one font context.
pub struct ClassicBackend {
    renderer: ClassicRenderer,
    text: render_core::vello::text::TextState,
    /// Host images staged from the ABI, keyed by the id the sink resolves fills to. Shared into every
    /// `ClassicCtx` `new_scene` builds, so a fill can attach the pixels.
    images: ImageMap,
    /// The next `ImageId` to hand out. Classic mints its own (there is no external atlas); the value
    /// only has to be unique and stable for the frame, and `record_image` maps the content id to it.
    next_image_id: u32,
    /// Effect surfaces registered with vello for inline drawing this frame (the tile-fuse), keyed by the
    /// handle the sink holds. Drained each frame as the sink unregisters them post-render.
    inline_images: std::collections::HashMap<u64, vello_common::peniko::ImageData>,
    /// Monotonic handle source for [`Self::register_inline_image`].
    next_inline: u64,
    /// The in-progress persistent phased render, live between `phased_begin` and `phased_finish` so
    /// the sink can drive phases one at a time with a gather's effect recorded between them.
    phased_session: Option<vello::low_level::PhasedSession>,
    /// The frame's region atlas views (values = grounds, chain = region-space intermediates),
    /// bound read-only by every backdrop-tapping fine dispatch; a 1x1 dummy rides an empty slot.
    region_atlas: Option<wgpu::TextureView>,
    region_chain: Option<wgpu::TextureView>,
    region_chain_write: bool,
    region_values_write: bool,
    region_dummy: Option<wgpu::TextureView>,
    /// Encoded leaf-body fragments spliced by the whole-viewport walk — see [`walk::BodyCache`].
    body_cache: crate::walk::BodyCache,
    /// DEBUG (native only): the phased session's bump-buffer resource id + a device/queue clone, so
    /// `after_submit` can dump vello's overflow counters when `WV_DEBUG_BUMP` is set.
    #[cfg(not(target_arch = "wasm32"))]
    debug_bump_id: Option<vello::low_level::ResourceId>,
    #[cfg(not(target_arch = "wasm32"))]
    debug_gpu: Option<(wgpu::Device, wgpu::Queue)>,
}

impl ClassicBackend {
    /// Build over a device (compiles the classic shader permutations once).
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let renderer = ClassicRenderer::new(device);
        Self {
            renderer,
            text: render_core::vello::text::TextState::new(),
            images: ImageMap::default(),
            next_image_id: 0,
            inline_images: std::collections::HashMap::new(),
            next_inline: 0,
            phased_session: None,
            region_atlas: None,
            region_chain: None,
            region_chain_write: false,
            region_values_write: false,
            region_dummy: None,
            body_cache: crate::walk::BodyCache::default(),
            #[cfg(not(target_arch = "wasm32"))]
            debug_bump_id: None,
            #[cfg(not(target_arch = "wasm32"))]
            debug_gpu: None,
        }
    }

    /// Close the current wgpu-profiler frame and return the resolved per-dispatch GPU timings of the
    /// oldest finished frame, if one is ready. Diagnostics only (the `gpu-profiler` feature); call
    /// once per frame, after the frame's submit.
    #[cfg(feature = "gpu-profiler")]
    pub fn profiler_frame(
        &mut self,
        queue: &wgpu::Queue,
    ) -> Option<Vec<wgpu_profiler::GpuTimerQueryResult>> {
        let r = &mut self.renderer.inner;
        r.profiler.end_frame().ok()?;
        r.profiler.process_finished_frame(queue.get_timestamp_period())
    }

    /// Register every image the host staged since the last frame (plus any freshly baked diamonds)
    /// into the shared map, and record the content-id → [`vello_common::paint::ImageId`] mapping the
    /// sink's `resolve_image` reads. Classic keeps the pixels (peniko `ImageData`) rather than
    /// uploading to an external atlas — they ride the scene encoding, and vello builds its own atlas at
    /// render. The wasm shell calls this once per frame before the sink runs.
    pub fn upload_pending_images(&mut self) {
        render_core::vello::abi::stage_diamond_bakes();
        let mut any = false;
        for img in render_core::vello::abi::take_pending_images() {
            any = true;
            let expected = (img.width as usize) * (img.height as usize) * 4;
            if img.width == 0 || img.height == 0 || img.rgba.len() != expected {
                continue;
            }
            let data = vello_common::peniko::ImageData {
                data: vello_common::peniko::Blob::new(std::sync::Arc::new(img.rgba)),
                format: vello_common::peniko::ImageFormat::Rgba8,
                alpha_type: vello_common::peniko::ImageAlphaType::Alpha,
                width: img.width,
                height: img.height,
            };
            let id = vello_common::paint::ImageId::new(self.next_image_id);
            self.next_image_id = self.next_image_id.wrapping_add(1);
            self.images.borrow_mut().insert(id, data);
            render_core::vello::abi::record_image(img.id, id);
        }
        if any {
            self.body_cache.clear();
        }
    }

    /// The Parley engine, so a test can register a face directly (the browser path uses
    /// [`Self::sync_fonts`] instead, reading the shared ABI font registry).
    pub fn text_mut(&mut self) -> &mut render_core::vello::text::TextState {
        &mut self.text
    }

    /// Register any faces published since this backend's last frame into the Parley collection, under
    /// the aliases [`ClassicEnv::font_alias`] resolves to — so text laid out this frame finds its
    /// font. Reads the shared font registry through this backend's own cursor, so other consumers
    /// see the same faces. The wasm shell calls this once per frame before the sink runs.
    pub fn sync_fonts(&mut self) {
        if self.text.sync_fonts() > 0 {
            self.body_cache.clear();
        }
    }

    /// Fold the queued text-editor commands into the live [`render_core::vello::rich_editor::RichEditor`]
    /// and refresh the ABI snapshot, before this frame draws — so the caret and selection it paints
    /// are up to date. The wasm shell calls this once per frame after `sync_fonts`.
    pub fn sync_editor(&mut self) {
        let text = &mut self.text;
        render_core::vello::abi::with_scene(|scene, _, _| text.sync_editor(scene));
    }
}

impl render_core::vello::rasterize::RasterBackend for ClassicBackend {
    type Scene = ClassicCtx;

    fn new_scene(&self, width: u16, height: u16) -> ClassicCtx {
        let mut ctx = ClassicCtx::new(width, height);
        ctx.share_images(self.images.clone());
        ctx
    }

    fn build_bodies(&mut self, scene: &mut ClassicCtx, transform: Affine, ops: &[render_core::schedule::PaintOp]) {
        let _tsc = render_core::vello::prof::now();
        let mut resources = ();
        let text = &mut self.text;
        render_core::vello::abi::with_scene(|model, viewport, modifiers| {
            crate::walk::draw_paint_batch(
                scene,
                &mut resources,
                &ClassicEnv,
                text,
                model,
                transform * viewport,
                modifiers,
                ops,
            );
        });
        render_core::vello::prof::add_scene(render_core::vello::prof::now() - _tsc);
    }

    fn draw_scene_range(&mut self, scene: &mut ClassicCtx, root: Affine, start: usize, end: usize) {
        let _tsc = render_core::vello::prof::now();
        let text = &mut self.text;
        let cache = &mut self.body_cache;
        render_core::vello::abi::with_scene(|model, viewport, modifiers| {
            crate::walk::draw_scene_range_cached(scene, &ClassicEnv, text, model, root * viewport, start, end, modifiers, cache);
        });
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("WV_DBG_BODYCACHE").is_ok() {
            eprintln!("WV_DBG_BODYCACHE: hits={} misses={}", self.body_cache.hits, self.body_cache.misses);
        }
        render_core::vello::prof::add_scene(render_core::vello::prof::now() - _tsc);
    }

    fn build_mask(&mut self, scene: &mut ClassicCtx, transform: Affine, id: u128) {
        render_core::vello::abi::with_scene(|model, viewport, modifiers| {
            if let Some(node) = model.get(id) {
                let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                let matrix = transform * viewport * modifier * node.effective_transform();
                scene.set_transform(matrix);
                scene.set_paint(render_core::peniko::Color::from_rgba8(255, 255, 255, 255));
                scene.fill_path(&render_core::geometry::outline(node));
            }
        });
    }

    fn build_shadow_silhouette(&mut self, scene: &mut ClassicCtx, transform: Affine, id: u128, shadow: usize, inset: bool, apply_offset: bool, tinted: bool) {
        let text = &mut self.text;
        render_core::vello::abi::with_scene(|model, viewport, modifiers| {
            let Some(node) = model.get(id) else { return };
            let Some(s) = node.shadows.iter().filter(|s| s.inset == inset).nth(shadow) else { return };
            let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            let offset = if apply_offset { Affine::translate((s.offset.x, s.offset.y)) } else { Affine::IDENTITY };
            let matrix = transform
                * viewport
                * modifier
                * node.effective_transform()
                * offset;
            if node.kind == render_core::model::ShapeKind::Text {
                let mut resources = ();
                render_core::vello::text::draw_text_block(
                    scene, &mut resources, &mut text.font_cx, &mut text.layout_cx, &ClassicEnv, node, matrix,
                    Some(if tinted { s.color } else { vello_common::color::palette::css::WHITE }),
                );
                return;
            }
            scene.set_transform(matrix);
            // Untinted, the silhouette is pure coverage — a Tint unit colours it later, so shadows
            // that differ only in colour can share one rasterisation.
            scene.set_paint(if tinted { s.color } else { vello_common::color::palette::css::WHITE });
            let path = if s.spread > 0.0 {
                render_core::geometry::spread_outline(node, f64::from(s.spread))
            } else {
                render_core::geometry::outline(node)
            };
            scene.fill_path(&path);
        });
    }

    fn set_frame_extent(&mut self, width: u32, height: u32) {
        vello::set_frame(width, height);
    }

    fn phase_region_atlas(&mut self, values: Option<&wgpu::TextureView>, chain: Option<&wgpu::TextureView>) {
        self.region_atlas = values.cloned();
        self.region_chain = chain.cloned();
    }

    fn phase_region_chain_write(&mut self) {
        self.region_chain_write = true;
    }

    fn phase_region_values_write(&mut self) {
        self.region_values_write = true;
    }

    fn draw_fill_rect(&mut self, scene: &mut ClassicCtx, rect: [f32; 4], color: [f32; 4]) {
        let r = Rect::new(f64::from(rect[0]), f64::from(rect[1]), f64::from(rect[2]), f64::from(rect[3]));
        let c = vello_common::peniko::Color::new([color[0], color[1], color[2], color[3]]);
        scene.set_transform(Affine::IDENTITY);
        scene.scene.fill(Fill::NonZero, Affine::IDENTITY, c, None, &r);
    }

    fn draw_effect_marker(&mut self, scene: &mut ClassicCtx, transform: Affine, id: u128, effect_id: u32, seg_after: u32, round: u32, p2: u32, reach: [f32; 4], atomic_ctl: u32) {
        let r = Rect::new(
            f64::from(reach[0]).max(0.0),
            f64::from(reach[1]).max(0.0),
            f64::from(reach[2]).min(f64::from(scene.width())),
            f64::from(reach[3]).min(f64::from(scene.height())),
        );
        if r.x1 <= r.x0 || r.y1 <= r.y0 {
            return;
        }
        let params = [f32::from_bits(seg_after), f32::from_bits(round), f32::from_bits(p2), f32::from_bits(atomic_ctl)];
        // An INLINE effect (effects-in-fine) encodes the node's real silhouette as its shape, so
        // coarse emits that coverage into `area[i]` and fine confines the effect to it. A barrier
        // effect encodes the reach rect: it only needs to bin the z-boundary into its reach tiles.
        // A DILATED inline effect (101) is still inline in the shader (>= 100) but rasterises its
        // coverage over the reach rect — the separable blur's H pass, which must write its draft past
        // the silhouette so the V pass's taps stay on H-blurred pixels.
        if effect_id == 101 {
            scene.draw_effect(Affine::IDENTITY, &r, effect_id, params);
        } else if effect_id >= 100 {
            render_core::vello::abi::with_scene(|model, viewport, modifiers| {
                if let Some(node) = model.get(id) {
                    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let matrix = transform * viewport * modifier * node.effective_transform();
                    // A masked marker's silhouette may overhang below the frame into region
                    // grid rows — harmlessly: region windows run the EARLIEST rounds (front,
                    // class-separated), so a stray frame marker on a band tile is out of every
                    // region window (no execution, no store claim), and it sits later in the
                    // stream than the region's own fence + draws (no walk break before them).
                    scene.draw_effect(matrix, &render_core::geometry::outline(node), effect_id, params);
                }
            });
        } else {
            scene.draw_effect(Affine::IDENTITY, &r, effect_id, params);
        }
    }

    fn rasterize(
        &mut self,
        scene: &ClassicCtx,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: render_core::peniko::Color,
    ) {
        use render_core::vello::rasterize::SceneRasterizer;
        let _trd = render_core::vello::prof::now();
        self.renderer.rasterize(scene, device, queue, enc, target, width, height, base_color);
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
        render_core::vello::prof::inc_render();
    }

    fn draw_object_count(&self, scene: &ClassicCtx) -> u32 {
        scene.scene().encoding().draw_tags.len() as u32
    }

    /// Begin a persistent phased session (front-end once), holding it on the backend. Counts as the
    /// SINGLE render for the profiler — the whole gather frame it drives shares this one setup.
    fn phased_begin(
        &mut self,
        scene: &ClassicCtx,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        width: u32,
        height: u32,
        base_color: render_core::peniko::Color,
        effect_params: &[u8],
    ) {
        let _trd = render_core::vello::prof::now();
        let params = RenderParams { base_color, width, height, antialiasing_method: AaConfig::Area };
        let session = self
            .renderer
            .inner
            .phased_begin_into(device, queue, scene.scene(), &params, effect_params, enc)
            .expect("phased_begin_into");
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.debug_bump_id = Some(session.debug_bump_proxy_id());
            self.debug_gpu = Some((device.clone(), queue.clone()));
        }
        self.phased_session = Some(session);
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
        render_core::vello::prof::inc_render();
    }

    fn phased_frontend_full(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder) {
        let _trd = render_core::vello::prof::now();
        let session = self.phased_session.as_mut().expect("phased_frontend_full without phased_begin");
        self.renderer
            .inner
            .phased_frontend_full_into(session, device, queue, enc)
            .expect("phased_frontend_full_into");
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
    }

    fn phased_fine_segment(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        base: Option<&wgpu::TextureView>,
        out: &wgpu::TextureView,
    ) {
        let _trd = render_core::vello::prof::now();
        let session = self.phased_session.as_mut().expect("phased_fine_segment without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_into(session, device, queue, enc, seg_lo, seg_target, base, out)
            .expect("phased_fine_segment_into");
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
    }

    fn phased_fine_segment_draft(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        base: &wgpu::TextureView,
        draft: &wgpu::TextureView,
        out: &wgpu::TextureView,
    ) {
        let _trd = render_core::vello::prof::now();
        let session = self.phased_session.as_mut().expect("phased_fine_segment_draft without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_draft_into(session, device, queue, enc, seg_lo, seg_target, base, draft, out)
            .expect("phased_fine_segment_draft_into");
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
    }

    fn phased_fine_segment_input(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        base: &wgpu::TextureView,
        input: &wgpu::TextureView,
        out: &wgpu::TextureView,
    ) {
        let _trd = render_core::vello::prof::now();
        let session = self.phased_session.as_mut().expect("phased_fine_segment_input without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_input_into(session, device, queue, enc, seg_lo, seg_target, base, input, out)
            .expect("phased_fine_segment_input_into");
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
    }

    fn rw_accumulator(&self) -> bool {
        wv_rw_supported()
    }

    fn phased_fine_segment_rw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        target: &wgpu::TextureView,
    ) {
        let _trd = render_core::vello::prof::now();
        let session = self.phased_session.as_mut().expect("phased_fine_segment_rw without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_rw_into(session, device, queue, enc, seg_lo, seg_target, target)
            .expect("phased_fine_segment_rw_into");
        render_core::vello::prof::add_render(render_core::vello::prof::now() - _trd);
    }

    fn phased_fine_segment_seed_u(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        target: &wgpu::TextureView,
    ) {
        let session = self.phased_session.as_mut().expect("phased_fine_segment_seed_u without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_seed_u_into(session, device, queue, enc, seg_lo, seg_target, target)
            .expect("phased_fine_segment_seed_u_into");
    }

    fn phased_fine_segment_draftonly(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        out: &wgpu::TextureView,
    ) {
        let session = self.phased_session.as_mut().expect("phased_fine_segment_draftonly without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_draftonly_into(session, device, queue, enc, seg_lo, seg_target, out)
            .expect("phased_fine_segment_draftonly_into");
    }

    fn phased_fine_segment_rwu(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        snap: &wgpu::TextureView,
        slot10: Option<(bool, &wgpu::TextureView)>,
        target: &wgpu::TextureView,
    ) {
        let (region, chain) = self.region_views(device);
        let session = self.phased_session.as_mut().expect("phased_fine_segment_rwu without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_rwu_into(session, device, queue, enc, seg_lo, seg_target, snap, slot10, &region, &chain, target)
            .expect("phased_fine_segment_rwu_into");
    }

    fn phased_fine_segment_loadu(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        seg_lo: u32,
        seg_target: u32,
        snap: &wgpu::TextureView,
        slot10: Option<(bool, &wgpu::TextureView)>,
        out: &wgpu::TextureView,
    ) {
        let (region, chain) = self.region_views(device);
        let session = self.phased_session.as_mut().expect("phased_fine_segment_loadu without phased_begin");
        self.renderer
            .inner
            .phased_fine_segment_loadu_into(session, device, queue, enc, seg_lo, seg_target, snap, slot10, &region, &chain, out)
            .expect("phased_fine_segment_loadu_into");
    }

    fn phase_scratch_origins(&mut self, scratch_out: [u32; 2], scratch_in: [u32; 2]) {
        if let Some(session) = self.phased_session.as_mut() {
            session.set_scratch_origins(scratch_out, scratch_in);
        }
    }

    fn phase_sparse_window(&mut self, base: u32, n: u32) {
        if let Some(session) = self.phased_session.as_mut() {
            session.set_sparse(base, n);
        }
    }

    fn phased_finish(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder) {
        if let Some(session) = self.phased_session.take() {
            self.renderer
                .inner
                .phased_finish_into(session, device, queue, enc)
                .expect("phased_finish_into");
        }
    }

    fn phase_flush(&mut self, enc: &mut wgpu::CommandEncoder) {
        self.renderer.inner.flush_dispatches(enc);
    }

    fn phase_snap_copy(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        rects: &[[u32; 4]],
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
    ) {
        let session = self.phased_session.as_mut().expect("phase_snap_copy without phased_begin");
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("WV_DBG_SNAPCOPY").is_ok() {
            eprintln!("WV_DBG_SNAPCOPY: {} rects", rects.len());
        }
        self.renderer
            .inner
            .phased_snap_copy_into(session, device, queue, enc, rects, src, dst)
            .expect("phased_snap_copy_into");
    }

    fn rasterize_target_usage(&self) -> wgpu::TextureUsages {
        wgpu::TextureUsages::STORAGE_BINDING
    }

    /// The frame has been submitted, so vello's retired buffers are safe to recycle now.
    fn after_submit(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("WV_DEBUG_BUMP").is_ok() {
            if let (Some(id), Some((device, queue))) = (self.debug_bump_id.take(), self.debug_gpu.clone()) {
                if let Some(v) = self.renderer.inner.engine_debug_read(&device, &queue, id, 8) {
                    eprintln!(
                        "BUMP: failed={:#x} binning={} ptcl={} tile={} seg_counts={} segments={} blend={} lines={}",
                        v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]
                    );
                }
            }
        }
        self.renderer.release_pending();
    }

    /// Classic encodes fresh per-recording buffers into each `Recording` (no persistent uniform is
    /// aliased across renders), so several rasterizes may share one submit. See the trait default for
    /// why hybrid cannot.
    fn batched_submits_safe(&self) -> bool {
        true
    }

    /// Classic draws inline surfaces via `register_texture` + an `ImageBrush` fill — the tile-fuse.
    fn inline_images_supported(&self) -> bool {
        true
    }

    fn register_inline_image(&mut self, texture: &wgpu::Texture) -> u64 {
        let img = self.renderer.register_texture(texture.clone());
        let handle = self.next_inline;
        self.next_inline = self.next_inline.wrapping_add(1);
        self.inline_images.insert(handle, img);
        handle
    }

    fn draw_inline_image(&mut self, scene: &mut ClassicCtx, handle: u64, dst: render_core::kurbo::Rect, alpha: f32) {
        if let Some(img) = self.inline_images.get(&handle) {
            scene.fill_image(img, dst.x0, dst.y0, alpha);
        }
    }

    fn unregister_inline_image(&mut self, handle: u64) {
        if let Some(img) = self.inline_images.remove(&handle) {
            self.renderer.unregister_texture(img);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::vello::rasterize::SceneRasterizer;

    /// The shared ABI scene-state is a process-global singleton, so the tests that drive it must not
    /// run concurrently. Each locks this first (poison ignored — a panicking test shouldn't wedge the
    /// rest); using disjoint shape ids keeps their scenes from colliding through the lock.
    static ABI_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_scene_can_be_driven_through_the_rendering_context_trait() {
        fn draw<C: RenderingContext>(ctx: &mut C) {
            ctx.set_fill_rule(Fill::NonZero);
            ctx.set_transform(Affine::translate((10.0, 10.0)));
            ctx.set_paint(vello_common::peniko::Brush::Solid(
                vello_common::color::palette::css::REBECCA_PURPLE,
            ));
            ctx.fill_rect(&Rect::new(0.0, 0.0, 40.0, 40.0));
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
        assert_eq!(ctx.width(), 256);
        assert!(ctx.scene().encoding().n_paths > 0, "expected encoded paths in the classic scene");
    }

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

        let (w, h) = (64u32, 64u32);
        let mut ctx = ClassicCtx::new(w as u16, h as u16);
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
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, vello_common::color::palette::css::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

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
        let c = px(32, 32);
        assert!(c[0] > 60 && c[0] < 130 && c[2] > 120 && c[1] < 90, "centre should be purple, got {c:?}");
        let bg = px(4, 4);
        assert!(bg[0] > 240 && bg[1] > 240 && bg[2] > 240, "corner should be white, got {bg:?}");
    }

    /// **The task-15c milestone:** classic vello renders a real document through the *shared* GPU sink
    /// — the same `render_core::vello::sink::Sink` (scheduler + tile cache + effect executor) the hybrid
    /// backend drives — via [`ClassicBackend`]. We drive the shared ABI like the host would (two solid
    /// rects under the root), let the sink schedule + tile + composite them onto a swapchain texture,
    /// read it back, and check the pixels. This is the first end-to-end classic render of a scheduled
    /// document; only the wgpu-on-canvas surface + `?renderer=vello-gpu` loader (15d) then remain.
    #[test]
    fn classic_renders_a_document_through_the_shared_sink() {
        use render_core::tiling::TileKey;
        use render_core::vello::sink::Sink;
        use std::collections::HashSet;

        let _abi = ABI_TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping classic sink render proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("classic sink"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        fn solid_fill_bytes(argb: u32) -> Vec<u8> {
            let mut b = vec![0u8; 4 + 164];
            b[0] = 1;
            b[8..12].copy_from_slice(&argb.to_le_bytes());
            b
        }
        let rect = |id: u32, l: f32, t: f32, r: f32, bt: f32, argb: u32| {
            render_core::vello::abi::use_shape(id, 0, 0, 0);
            render_core::vello::abi::set_shape_type(3);
            render_core::vello::abi::set_shape_selrect(l, t, r, bt);
            let bytes = solid_fill_bytes(argb);
            let ptr = render_core::vello::abi::alloc_bytes(bytes.len());
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
            render_core::vello::abi::set_shape_fills();
        };

        render_core::vello::abi::init(256, 256);
        render_core::vello::abi::set_render_options(0, 1.0);
        render_core::vello::abi::set_view(1.0, 0.0, 0.0);
        render_core::vello::abi::set_canvas_background(0xFFFF_FFFF);
        rect(1, 40.0, 40.0, 150.0, 150.0, 0xFFE2_3B3B);
        rect(2, 90.0, 90.0, 200.0, 200.0, 0xFF2B_6CF0);
        render_core::vello::abi::use_shape(0, 0, 0, 0);
        render_core::vello::abi::set_children_2(1, 0, 0, 0, 2, 0, 0, 0);

        let (w, h) = (256u32, 256u32);
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut sink = Sink::new(&device, format);
        let mut backend = ClassicBackend::new(&device);
        let root = Affine::IDENTITY;
        let full_view = render_core::vello::abi::effective_view(root);
        let dirty = sink.plan_frame(full_view, w, h, true, &[]);
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
        let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, true);

        let surface = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("classic swapchain"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        sink.execute(&schedule, &dirty, &mut backend, &device, &queue, &surface, root, w, h);

        let data = read_back(&device, &queue, &surface, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };

        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-d-classic-sink-document.png");
        if let Ok(file) = std::fs::File::create(out) {
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            if let Ok(mut wr) = enc.write_header() {
                let _ = wr.write_image_data(&data);
            }
        }

        let bg = px(8, 8);
        assert!(bg[0] > 230 && bg[1] > 230 && bg[2] > 230, "corner should be white bg, got {bg:?}");
        let red = px(60, 60);
        assert!(
            red[0] > 150 && red[0] > red[1] + 40 && red[0] > red[2] + 40,
            "expected the red rect at (60,60), got {red:?}"
        );
        let blue = px(178, 178);
        assert!(
            blue[2] > 150 && blue[2] > blue[0] + 40 && blue[2] > blue[1] + 40,
            "expected the blue rect at (178,178), got {blue:?}"
        );
        let overlap = px(120, 120);
        assert!(overlap[2] > overlap[0], "overlap should be blue-over-red, got {overlap:?}");
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

    #[test]
    fn classic_device_runs_the_shared_effect_executor() {
        use render_core::effect_graph::background_blur_graph;
        use render_core::vello::blend::{Blit, Compositor};
        use render_core::vello::units::UnitPipeline;
        use render_core::vello::graph::{lower_graph, run_graph};

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
        let mut renderer = ClassicRenderer::new(&device);
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(
            &ctx,
            &device,
            &queue,
            &mut enc,
            &src_view,
            w,
            h,
            vello_common::color::palette::css::WHITE,
        );
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let compositor = Compositor::new(&device, format);
        let glass = UnitPipeline::new(&device, format);
        let passes = lower_graph(&background_blur_graph(6.0), None);
        let (_blurred, blurred_view) =
            run_graph(&compositor, &glass, &device, &queue, &[&src_view], &passes, w, h, format)
                .expect("blur produced a texture");

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
        let c = px(32, 32);
        assert!(c[2] > 110 && c[1] < 120, "blurred centre should stay purple, got {c:?}");
        let bleed = px(12, 32);
        assert!(bleed[1] < 245 && bleed[2] > bleed[1], "edge should show blur bleed, got {bleed:?}");
    }

    #[test]
    fn classic_renders_a_real_render_core_document() {
        use render_core::kurbo::Rect as PageRect;
        use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
        use render_core::peniko::Color;
        use crate::walk::draw_scene;

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
        ng.opacity = 0.5;
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
        draw_scene(
            &mut ctx,
            &mut (),
            &ClassicEnv,
            &mut render_core::vello::text::TextState::new(),
            &scene,
            render_core::kurbo::Affine::IDENTITY,
            &Default::default(),
        );

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
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let data = read_back(&device, &queue, &texture, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        let ra = px(18, 18);
        assert!(ra[0] > 190 && ra[1] < 90 && ra[2] < 90, "rect A should be red, got {ra:?}");
        let rb = px(46, 46);
        assert!(rb[2] > 150 && rb[0] > 100 && rb[0] < 210, "rect B should be half-opacity blue, got {rb:?}");
        let bg = px(2, 2);
        assert!(bg[0] > 240 && bg[1] > 240 && bg[2] > 240, "background should be white, got {bg:?}");
    }

    #[test]
    fn classic_renders_a_gradient_through_shared_draw() {
        use render_core::kurbo::Rect as PageRect;
        use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
        use render_core::peniko::{Color, ColorStop, Gradient};
        use crate::walk::draw_scene;

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
        draw_scene(
            &mut ctx,
            &mut (),
            &ClassicEnv,
            &mut render_core::vello::text::TextState::new(),
            &scene,
            render_core::kurbo::Affine::IDENTITY,
            &Default::default(),
        );

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
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

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
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let data = read_back(&device, &queue, &texture, w, h);

        let mut ink = 0usize;
        for i in (0..data.len()).step_by(4) {
            if data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200 {
                ink += 1;
            }
        }
        assert!(ink > 300, "expected glyph ink from HELLO, got only {ink} non-white px");
        let blue = data.chunks_exact(4).any(|p| p[2] > 120 && p[0] < 90 && p[1] < 90);
        assert!(blue, "glyph ink should carry the blue brush");
        let c = {
            let o = ((2 * w + 2) * 4) as usize;
            [data[o], data[o + 1], data[o + 2]]
        };
        assert!(c[0] > 240 && c[1] > 240 && c[2] > 240, "corner should be white, got {c:?}");

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

    #[test]
    fn classic_renders_a_text_block_through_shared_layout() {
        use parley::fontique::FontInfoOverride;
        use parley::{FontContext, LayoutContext};
        use render_core::kurbo::{Affine, Rect as PageRect};
        use render_core::model::{Brush, Node, Paint, ShapeKind};
        use render_core::peniko::Color;
        use render_core::text::{
            FontRef, TextAlign, TextBlock, TextBrush, TextDecoration, TextDirection, TextGrow,
            TextParagraph, TextSpan, TextTransform, VerticalAlign,
        };

        let fpath = concat!(env!("CARGO_MANIFEST_DIR"), "/../vello/examples/assets/roboto/Roboto-Regular.ttf");
        let Ok(bytes) = std::fs::read(fpath) else {
            eprintln!("no Roboto font at {fpath} — skipping text-block proof");
            return;
        };

        let mut font_cx = FontContext::new();
        font_cx.collection.register_fonts(
            bytes.into(),
            Some(FontInfoOverride {
                family_name: Some(DEFAULT_FONT_ALIAS),
                width: None,
                style: None,
                weight: None,
                axes: None,
            }),
        );
        let mut layout_cx: LayoutContext<TextBrush> = LayoutContext::new();

        let span = TextSpan {
            text: "Vello".to_string(),
            font: FontRef { id: 7, weight: 400, italic: false },
            size: 44.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![Paint::plain(Brush::Solid(Color::from_rgba8(20, 30, 160, 255)))],
            decoration: TextDecoration::None,
            transform: TextTransform::None,
        };
        let block = TextBlock {
            paragraphs: vec![TextParagraph {
                align: TextAlign::Left,
                direction: TextDirection::Ltr,
                line_height: 1.2,
                letter_spacing: 0.0,
                spans: vec![span],
            }],
            grow: TextGrow::AutoWidth,
            vertical_align: VerticalAlign::Top,
        };
        let mut node = Node::new(1, ShapeKind::Text);
        node.bounds = PageRect::new(10.0, 10.0, 246.0, 82.0);
        node.text = Some(block);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping text-block proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu text-block"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (256u32, 96u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        let mut resources = ();
        render_core::vello::text::draw_text_block(
            &mut ctx,
            &mut resources,
            &mut font_cx,
            &mut layout_cx,
            &ClassicEnv,
            &node,
            Affine::IDENTITY,
            None,
        );

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("text-block target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let data = read_back(&device, &queue, &texture, w, h);
        let mut ink = 0usize;
        for i in (0..data.len()).step_by(4) {
            if data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200 {
                ink += 1;
            }
        }
        assert!(ink > 300, "expected laid-out glyph ink from 'Vello', got only {ink} non-white px");
        let blue = data.chunks_exact(4).any(|p| p[2] > 120 && p[0] < 90 && p[1] < 90);
        assert!(blue, "text-block ink should carry the span's blue fill");

        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-b2-classic-text-block.png");
        if let Ok(file) = std::fs::File::create(out) {
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            if let Ok(mut wr) = enc.write_header() {
                let _ = wr.write_image_data(&data);
            }
        }
    }

    #[test]
    fn classic_renders_a_clipped_document_with_text() {
        use parley::fontique::FontInfoOverride;
        use render_core::kurbo::{Affine, Rect as PageRect};
        use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
        use render_core::peniko::Color;
        use render_core::text::{
            FontRef, TextAlign, TextBlock, TextDecoration, TextDirection, TextGrow, TextParagraph,
            TextSpan, TextTransform, VerticalAlign,
        };
        use crate::walk::draw_scene;
        use render_core::vello::text::TextState;

        let fpath = concat!(env!("CARGO_MANIFEST_DIR"), "/../vello/examples/assets/roboto/Roboto-Regular.ttf");
        let Ok(bytes) = std::fs::read(fpath) else {
            eprintln!("no Roboto — skipping clipped-document proof");
            return;
        };
        let mut text = TextState::new();
        text.font_cx.collection.register_fonts(
            bytes.into(),
            Some(FontInfoOverride { family_name: Some(DEFAULT_FONT_ALIAS), ..Default::default() }),
        );

        let mut scene = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = vec![10, 20];
        scene.insert(root);

        let mut frame = Node::new(10, ShapeKind::Frame);
        frame.bounds = PageRect::new(20.0, 20.0, 120.0, 120.0);
        frame.clip = true;
        frame.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(225, 225, 225, 255)))];
        frame.children = vec![11];
        scene.insert(frame);
        let mut inner = Node::new(11, ShapeKind::Rect);
        inner.bounds = PageRect::new(60.0, 60.0, 200.0, 200.0);
        inner.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(30, 60, 210, 255)))];
        scene.insert(inner);

        let span = TextSpan {
            text: "Clip".to_string(),
            font: FontRef { id: 1, weight: 400, italic: false },
            size: 34.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![Paint::plain(Brush::Solid(Color::from_rgba8(200, 40, 40, 255)))],
            decoration: TextDecoration::None,
            transform: TextTransform::None,
        };
        let mut label = Node::new(20, ShapeKind::Text);
        label.bounds = PageRect::new(150.0, 40.0, 250.0, 90.0);
        label.text = Some(TextBlock {
            paragraphs: vec![TextParagraph {
                align: TextAlign::Left,
                direction: TextDirection::Ltr,
                line_height: 1.2,
                letter_spacing: 0.0,
                spans: vec![span],
            }],
            grow: TextGrow::AutoWidth,
            vertical_align: VerticalAlign::Top,
        });
        scene.insert(label);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping clipped-document proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu clip-doc"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (256u32, 160u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        let mut resources = ();
        draw_scene(&mut ctx, &mut resources, &ClassicEnv, &mut text, &scene, Affine::IDENTITY, &Default::default());

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("clip-doc target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let data = read_back(&device, &queue, &texture, w, h);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        let p_in = px(100, 100);
        assert!(p_in[2] > 150 && p_in[0] < 90, "inside frame should be blue, got {p_in:?}");
        let p_clip = px(150, 150);
        assert!(
            p_clip[0] > 230 && p_clip[1] > 230 && p_clip[2] > 230,
            "overflow past the frame must be clipped to white, got {p_clip:?}"
        );
        let red_ink = (36..90).any(|y| {
            (150..250).any(|x| {
                let p = px(x, y);
                p[0] > 120 && p[1] < 90 && p[2] < 90
            })
        });
        assert!(red_ink, "expected red text ink in the label band");

        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-c-classic-clip-text-document.png");
        if let Ok(file) = std::fs::File::create(out) {
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            if let Ok(mut wr) = enc.write_header() {
                let _ = wr.write_image_data(&data);
            }
        }
    }

    #[test]
    fn classic_renders_a_box_drop_shadow() {
        use render_core::kurbo::{Affine, Rect as PageRect, RoundedRectRadii, Vec2};
        use render_core::model::{Brush, Node, Paint, Scene, Shadow, ShapeKind, ROOT_ID};
        use render_core::peniko::Color;
        use crate::walk::draw_scene;
        use render_core::vello::text::TextState;

        let mut scene = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = vec![1];
        scene.insert(root);
        let mut card = Node::new(1, ShapeKind::Rect);
        card.bounds = PageRect::new(60.0, 40.0, 150.0, 110.0);
        card.corners = Some(RoundedRectRadii::from_single_radius(12.0));
        card.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(240, 240, 245, 255)))];
        card.shadows = vec![Shadow {
            color: Color::from_rgba8(0, 0, 0, 140),
            blur: 8.0,
            spread: 0.0,
            offset: Vec2::new(14.0, 16.0),
            inset: false,
        }];
        scene.insert(card);

        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("no wgpu adapter — skipping drop-shadow proof");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("vello-gpu shadow"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .expect("device");

        let (w, h) = (256u32, 160u32);
        let mut renderer = ClassicRenderer::new(&device);
        let mut ctx = renderer.new_scene(w as u16, h as u16);
        let mut resources = ();
        let mut text = TextState::new();
        draw_scene(&mut ctx, &mut resources, &ClassicEnv, &mut text, &scene, Affine::IDENTITY, &Default::default());

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("shadow target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
        queue.submit([enc.finish()]);
        renderer.release_pending();

        let data = read_back(&device, &queue, &texture, w, h);

        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-c-classic-drop-shadow.png");
        if let Ok(file) = std::fs::File::create(out) {
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            if let Ok(mut wr) = enc.write_header() {
                let _ = wr.write_image_data(&data);
            }
        }

        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = ((y * w + x) * 4) as usize;
            [data[o], data[o + 1], data[o + 2], data[o + 3]]
        };
        let shadow_px = (111..150).any(|y: u32| {
            (150..190).any(|x: u32| {
                let p = px(x, y);
                p[0] < 235 && p[0] > 40 && (p[0] as i32 - p[2] as i32).abs() < 45
            })
        });
        assert!(shadow_px, "expected a soft grey drop shadow below-right of the card");
        let c = px(100, 75);
        assert!(c[0] > 225 && c[1] > 225, "card fill should be near-white, got {c:?}");
        let bg = px(6, 6);
        assert!(bg[0] > 245 && bg[1] > 245 && bg[2] > 245, "corner should be white, got {bg:?}");
    }
}
