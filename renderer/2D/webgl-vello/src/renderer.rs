// Copyright 2026 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Phase 0 of the "Vello as a second render-wasm backend" plan: an **embeddable**
//! wasm-bindgen + wgpu Vello renderer.
//!
//! Unlike the `wgpu_webgl` demo — which creates its own canvas and owns the
//! animation-frame loop — [`FocusRenderer`] is a self-contained component that:
//!   * mounts onto a **host-provided** `<canvas>`,
//!   * exposes discrete `render()` / `resize()` / `key()` calls,
//!   * owns **no** event loop or `requestAnimationFrame` — the host drives it.
//!
//! That is exactly the shape Penpot's focus mode would consume: the CLJS host
//! creates the canvas, constructs the renderer, and calls `render()` when it wants
//! a frame. `main.rs` is a *mock host* that plays that role for local testing.

#![allow(
    clippy::cast_possible_truncation,
    reason = "truncation has no appreciable impact in this Phase-0 proof"
)]

use vello_common::kurbo::Affine;
use vello_example_scenes::{AnyScene, custom_filter, nested_ui, stacked_effects};
use vello_hybrid::{RenderSettings, RenderTargetConfig, Renderer, Scene};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
use wgpu::{
    CurrentSurfaceTexture,
    rwh::{DisplayHandle, HandleError, HasDisplayHandle},
};

#[derive(Debug)]
struct OurDisplayHandle;
impl HasDisplayHandle for OurDisplayHandle {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Ok(DisplayHandle::web())
    }
}

/// The wgpu device/surface/renderer bundle bound to the host canvas.
struct RendererWrapper {
    renderer: Renderer,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_format: wgpu::TextureFormat,
}

impl RendererWrapper {
    async fn new(canvas: HtmlCanvasElement) -> Self {
        let width = canvas.width();
        let height = canvas.height();

        // Hybrid is the WebGL2 backend, full stop. Real WebGPU is owned by the classic
        // (vello-gpu-renderer) backend, which capability routing selects ahead of this one;
        // by the time we reach here WebGL2 is the target, so request the GL backend directly
        // with no WebGPU attempt or fallback ladder.
        async fn request_gl(
            canvas: &HtmlCanvasElement,
        ) -> Option<(wgpu::Instance, wgpu::Surface<'static>, wgpu::Adapter)> {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::GL,
                ..wgpu::InstanceDescriptor::new_with_display_handle(Box::new(OurDisplayHandle))
            });
            let surface = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .ok()?;
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    compatible_surface: Some(&surface),
                    ..Default::default()
                })
                .await
                .ok()?;
            Some((instance, surface, adapter))
        }

        let (_instance, surface, adapter) = request_gl(&canvas)
            .await
            .expect("WebGL2 adapter unavailable for hybrid render-vello backend");

        let info = adapter.get_info();
        log::info!(
            "render-vello backend = {:?} | adapter = {} ({:?})",
            info.backend,
            info.name,
            info.device_type
        );

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("render-vello device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .expect("Device to be valid");

        // Present to a NON-sRGB (Unorm) surface, matching vello_hybrid's own examples and the classic
        // backend (both target Rgba8Unorm). On this ANGLE/WebGL2 the surface offered an sRGB format
        // first, which double-encoded vello's already-sRGB output and washed the image out
        // (#3B82F6@85% came out 158,201,252 = srgb_encode of the correct 88,149,247). Choosing a
        // non-sRGB format removes that double-encode. Verified on real WebGL2: opaque and translucent
        // fills now match the classic backend exactly (e.g. #3B82F6@85% over white → 88,149,247).
        let surface_caps = surface.get_capabilities(&adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| surface_caps.formats.first().copied())
            .unwrap_or(wgpu::TextureFormat::Rgba8Unorm);

        let surface_config = wgpu::SurfaceConfiguration {
            // RENDER_ATTACHMENT only: the tile store composites each tile's centre onto the
            // swapchain with a Compositor *draw*, not a copy — WebGL2 surfaces advertise
            // COLOR_TARGET only and reject COPY_DST at configure time.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            desired_maximum_frame_latency: 2,
            view_formats: vec![],
        };
        surface.configure(&device, &surface_config);

        let renderer = Renderer::new_with(
            &device,
            &RenderTargetConfig {
                format: surface_format,
                width,
                height,
            },
            RenderSettings {
                level: vello_common::fearless_simd::Level::try_detect()
                    .unwrap_or(vello_common::fearless_simd::Level::baseline()),
                // Give the filter atlas headroom so the effect-heavy focus scenes can push far
                // before hitting Vello's hard cap (auto-clamped to the backend's real limit).
                filter_atlas_config: vello_common::multi_atlas::AtlasConfig {
                    initial_atlas_count: 0,
                    max_atlases: 32,
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        Self {
            renderer,
            device,
            queue,
            surface,
            surface_format,
        }
    }

    fn reconfigure(&self, width: u32, height: u32) {
        let surface_config = wgpu::SurfaceConfiguration {
            // RENDER_ATTACHMENT only: the tile store composites each tile's centre onto the
            // swapchain with a Compositor *draw*, not a copy — WebGL2 surfaces advertise
            // COLOR_TARGET only and reject COPY_DST at configure time.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: self.surface_format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            desired_maximum_frame_latency: 2,
            view_formats: vec![],
        };
        self.surface.configure(&self.device, &surface_config);
    }
}

/// An embeddable Vello renderer bound to a host `<canvas>`.
///
/// The host owns the lifecycle: construct via [`create_focus_renderer`], then call
/// [`FocusRenderer::render`] to produce a frame, [`FocusRenderer::resize`] on canvas
/// resize, and [`FocusRenderer::key`] to forward input. There is no internal loop.
#[wasm_bindgen]
pub struct FocusRenderer {
    canvas: HtmlCanvasElement,
    wrapper: RendererWrapper,
    scenes: Vec<AnyScene<Scene>>,
    current: usize,
    transform: Affine,
    width: u32,
    height: u32,
    tiles: crate::tiles::VelloTileStore,
}

/// Construct a [`FocusRenderer`] on a host-provided canvas. Async because adapter/device
/// acquisition is async; the JS side receives a `Promise<FocusRenderer>`.
/// Wire panic messages and `log` output to the browser console the first time the host builds a
/// renderer. `main.rs` does this for the mock host; the library path (what the app loads) had no
/// logger, so `log::warn!` diagnostics — including frame-skip warnings — were silently dropped.
fn ensure_logging() {
    use std::sync::Once;
    static START: Once = Once::new();
    START.call_once(|| {
        console_error_panic_hook::set_once();
        // Warn, not Debug: this ships in the library path, so keep it to real problems
        // (frame skips, surface loss) rather than per-frame chatter.
        let _ = console_log::init_with_level(log::Level::Warn);
    });
}

#[wasm_bindgen]
pub async fn create_focus_renderer(canvas: HtmlCanvasElement) -> FocusRenderer {
    ensure_logging();
    let width = canvas.width();
    let height = canvas.height();
    let wrapper = RendererWrapper::new(canvas.clone()).await;

    // The "focus scenes": stand-ins for what focus mode would hand off. These are
    // self-contained (no image resources) so the module needs only a minimal handoff.
    let scenes: Vec<AnyScene<Scene>> = vec![
        // The end-to-end proof: a neutral render_core::model scene, drawn by Vello.
        AnyScene::new(crate::scene::NeutralModelScene::new()),
        AnyScene::new(nested_ui::NestedUiScene::new()),
        AnyScene::new(custom_filter::CustomFilterScene::new()),
        AnyScene::new(stacked_effects::StackedEffectsScene::new()),
    ];

    let tiles = crate::tiles::VelloTileStore::new(wrapper.surface_format);
    FocusRenderer {
        canvas,
        wrapper,
        scenes,
        current: 0,
        transform: Affine::IDENTITY,
        width,
        height,
        tiles,
    }
}

#[wasm_bindgen]
impl FocusRenderer {
    /// Drain images staged by `store_image_rgba` into the GPU atlas.
    ///
    /// Runs here, not in the ABI, because the atlas needs the wgpu device and queue this struct
    /// owns (D2). Each image is uploaded once — the ABI only stages *new* ids — and the resulting
    /// `ImageId` is recorded so `scene.rs` can resolve a `Brush::Image` against it. Uploading is
    /// its own submitted encoder, before the draw, so the atlas is populated when the frame reads
    /// it.
    fn upload_pending_images(&mut self) {
        // Bake any new diamonds first, so they ride the same upload as real images.
        crate::abi::stage_diamond_bakes();
        let pending = crate::abi::take_pending_images();
        if pending.is_empty() {
            return;
        }
        let mut encoder = self
            .wrapper
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("upload images"),
            });
        let resources = self.scenes[self.current].resources_mut();
        for image in pending {
            let Some(pixmap) = pixmap_from_rgba(&image) else {
                continue;
            };
            let image_id = self.wrapper.renderer.upload_image(
                resources,
                &self.wrapper.device,
                &self.wrapper.queue,
                &mut encoder,
                &pixmap,
            );
            crate::abi::record_image(image.id, image_id);
        }
        self.wrapper.queue.submit([encoder.finish()]);
    }

    /// Render one frame into the host canvas, **tiled** (D18): each visible tile is rasterized into
    /// its own content+margin buffer — so an effect runs against the tile, not the viewport — and
    /// the centres are composited onto the surface. The host decides when to call this.
    pub fn render(&mut self) {
        self.upload_pending_images();

        let surface_texture = match self.wrapper.surface.get_current_texture() {
            CurrentSurfaceTexture::Success(t) => t,
            CurrentSurfaceTexture::Occluded
            | CurrentSurfaceTexture::Timeout
            | CurrentSurfaceTexture::Outdated
            | CurrentSurfaceTexture::Suboptimal(_) => return,
            CurrentSurfaceTexture::Lost => {
                log::warn!("surface lost");
                return;
            }
            CurrentSurfaceTexture::Validation => {
                log::warn!("surface validation error");
                return;
            }
        };
        self.tiles.render_frame(
            &mut self.wrapper.renderer,
            &self.wrapper.device,
            &self.wrapper.queue,
            &surface_texture.texture,
            &mut self.scenes[self.current],
            self.transform,
            self.width,
            self.height,
        );

        surface_texture.present();
    }

    /// Resize the render surface when the host canvas changes size.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.width = width;
        self.height = height;
        self.wrapper.reconfigure(width, height);
        // The tile store recreates its surface-sized composite scene on the next frame when it
        // notices the dimensions changed; the tile buffers are fixed-size and need no resize.
    }

    /// Forward a key press to the active scene (e.g. ArrowUp grows the nested-UI scene).
    /// Returns true if the scene consumed it (host should re-render).
    pub fn key(&mut self, key: &str) -> bool {
        self.scenes[self.current].handle_key(key)
    }

    /// Switch which focus scene is shown.
    pub fn set_scene(&mut self, index: usize) {
        if !self.scenes.is_empty() {
            self.current = index % self.scenes.len();
            self.transform = Affine::IDENTITY;
        }
    }

    /// Number of available focus scenes.
    pub fn scene_count(&self) -> usize {
        self.scenes.len()
    }

    /// Set the view transform (a,b,c,d,e,f) — column-major affine, for pan/zoom/rotate.
    pub fn set_transform(&mut self, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) {
        self.transform = Affine::new([a, b, c, d, e, f]);
    }

    /// Reset the view transform to identity.
    pub fn reset_transform(&mut self) {
        self.transform = Affine::IDENTITY;
    }

    /// Status string from the active scene (element counts, scale, etc.).
    pub fn status(&self) -> Option<String> {
        self.scenes[self.current].status()
    }
}

/// Pack an ABI-staged image into a `Pixmap` the atlas can upload.
///
/// The wire bytes are **straight** (unpremultiplied) RGBA, top-left origin — that is what the
/// host's `getImageData` yields, and premultiplying it in JS would mean a per-pixel loop the
/// browser can't vectorise. The atlas wants premultiplied, so the multiply happens here, once,
/// in Rust. `None` when the byte count does not match the dimensions, which would panic in
/// `from_parts`.
fn pixmap_from_rgba(image: &crate::abi::PendingImage) -> Option<vello_common::pixmap::Pixmap> {
    let (w, h) = (image.width, image.height);
    if w == 0 || h == 0 || w > u32::from(u16::MAX) || h > u32::from(u16::MAX) {
        return None;
    }
    let expected = (w as usize) * (h as usize) * 4;
    if image.rgba.len() != expected {
        return None;
    }
    // Premultiply: `c · a / 255`, rounded. `+ 127` is the standard round-to-nearest for an
    // integer divide by 255; plain truncation darkens edges by up to a level.
    let mul = |c: u8, a: u8| ((u16::from(c) * u16::from(a) + 127) / 255) as u8;
    let pixels: Vec<vello_common::color::PremulRgba8> = image
        .rgba
        .chunks_exact(4)
        .map(|c| {
            let a = c[3];
            vello_common::color::PremulRgba8 {
                r: mul(c[0], a),
                g: mul(c[1], a),
                b: mul(c[2], a),
                a,
            }
        })
        .collect();
    Some(vello_common::pixmap::Pixmap::from_parts(
        pixels, w as u16, h as u16,
    ))
}
