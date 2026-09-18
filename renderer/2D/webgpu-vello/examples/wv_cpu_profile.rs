//! CPU-side decomposition of the whole-viewport frame at document scale — the numbers behind the
//! "GPU-resident scene" decision.
//!
//! Loads the 20k-shape scale fixture (effects every 25 shapes), renders real frames through the
//! shared sink at 4K, and reports:
//!   - the frame's own phase buckets: gather detection (126), encode block (130 = dbg 30),
//!     `scene` (the walk), phase-loop record;
//!   - isolated component costs measured directly over the same model: node lookup + matrix math,
//!     `outline()` construction (the per-shape `BezPath`), so the walk total splits into
//!     "our translation" vs "vello's encoding appends" by subtraction.
//!
//! Run: `cargo run --release --example wv_cpu_profile [N] [EVERY]`.

use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 3840;
const H: u32 = 2160;
const WARMUP: usize = 2;
const TIMED: usize = 8;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(20000);
    let every: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(25);

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_cpu_profile"),
        required_features: adapter.features() & wgpu::Features::TIMESTAMP_QUERY,
        ..Default::default()
    }))
    .expect("device");

    let step: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(26.0);
    let size: f32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1.9);
    let cells = render_core::vello::abi::load_scale_scene_sized(n, every, step, size, 7);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    println!("scene: {n} shapes, effect every {every} ({cells} effect cells), {W}x{H}\n");

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("profile target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, FORMAT);
    backend.sync_fonts();
    backend.upload_pending_images();

    let frame = |sink: &mut Sink, backend: &mut ClassicBackend| {
        render_core::vello::abi::set_view(1.0, 0.0, 0.0);
        sink.render_whole_viewport(backend, &device, &queue, &target, Affine::IDENTITY, W, H, true);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
    };

    for _ in 0..WARMUP {
        frame(&mut sink, &mut backend);
    }

    let read = |which: u32| render_core::vello::abi::prof_read(which);
    let base: Vec<f64> = [0u32, 1, 2, 3, 126, 127, 18, 19].iter().map(|&b| read(b)).collect();
    let (p0, d0) = vello::low_level::dispatch_stats();
    let mut cpu_ms = 0.0f64;
    let mut poll_ms = 0.0f64;
    let t0 = Instant::now();
    for _ in 0..TIMED {
        render_core::vello::abi::set_view(1.0, 0.0, 0.0);
        let tc = Instant::now();
        sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, W, H, true);
        cpu_ms += tc.elapsed().as_secs_f64() * 1000.0;
        let tp = Instant::now();
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        poll_ms += tp.elapsed().as_secs_f64() * 1000.0;
    }
    let wall = t0.elapsed().as_secs_f64() * 1000.0 / TIMED as f64;
    println!("render call (all CPU)  {:8.3} ms   poll wait (GPU drain) {:8.3} ms", cpu_ms / TIMED as f64, poll_ms / TIMED as f64);
    let (p1, d1) = vello::low_level::dispatch_stats();
    let delta = |i: usize, b: u32| (read(b) - base[i]) / TIMED as f64;

    println!("== real frames (avg of {TIMED}, 4K) ==");
    println!("wall/frame            {wall:8.3} ms  (includes GPU wait)");
    println!("build (sched)         {:8.3} ms", delta(0, 0));
    println!("scene (encode walk)   {:8.3} ms", delta(1, 1));
    println!("render (record)       {:8.3} ms", delta(2, 2));
    println!("submit                {:8.3} ms", delta(3, 3));
    println!("gather detect         {:8.3} ms", delta(4, 126));
    println!("phase loop record     {:8.3} ms", delta(5, 127));
    let gpu_frames = read(19) - base[7];
    if gpu_frames > 0.0 {
        println!("GPU busy/frame        {:8.3} ms  (frame-span timestamps, {} samples)", (read(18) - base[6]) / gpu_frames, gpu_frames as u64);
    }
    println!(
        "compute passes/frame  {:8.1}     dispatches/frame {:8.1}",
        (p1 - p0) as f64 / TIMED as f64,
        (d1 - d0) as f64 / TIMED as f64
    );

    println!("\n== isolated components (same model, avg of {TIMED}) ==");
    let reps = TIMED;

    let t = Instant::now();
    let mut sink_ids: u64 = 0;
    for _ in 0..reps {
        render_core::vello::abi::with_scene(|scene, _, _| {
            for &id in scene.roots() {
                if let Some(node) = scene.get(id) {
                    sink_ids = sink_ids.wrapping_add(node.bounds.x0 as u64);
                }
            }
        });
    }
    let t_lookup = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    println!("roots iter + get()    {t_lookup:8.3} ms   (hash lookups only)");

    let t = Instant::now();
    let mut acc = 0.0f64;
    for _ in 0..reps {
        render_core::vello::abi::with_scene(|scene, _, _| {
            for &id in scene.roots() {
                if let Some(node) = scene.get(id) {
                    let m = node.effective_transform();
                    acc += m.as_coeffs()[4];
                }
            }
        });
    }
    let t_matrix = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    println!("+ effective_transform {t_matrix:8.3} ms   (lookup + matrix)");

    let t = Instant::now();
    let mut verts = 0usize;
    for _ in 0..reps {
        render_core::vello::abi::with_scene(|scene, _, _| {
            for &id in scene.roots() {
                if let Some(node) = scene.get(id) {
                    let p = render_core::geometry::outline(node);
                    verts += p.elements().len();
                }
            }
        });
    }
    let t_outline = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    println!("+ outline() build     {t_outline:8.3} ms   (lookup + matrix-free BezPath per shape)");

    println!("\n== derived ==");
    let scene_ms = delta(1, 1);
    println!("outline share of walk  ~{:5.1}%", 100.0 * (t_outline - t_lookup) / scene_ms.max(0.001));
    println!("lookups share of walk  ~{:5.1}%", 100.0 * t_lookup / scene_ms.max(0.001));
    println!(
        "residual (paint conv + vello encode appends + layers) ~{:.3} ms",
        (scene_ms - (t_outline - t_lookup) - t_lookup - (t_matrix - t_lookup)).max(0.0)
    );
    let _ = (sink_ids, acc, verts);
}
