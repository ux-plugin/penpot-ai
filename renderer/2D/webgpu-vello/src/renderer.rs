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

        // Ask for timestamp queries when the adapter has them, so the sink can report real GPU
        // execution time instead of leaving it to be inferred from frame pacing. Strictly optional:
        // every CPU bucket measures only how long it took to *record* commands, so without this
        // there is no measurement of the GPU at all. Requested, never required — an adapter without
        // it just reports zero.
        let timestamps = adapter.features() & wgpu::Features::TIMESTAMP_QUERY;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("vello-gpu device"),
                required_features: timestamps,
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
        // Register any faces + images the host staged since last frame, so text and image fills drawn
        // below resolve their font / pixels.
        self.backend.sync_fonts();
        self.backend.upload_pending_images();

        // DIAG (bucket 15 → prof_read(115)): swapchain acquire time. Under Fifo present mode this is
        // where the CPU blocks on vsync, so it captures the "phantom floor" that otherwise hides in the
        // untimed `other` remainder — separating display idle from real per-frame work.
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

        // Classic renders the whole document as ONE native vello scene: one walk, one rasterize, no
        // schedule. There is no tiled branch here any more.
        //
        // The 512-tile scheduler remains the hybrid/WebGL2 backend's path, and the A/B harnesses drive
        // it directly as the reference to check this against. Classic stopped needing it once the
        // whole-viewport path could render every effect: the last gate, `whole_viewport_can_render`,
        // only diverted scenes carrying a typed `filter_graph`, and the tiled path cannot draw those
        // either (`push_filter_layer` is an inert stub there), so falling back bought nothing but a
        // slower frame that dropped the same effect.
        //
        // Drain dirty here so the abi stays the single dirty consumer; hand the "content changed" bit
        // to the sink's present-on-demand gate (a view/dims change it detects itself).
        let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
        let content_dirty = dirty_all || !dirty_rects.is_empty();
        self.sink.render_whole_viewport(
            &mut self.backend, &self.gpu.device, &self.gpu.queue,
            &surface_texture.texture, root, self.width, self.height, content_dirty,
        );
        // Swapchain hand-off. The one place in the frame where the browser could plausibly make the
        // CPU wait on the compositor, so it is worth its own bucket rather than the remainder.
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
