//! Frame-time bench for a HEAVY document under continuous zoom + pan: the `scale` fixture at N shapes
//! with a mix of effects (drop / blur / inner shadow / custom tint / STACK GLASS, one every `EVERY`
//! shapes), rendered over many frames while the view orbits and breathes. Times the DAG-edge executor
//! (the default) against the forced-legacy `WindowRole`/batched path (`WV_DAG=0 WV_DAG_EXEC=0`).
//!
//! This is the case the per-frame DAG rebuild is stressed by: a moving view re-runs `build_frame_dag`
//! + `fill_lens_uniforms` every frame (topology caching is parked), so a zoom/pan sweep measures
//! whether that fixed CPU cost is amortised by the heavy per-frame GPU work.
//!
//! Run: `SHAPES=20000 EVERY=40 FRAMES=60 cargo run --release --example wv_motion_bench`.

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

fn env<T: std::str::FromStr>(k: &str, d: T) -> T {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let n: u32 = env("SHAPES", 20000);
    let every: u32 = env("EVERY", 40);
    let (w, h): (u32, u32) = (env("W", 3840), env("H", 2160));
    let frames: u32 = env("FRAMES", 60);
    let step: f32 = env("STEP", 26.0);
    let size: f32 = env("SIZE", 1.9);
    let op_every: u32 = env("OPEVERY", 7);
    let base_zoom: f32 = env("ZOOM", 0.6);

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .ok()
        .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_motion_bench"),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .expect("device");
    device.set_device_lost_callback(|reason, msg| {
        eprintln!("DEVICE LOST: {reason:?} — {msg}");
    });

    let mut backend = ClassicBackend::new(&device);
    let root = Affine::IDENTITY;
    let cells = render_core::vello::abi::load_scale_scene_sized(n, every, step, size, op_every);
    render_core::vello::abi::init(w as i32, h as i32);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    backend.sync_fonts();
    backend.upload_pending_images();
    let effects = if every > 0 { n / every } else { 0 };
    let glasses = if every > 0 { (effects + 4) / 5 } else { 0 };
    println!("wv motion bench: {n} shapes, {effects} effects (~{glasses} stack glasses), {w}x{h}, {frames} frames/config");

    let view_at = |i: u32| {
        let t = i as f32 / frames.max(1) as f32 * std::f32::consts::TAU;
        let zoom = base_zoom * (1.0 + 0.35 * (t).sin());
        let pan_x = 900.0 * (t * 0.5).cos();
        let pan_y = 700.0 * (t * 0.5).sin();
        (zoom, pan_x, pan_y)
    };

    let mut time_it = |dag_build: bool, dag_exec: bool| -> f64 {
        unsafe {
            std::env::set_var("WV_DAG", if dag_build { "1" } else { "0" });
            std::env::set_var("WV_DAG_EXEC", if dag_exec { "1" } else { "0" });
        }
        let mut sink = Sink::new(&device, FORMAT);
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("wv motion target"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        for i in 0..10 {
            let (z, px, py) = view_at(i);
            render_core::vello::abi::set_view(z, px, py);
            let _ = render_core::vello::abi::take_dirty();
            sink.render_whole_viewport(&mut backend, &device, &queue, &target, root, w, h, true);
        }
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let mut per: Vec<f64> = Vec::with_capacity(frames as usize);
        for i in 0..frames {
            let (z, px, py) = view_at(i);
            render_core::vello::abi::set_view(z, px, py);
            let _ = render_core::vello::abi::take_dirty();
            let t0 = std::time::Instant::now();
            sink.render_whole_viewport(&mut backend, &device, &queue, &target, root, w, h, true);
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            per.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        let mut sorted = per.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = sorted[sorted.len() / 2];
        if std::env::var("WV_PERFRAME").is_ok() {
            let label = if dag_exec { "edge" } else if dag_build { "build" } else { "legacy" };
            let mean = per.iter().sum::<f64>() / per.len() as f64;
            eprintln!(
                "    [{label}] per-frame: median={median:.1} mean={mean:.1} min={:.1} max={:.1} first={:.1} last={:.1}",
                sorted[0], sorted[sorted.len() - 1], per[0], per[per.len() - 1],
            );
            if std::env::var("WV_PERFRAME_ALL").is_ok() {
                eprintln!("      seq: {}", per.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>().join(" "));
            }
        }
        median
    };

    let legacy = time_it(false, false);
    let build_only = time_it(true, false);
    let full = time_it(true, true);
    unsafe {
        std::env::remove_var("WV_DAG");
        std::env::remove_var("WV_DAG_EXEC");
    }
    let _ = cells;
    let pct = |x: f64| 100.0 * (x - legacy) / legacy;
    println!("  zoom+pan frame time (MEDIAN ms/frame, 10 warm-up frames excluded):");
    println!("    legacy (no DAG)          {legacy:8.2}");
    println!("    DAG built, legacy dispatch {build_only:8.2}  ({:+.1}%)  <- DAG build+fill cost", pct(build_only));
    println!("    DAG built, edge dispatch  {full:8.2}  ({:+.1}%)  <- + edge executor", pct(full));
    println!("    edge-executor delta over build: {:+.1}%", 100.0 * (full - build_only) / build_only);
}
