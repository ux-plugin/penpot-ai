//! The classic-Vello wasm backend shell: an embeddable renderer over a host `<canvas>`, the peer of
//! render-vello's `FocusRenderer` but built on the **compute** pipeline.
//!
//! Same host contract (`create_focus_renderer(canvas)` → `render()` / `resize()` / `set_transform()`;
//! no internal loop) so the zoetrope-editor loader drives it exactly like the hybrid module — only the
//! artifact URL and the WebGPU gate differ. Classic is WebGPU-only (no WebGL fallback: the whole point
//! is GPU coarse rasterization), and it drives the *shared* `render_core::vello::sink::Sink` with
//! [`ClassicBackend`](crate::ClassicBackend), so the scheduler + tile cache + effect executor are the
//! very same code the hybrid backend runs.

#![allow(clippy::cast_possible_truncation, reason = "device pixels fit u32 in this spike")]

use std::collections::HashSet;

use render_core::tiling::TileKey;
use render_core::vello::sink::Sink;
use vello_common::kurbo::Affine;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
use wgpu::rwh::{DisplayHandle, HandleError, HasDisplayHandle};

use crate::ClassicBackend;

/// Classic vello writes its target from a compute shader, so the whole pipeline runs in `Rgba8Unorm`
/// (a storage-capable format). The swapchain is configured to it too, so the sink's compositor —
/// built for the swapchain format — matches every surface it renders into.
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

#[derive(Debug)]
struct OurDisplayHandle;
impl HasDisplayHandle for OurDisplayHandle {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Ok(DisplayHandle::web())
    }
}

/// The wgpu device/surface bundle bound to the host canvas.
struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
}

impl Gpu {
    async fn new(canvas: &HtmlCanvasElement) -> Self {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_with_display_handle(Box::new(OurDisplayHandle))
        });
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .expect("classic vello needs a WebGPU canvas surface");
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .expect("WebGPU adapter (classic vello is WebGPU-only)");
        let info = adapter.get_info();
        log::info!("vello-gpu backend = {:?} | adapter = {} ({:?})", info.backend, info.name, info.device_type);

        let timestamps = adapter.features() & wgpu::Features::TIMESTAMP_QUERY;
        // Adapter-specific format features unlock rgba8unorm READ-WRITE storage — the single
        // whole-viewport accumulator. On the browser the (patched) wgpu maps this bit to the
        // `texture-formats-tier2` feature; on native it surfaces the real per-format caps. Optional:
        // absent, the driver keeps the two-texture ping-pong.
        let format_caps =
            adapter.features() & wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("vello-gpu device"),
                required_features: timestamps | format_caps,
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .expect("device");
        let rw_accumulator = adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .flags
            .contains(wgpu::TextureFormatFeatureFlags::STORAGE_READ_WRITE)
            && !format_caps.is_empty();
        log::info!("vello-gpu rgba8unorm read-write storage: {rw_accumulator}");
        crate::set_rw_accumulator_supported(rw_accumulator);

        let gpu = Self { device, queue, surface };
        gpu.configure(canvas.width(), canvas.height());
        gpu
    }

    fn configure(&self, width: u32, height: u32) {
        self.surface.configure(
            &self.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: FORMAT,
                width: width.max(1),
                height: height.max(1),
                present_mode: wgpu::PresentMode::Fifo,
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                desired_maximum_frame_latency: 2,
                view_formats: vec![],
            },
        );
    }
}

/// Whether the host asked for a frame since this was last called (clearing the request). The loader's
/// `requestAnimationFrame` polls this and calls [`ClassicFocusRenderer::render`] when it's true —
/// identical to render-vello's `frame_requested`, so the shared loader drives either module.
#[wasm_bindgen]
pub fn frame_requested() -> bool {
    render_core::vello::abi::take_needs_frame()
}

/// Wire panics + `log` to the browser console once, mirroring render-vello's `ensure_logging`.
fn ensure_logging() {
    use std::sync::Once;
    static START: Once = Once::new();
    START.call_once(|| {
        console_error_panic_hook::set_once();
        let _ = console_log::init_with_level(log::Level::Warn);
    });
}

/// An embeddable classic-Vello renderer bound to a host `<canvas>`. Host-driven: construct via
/// [`create_focus_renderer`], then call [`ClassicFocusRenderer::render`] per frame.
#[wasm_bindgen]
pub struct ClassicFocusRenderer {
    canvas: HtmlCanvasElement,
    gpu: Gpu,
    sink: Sink,
    backend: ClassicBackend,
    transform: Affine,
    width: u32,
    height: u32,
}

/// Construct a [`ClassicFocusRenderer`] on a host-provided canvas. Async (adapter/device acquisition
/// is async); JS receives a `Promise`. Named `create_focus_renderer` to match the hybrid module, so
/// the loader's handoff is identical.
#[wasm_bindgen]
pub async fn create_focus_renderer(canvas: HtmlCanvasElement) -> ClassicFocusRenderer {
    ensure_logging();
    let (width, height) = (canvas.width(), canvas.height());
    let gpu = Gpu::new(&canvas).await;
    let sink = Sink::new(&gpu.device, FORMAT);
    let backend = ClassicBackend::new(&gpu.device);
    ClassicFocusRenderer { canvas, gpu, sink, backend, transform: Affine::IDENTITY, width, height }
}

#[wasm_bindgen]
impl ClassicFocusRenderer {
    /// Render one frame of the live document onto the host canvas through the shared sink.
    pub fn render(&mut self) {
        self.backend.sync_fonts();
        self.backend.sync_editor();
        self.backend.upload_pending_images();

        let _tacq = render_core::vello::prof::now();
        let acquired = self.gpu.surface.get_current_texture();
        render_core::vello::prof::dbg_add(15, render_core::vello::prof::now() - _tacq);
        let surface_texture = match acquired {
            wgpu::CurrentSurfaceTexture::Success(t) => t,
            other => {
                if matches!(other, wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Validation) {
                    log::warn!("vello-gpu surface unavailable: {other:?}");
                }
                return;
            }
        };

        let root = self.transform;

        let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
        let content_dirty = dirty_all || !dirty_rects.is_empty();
        self.sink.render_whole_viewport(
            &mut self.backend, &self.gpu.device, &self.gpu.queue,
            &surface_texture.texture, root, self.width, self.height, content_dirty,
        );
        let _tpr = render_core::vello::prof::now();
        surface_texture.present();
        render_core::vello::prof::add_present(render_core::vello::prof::now() - _tpr);
    }

    /// SPIKE — run the `register_texture` round-trip proof and hand the raw 512×512 RGBA bytes back to
    /// JS (as a `Uint8Array`) so the harness can paint + pixel-check them. Throwaway; see
    /// `ClassicRenderer::spike`.
    pub async fn spike(&mut self) -> Vec<u8> {
        self.backend
            .renderer_mut()
            .spike(&self.gpu.device, &self.gpu.queue)
            .await
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
        self.gpu.configure(width, height);
    }

    /// Set the view transform (a,b,c,d,e,f) — column-major affine, for pan/zoom/rotate.
    pub fn set_transform(&mut self, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) {
        self.transform = Affine::new([a, b, c, d, e, f]);
    }

    /// Reset the view transform to identity.
    pub fn reset_transform(&mut self) {
        self.transform = Affine::IDENTITY;
    }

    /// A short status string for the harness overlay.
    pub fn status(&self) -> Option<String> {
        Some(format!("vello-gpu · classic sink · {}×{}", self.width, self.height))
    }
}
