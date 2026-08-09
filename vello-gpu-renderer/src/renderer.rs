//! The classic-Vello wasm backend shell: an embeddable renderer over a host `<canvas>`, the peer of
//! render-vello's `FocusRenderer` but built on the **compute** pipeline.
//!
//! Same host contract (`create_focus_renderer(canvas)` → `render()` / `resize()` / `set_transform()`;
//! no internal loop) so the skia-rs-wasm loader drives it exactly like the hybrid module — only the
//! artifact URL and the WebGPU gate differ. Classic is WebGPU-only (no WebGL fallback: the whole point
//! is GPU coarse rasterization), and it drives the *shared* `render_vello_core::sink::Sink` with
//! [`ClassicBackend`](crate::ClassicBackend), so the scheduler + tile cache + effect executor are the
//! very same code the hybrid backend runs.

#![allow(clippy::cast_possible_truncation, reason = "device pixels fit u32 in this spike")]

use std::collections::HashSet;

use render_core::schedule::build_visible;
use render_core::tiling::TileKey;
use render_vello_core::sink::Sink;
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

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("vello-gpu device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .expect("device");

        let gpu = Self { device, queue, surface };
        gpu.configure(canvas.width(), canvas.height());
        gpu
    }

    fn configure(&self, width: u32, height: u32) {
        self.surface.configure(
            &self.device,
            &wgpu::SurfaceConfiguration {
                // The sink composites tiles onto the swapchain through the shared compositor (a render
                // pipeline), so RENDER_ATTACHMENT is all it needs.
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
    render_vello_core::abi::take_needs_frame()
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
        // Register any faces + images the host staged since last frame, so text and image fills drawn
        // below resolve their font / pixels.
        self.backend.sync_fonts();
        self.backend.upload_pending_images();

        let surface_texture = match self.gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) => t,
            other => {
                if matches!(other, wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Validation) {
                    log::warn!("vello-gpu surface unavailable: {other:?}");
                }
                return;
            }
        };

        let root = self.transform;
        let full_view = render_vello_core::abi::effective_view(root);
        let (dirty_all, dirty_rects) = render_vello_core::abi::take_dirty();
        let dirty = self.sink.plan_frame(full_view, self.width, self.height, dirty_all, &dirty_rects);
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
        // Timed the same way as hybrid's, so the `build` bucket is comparable across backends.
        let _tb = render_vello_core::prof::now();
        let schedule = render_vello_core::abi::with_scene(|live, viewport, modifiers| {
            build_visible(live, root * viewport, modifiers, &dirty_set)
        });
        render_vello_core::prof::add_build(render_vello_core::prof::now() - _tb);

        self.sink.execute(
            &schedule,
            &dirty,
            &mut self.backend,
            &self.gpu.device,
            &self.gpu.queue,
            &surface_texture.texture,
            root,
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
