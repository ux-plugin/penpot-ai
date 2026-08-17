//! Native rasterization head-to-head: classic vello (GPU coarse) vs vello_hybrid (CPU coarse).
//!
//! Tests the fork's core bet — does moving coarse rasterization onto the GPU actually win on heavy
//! vector scenes? Both backends build the SAME scene through the shared `RenderingContext`, then we
//! time the *rasterize* call (coarse + fine → texture), scaling the path count.
//!
//! Scope + caveats (read before trusting a number): fills only (no text on classic yet), no effects
//! / tiling / scheduler (those are the same on both, via our own run_graph), native Metal not browser
//! WebGPU (same wgpu, so the RELATIVE number is fair). Classic compiles all shader permutations at
//! Renderer::new — warmed out below. Run in release:  cargo run -p vello-gpu-renderer --example
//! raster_bench --release

use pollster::block_on;
use vello_common::kurbo::{Affine, BezPath, Point};
use vello_common::peniko::{Brush, Color};
use vello_example_scenes::{Fill, RenderingContext};
use vello_gpu_renderer::{ClassicCtx, ClassicRenderer};
use render_core::vello::rasterize::SceneRasterizer;

const W: u16 = 2048;
const H: u16 = 2048;
const WARMUP: u32 = 3;
const ITERS: u32 = 30;

/// Deterministic LCG so both backends build byte-identical scenes.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f64) / ((1u64 << 31) as f64)
    }
}

/// Draw `n` 12-point stars (24 edges each) at scattered positions in solid colors — enough edges to
/// give the coarse rasterizer real work. Identical for any `RenderingContext`, so the two backends
/// rasterize the same geometry.
fn build_scene<C: RenderingContext>(ctx: &mut C, n: usize) {
    let palette = [
        Color::from_rgba8(61, 123, 253, 255),
        Color::from_rgba8(245, 197, 24, 255),
        Color::from_rgba8(230, 57, 70, 255),
        Color::from_rgba8(42, 157, 143, 255),
        Color::from_rgba8(160, 107, 216, 255),
        Color::from_rgba8(239, 138, 58, 255),
    ];
    let mut rng = Rng(0xBEEF_CAFE);
    let points = 12u32;
    for i in 0..n {
        let cx = rng.next() * f64::from(W);
        let cy = rng.next() * f64::from(H);
        let outer = 18.0 + rng.next() * 34.0;
        let inner = outer * 0.45;
        let mut path = BezPath::new();
        for k in 0..(points * 2) {
            let r = if k % 2 == 0 { outer } else { inner };
            let a = f64::from(k) * std::f64::consts::PI / f64::from(points);
            let p = Point::new(cx + r * a.cos(), cy + r * a.sin());
            if k == 0 {
                path.move_to(p);
            } else {
                path.line_to(p);
            }
        }
        path.close_path();
        ctx.set_fill_rule(Fill::NonZero);
        ctx.set_transform(Affine::IDENTITY);
        ctx.set_paint(Brush::Solid(palette[i % palette.len()]));
        ctx.fill_path(&path);
    }
}

fn gpu() -> (wgpu::Device, wgpu::Queue, wgpu::AdapterInfo) {
    let instance = wgpu::Instance::default();
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .expect("no wgpu adapter");
    let info = adapter.get_info();
    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("raster-bench"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .expect("device");
    (device, queue, info)
}

fn target(device: &wgpu::Device, usage: wgpu::TextureUsages) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("bench target"),
            size: wgpu::Extent3d { width: W.into(), height: H.into(), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

/// Median of a set of timings (ms).
fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn bench_classic(device: &wgpu::Device, queue: &wgpu::Queue, n: usize) -> (f64, f64) {
    let mut renderer = ClassicRenderer::new(device);
    let mut ctx = ClassicCtx::new(W, H);
    let t0 = std::time::Instant::now();
    build_scene(&mut ctx, n);
    let build_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let view = target(device, wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC);
    let mut times = Vec::new();
    for it in 0..(WARMUP + ITERS) {
        let s = std::time::Instant::now();
        renderer.rasterize(&ctx, device, queue, &view, W.into(), H.into(), Color::WHITE);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        if it >= WARMUP {
            times.push(s.elapsed().as_secs_f64() * 1000.0);
        }
    }
    (build_ms, median(times))
}

fn bench_hybrid(device: &wgpu::Device, queue: &wgpu::Queue, n: usize) -> (f64, f64) {
    let mut renderer = vello_hybrid::Renderer::new(
        device,
        &vello_hybrid::RenderTargetConfig { format: wgpu::TextureFormat::Rgba8Unorm, width: W.into(), height: H.into() },
    );
    let mut resources = vello_hybrid::Resources::new();
    let mut scene = vello_hybrid::Scene::new(W, H);
    let t0 = std::time::Instant::now();
    build_scene(&mut scene, n);
    let build_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let view = target(device, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let size = vello_hybrid::RenderSize { width: W.into(), height: H.into() };
    let mut times = Vec::new();
    for it in 0..(WARMUP + ITERS) {
        let s = std::time::Instant::now();
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        renderer
            .render(&scene, &mut resources, device, queue, &mut enc, &size, &view, &vello_hybrid::TextureBindings::new())
            .unwrap();
        queue.submit([enc.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        if it >= WARMUP {
            times.push(s.elapsed().as_secs_f64() * 1000.0);
        }
    }
    (build_ms, median(times))
}

fn main() {
    let (device, queue, info) = gpu();
    println!("adapter: {} ({:?}, {:?})\n", info.name, info.backend, info.device_type);
    println!("{:>8}  {:>22}  {:>22}", "paths", "classic (GPU coarse)", "hybrid (CPU coarse)");
    println!("{:>8}  {:>10} {:>10}  {:>10} {:>10}", "", "build", "render", "build", "render");
    for &n in &[500usize, 2000, 8000, 20000] {
        let (cb, cr) = bench_classic(&device, &queue, n);
        let (hb, hr) = bench_hybrid(&device, &queue, n);
        println!(
            "{n:>8}  {cb:>9.2}ms {cr:>9.2}ms  {hb:>9.2}ms {hr:>9.2}ms   render x{:.2}",
            hr / cr
        );
    }
    println!("\n(render = coarse+fine rasterize to texture, incl. GPU wait; median of {ITERS} after {WARMUP} warmup)");
}
