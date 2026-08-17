//! What is the whole-viewport GPU cost made of NOW that the effect passes are extent-cropped?
//!
//! Two sweeps, both at a fixed 4K target:
//!
//! 1. **Shrink the shapes** (zoom 1.0 → 0.25). Every effect surface is sized to the shape's extent, so
//!    the PIXELS each pass touches fall with the square of the zoom (16× less at 0.25). If the frame
//!    time falls with it, the remaining cost is still pixel work. If it stays FLAT, the cost is
//!    per-call fixed overhead — each `backend.rasterize` / pass-graph pays a setup price independent
//!    of its size, and the fix is to reduce the NUMBER of calls, not their size.
//!
//! 2. **Grow the node count** (3 → 24) at fixed zoom. Cost per node isolates the same thing: a heavy
//!    node costs 5 vello rasterizes (2 drop silhouettes, 2 inner band/punch, 1 body) + 3 pass-graphs.
//!
//! Run: `cargo run --release --example wv_effect_floor`.

use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 3840;
const H: u32 = 2160;
const WARMUP: usize = 2;
const TIMED: usize = 6;

/// Median (total, cpu) ms for `n` heavy nodes rendered at `zoom_mul` × the fit zoom.
fn time_it(device: &wgpu::Device, queue: &wgpu::Queue, backend: &mut ClassicBackend, target: &wgpu::Texture, n: u32, zoom_mul: f32) -> (f64, f64) {
    let root = Affine::IDENTITY;
    let mut sink = Sink::new(device, FORMAT);
    let (mut tot, mut rec) = (Vec::new(), Vec::new());
    for i in 0..(WARMUP + TIMED) {
        let cells = render_core::vello::abi::load_stress_scene_mask(n, render_core::parity::FX_ALL);
        let (cw, ch) = render_core::parity::canvas_size(cells as usize);
        let zoom = (W as f32 / cw as f32).min(H as f32 / ch as f32) * zoom_mul;
        render_core::vello::abi::set_render_options(0, 1.0);
        render_core::vello::abi::set_view(zoom, 0.0, 0.0);
        render_core::vello::abi::set_canvas_background(0xffff_ffff);
        render_core::vello::abi::set_wv_phased(0);
        render_core::vello::abi::set_cmd_effect(0);
        backend.sync_fonts();
        backend.upload_pending_images();
        render_core::vello::prof::reset();
        let t0 = Instant::now();
        let _ = render_core::vello::abi::take_dirty();
        sink.render_whole_viewport(backend, device, queue, target, root, W, H, true);
        let r = t0.elapsed().as_secs_f64() * 1000.0;
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let t = t0.elapsed().as_secs_f64() * 1000.0;
        if i >= WARMUP {
            tot.push(t);
            rec.push(r);
        }
    }
    tot.sort_by(|a, b| a.partial_cmp(b).unwrap());
    rec.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (tot[tot.len() / 2], rec[rec.len() / 2])
}

fn main() {
    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no adapter");
        return;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("floor"), ..Default::default() })).expect("device");
    let mut backend = ClassicBackend::new(&device);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("floor target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });

    println!("target {W}x{H}, whole-viewport per-segment, extent-cropped effect passes.\n");
    println!("1) SHRINK THE SHAPES (12 nodes). Effect-pass pixels scale with zoom^2.");
    println!("{:>8} {:>12} {:>10} {:>10} {:>12}", "zoom", "px/pass rel", "total ms", "cpu ms", "gpu ms");
    for &z in &[1.0f32, 0.7, 0.5, 0.25] {
        let (t, c) = time_it(&device, &queue, &mut backend, &target, 12, z);
        println!("{z:>8.2} {:>12} {t:>10.1} {c:>10.1} {:>12.1}", format!("{:.2}×", z * z), t - c);
    }

    println!("\n2) GROW THE NODE COUNT (zoom 1.0). Each heavy node = 5 rasterizes + 3 pass-graphs.");
    println!("{:>8} {:>10} {:>10} {:>12} {:>9} {:>8} {:>12}", "nodes", "total ms", "cpu ms", "gpu ms", "rasters", "graphs", "gpu ms/call");
    for &n in &[3u32, 6, 12, 24] {
        let (t, c) = time_it(&device, &queue, &mut backend, &target, n, 1.0);
        // `renders` counts backend.rasterize (a whole vello pipeline run); `graphs` counts run_graph.
        let (r, g) = (render_core::vello::prof::read(7), render_core::vello::prof::read(14));
        println!("{n:>8} {t:>10.1} {c:>10.1} {:>12.1} {r:>9.0} {g:>8.0} {:>12.2}", t - c, (t - c) / (r + g).max(1.0));
    }

    println!("\nFlat in sweep 1 => cost is PER-CALL overhead, not pixels: cut the number of");
    println!("rasterizes/pass-graphs (batch them), don't shrink them further.");
}
