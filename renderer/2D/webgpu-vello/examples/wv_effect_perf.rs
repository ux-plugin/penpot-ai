//! Frame-time + pass-count comparison of the three classic render paths on a worst-case effect scene:
//! the tiled scheduler, whole-viewport (default / per-segment), and whole-viewport (collapsed /
//! front-end-once). The stress scene is a grid of shapes each carrying a heavy effect stack (2 drop + 1
//! inner shadow + layer blur + tint shader), rendered at 4K — so the whole-viewport path, which runs
//! every effect pass at FULL viewport resolution, does `n × (many full-screen passes)` while the tiled
//! path crops each effect to its (small) extent. This surfaces exactly that gap.
//!
//! Run: `cargo run --release --example wv_effect_perf`.

use std::collections::HashSet;
use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::tiling::TileKey;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
// Target resolution — the per-pass cost multiplier. The collapsed WV path holds every effect
// intermediate alive until its single submit, so at 4K × 12 heavy nodes peak GPU memory is large
// (~7 GB); the WV-vs-tiled gap (full-viewport vs extent-cropped passes) widens with resolution.
const W: u32 = 3840;
const H: u32 = 2160;
const WARMUP: usize = 2;
const TIMED: usize = 6;

fn install_and_frame() {
    let cells = render_core::vello::abi::load_stress_scene();
    let (cw, ch) = render_core::parity::canvas_size(cells as usize);
    // Fit the stress grid into the 4K target so every shape's effects paint on-screen.
    let zoom = (W as f32 / cw as f32).min(H as f32 / ch as f32);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(zoom, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
}

fn make_target(device: &wgpu::Device) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("perf target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn main() {
    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no wgpu adapter");
        return;
    };
    // TIMESTAMP_QUERY lets the sink's `GpuTimer`/`PassProfiler` bracket real GPU spans, so the frame
    // time can be split into GPU-busy vs CPU-record instead of one opaque wall-clock number.
    let feats = adapter.features() & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_effect_perf"),
        required_features: feats,
        ..Default::default()
    }))
    .expect("device");
    println!("timestamps: {}\n", if feats.contains(wgpu::Features::TIMESTAMP_QUERY) { "on" } else { "UNAVAILABLE" });

    let mut backend = ClassicBackend::new(&device);
    let root = Affine::IDENTITY;
    let target = make_target(&device);

    // Cell/effect count for the header.
    let cells = render_core::vello::abi::load_stress_scene();
    println!("stress: {cells} shapes, each = 2 drop + 1 inner shadow + layer blur + tint shader; target {W}x{H}\n");

    let paths: [(&str, u32, u32, bool); 3] = [
        // (label, wv_phased, cmd_effect, whole_viewport)
        ("tiled scheduler   ", 0, 0, false),
        ("WV per-segment    ", 0, 0, true),
        ("WV front-end-once ", 1, 1, true),
    ];

    for (label, wv_phased, cmd_effect, whole_viewport) in paths {
        let mut sink = Sink::new(&device, FORMAT);
        let mut times_ms: Vec<f64> = Vec::new();
        let mut rec_ms: Vec<f64> = Vec::new();
        let mut gpu = 0.0;
        let mut gpun = 0.0;
        let mut graphs = 0.0;
        let mut composites = 0.0;
        let mut submits = 0.0;
        let mut peak = 0.0;
        let mut sum = 0.0;
        let mut misses = 0.0;

        for i in 0..(WARMUP + TIMED) {
            // Reinstall each frame so the tiled tile-cache can't reuse — every frame is a full render.
            install_and_frame();
            render_core::vello::abi::set_wv_phased(wv_phased);
            render_core::vello::abi::set_cmd_effect(cmd_effect);
            backend.sync_fonts();
            backend.upload_pending_images();
            render_core::vello::prof::reset();

            let t0 = Instant::now();
            let record_ms;
            if whole_viewport {
                let (_da, _dr) = render_core::vello::abi::take_dirty();
                sink.render_whole_viewport(&mut backend, &device, &queue, &target, root, W, H, true);
            } else {
                let full_view = render_core::vello::abi::effective_view(root);
                let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
                let dirty = sink.plan_frame(full_view, W, H, dirty_all, &dirty_rects);
                let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
                let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, dirty_all);
                sink.execute(&schedule, &dirty, &mut backend, &device, &queue, &target, root, W, H);
            }
            // Everything up to here is CPU: walking the scene, building vello encodings, recording
            // passes, submitting. The poll below blocks until the GPU drains, so its duration is the
            // GPU work that had NOT already finished under the recording. record ≫ wait ⇒ CPU-bound.
            record_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            let dt = t0.elapsed().as_secs_f64() * 1000.0;

            if i >= WARMUP {
                rec_ms.push(record_ms);
                times_ms.push(dt);
                graphs = render_core::vello::prof::read(14);
                composites = render_core::vello::prof::read(11);
                submits = render_core::vello::prof::read(13);
                peak = render_core::vello::prof::read(20);
                sum = render_core::vello::prof::read(21);
                misses = render_core::vello::prof::read(9);
                gpu += render_core::vello::prof::read(18);
                gpun += render_core::vello::prof::read(19);
            }
        }

        times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = times_ms.len();
        let median = times_ms[n / 2];
        let min = times_ms[0];
        let mean = times_ms.iter().sum::<f64>() / n as f64;
        // `peak` = most effect-scratch textures any single node held at once (residency WITH the
        // node-boundary recycle); `sum` = total across all nodes (residency WITHOUT it). `allocs` =
        // create_texture calls this frame (pool misses) — the recycle should keep this small too.
        let save = if peak > 0.0 { format!("{:.1}×", sum / peak) } else { "—".to_string() };
        rec_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let rec = rec_ms[rec_ms.len() / 2];
        let wait = median - rec;
        let gpu_span = if gpun > 0.0 { gpu / gpun } else { 0.0 };
        println!("{label}  median {median:6.1} ms  = CPU-record {rec:6.1} ms + GPU-wait {wait:6.1} ms   | GPU span {gpu_span:6.1} ms");
        println!(
            "{:18}  pass-graphs {graphs:5.0}   composites {composites:5.0}   submits {submits:4.0}   | scratch peak {peak:4.0} vs sum {sum:5.0} ({save} saved)   allocs {misses:4.0}",
            "",
        );
    }
}
