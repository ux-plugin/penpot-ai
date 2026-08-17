//! WHY is whole-viewport slower than tiled on effects? Controlled probe: render ONE fixed small scene
//! (the path-shadow fixture — a ~170px arrow with a drop shadow) at zoom 1, and sweep ONLY the render
//! viewport (512² → 4096²). The shape, its shadow, and the device blur sigma are IDENTICAL at every
//! size; only the target grows. If whole-viewport's cost tracks the viewport AREA while the tiled path
//! stays roughly flat, the cost is per-pass-viewport-sized (silhouette raster + blur run at full target
//! size) — i.e. the missing extent-crop, not the shape.
//!
//! Run: `cargo run --release --example wv_effect_why`.

use std::collections::HashSet;
use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::tiling::TileKey;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const WARMUP: usize = 2;
const TIMED: usize = 6;

fn install() {
    render_core::vello::abi::load_path_shadow_scene();
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0); // zoom 1 → shape + device sigma fixed across sizes
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
}

fn make_target(device: &wgpu::Device, s: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("why target"),
        size: wgpu::Extent3d { width: s, height: s, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn time_path(device: &wgpu::Device, queue: &wgpu::Queue, backend: &mut ClassicBackend, s: u32, whole_viewport: bool) -> (f64, f64) {
    let root = Affine::IDENTITY;
    let target = make_target(device, s);
    let mut sink = Sink::new(device, FORMAT);
    let mut times: Vec<f64> = Vec::new();
    let mut graphs = 0.0;
    for i in 0..(WARMUP + TIMED) {
        install();
        render_core::vello::abi::set_wv_phased(0);
        render_core::vello::abi::set_cmd_effect(0);
        backend.sync_fonts();
        backend.upload_pending_images();
        render_core::vello::prof::reset();
        let t0 = Instant::now();
        if whole_viewport {
            let _ = render_core::vello::abi::take_dirty();
            sink.render_whole_viewport(backend, device, queue, &target, root, s, s, true);
        } else {
            let full_view = render_core::vello::abi::effective_view(root);
            let (da, dr) = render_core::vello::abi::take_dirty();
            let dirty = sink.plan_frame(full_view, s, s, da, &dr);
            let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
            let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, da);
            sink.execute(&schedule, &dirty, backend, device, queue, &target, root, s, s);
        }
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        if i >= WARMUP {
            times.push(dt);
            graphs = render_core::vello::prof::read(14);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[times.len() / 2], graphs)
}

fn main() {
    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no adapter");
        return;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("why"), ..Default::default() })).expect("device");
    let mut backend = ClassicBackend::new(&device);

    println!("probe: one ~170px arrow + drop shadow at zoom 1; only the viewport grows.\n");
    println!("{:>7}  {:>10}  {:>10}  {:>8}  {:>10}", "size", "tiled ms", "WV ms", "WV/tiled", "WV graphs");
    let mut prev_wv = 0.0;
    for &s in &[512u32, 1024, 2048, 4096] {
        let (tiled, _tg) = time_path(&device, &queue, &mut backend, s, false);
        let (wv, wvg) = time_path(&device, &queue, &mut backend, s, true);
        let grow = if prev_wv > 0.0 { format!("{:.2}× vs prev", wv / prev_wv) } else { "—".to_string() };
        println!("{s:>7}  {tiled:>10.1}  {wv:>10.1}  {:>7.1}×  {wvg:>10.0}   (WV {grow})", wv / tiled);
        prev_wv = wv;
    }
    println!("\nviewport doubles each row → area ×4. If WV time ×~4 per row and tiled stays flat, WV cost is viewport-area-bound.");
}
