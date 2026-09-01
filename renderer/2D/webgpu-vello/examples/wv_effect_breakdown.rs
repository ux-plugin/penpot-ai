//! WHERE do the whole-viewport milliseconds go? The frame is ~93% GPU-bound (measured by
//! `wv_effect_perf`'s CPU-record vs GPU-wait split), so CPU-side instrumentation can't attribute it.
//! Instead this ABLATES: render the same stress scene with one effect kind removed at a time and
//! diff the frame time. Each delta is that effect's real end-to-end GPU cost, including its
//! silhouette/body rasters, its blur pass-graph, and its composites.
//!
//! `plain` (mask 0) is the floor: bodies only, no effects — i.e. what the whole-viewport base render
//! costs before any effect work. Anything above that floor is effect cost we can attack.
//!
//! Run: `cargo run --release --example wv_effect_breakdown`.

use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::parity::{FX_ALL, FX_BLUR, FX_DROP, FX_INNER, FX_SHARP};
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 3840;
const H: u32 = 2160;
const N: u32 = 12;
const WARMUP: usize = 2;
const TIMED: usize = 6;

fn install(mask: u32) {
    let cells = render_core::vello::abi::load_stress_scene_mask(N, mask);
    let (cw, ch) = render_core::parity::canvas_size(cells as usize);
    let zoom = (W as f32 / cw as f32).min(H as f32 / ch as f32);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(zoom, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
}

/// Median (total, cpu-record) ms for one mask on the whole-viewport per-segment path.
fn time_mask(device: &wgpu::Device, queue: &wgpu::Queue, backend: &mut ClassicBackend, target: &wgpu::Texture, mask: u32) -> (f64, f64, f64) {
    let root = Affine::IDENTITY;
    let mut sink = Sink::new(device, FORMAT);
    let mut tot: Vec<f64> = Vec::new();
    let mut rec: Vec<f64> = Vec::new();
    let mut graphs = 0.0;
    for i in 0..(WARMUP + TIMED) {
        install(mask);
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
            graphs = render_core::vello::prof::read(14);
        }
    }
    tot.sort_by(|a, b| a.partial_cmp(b).unwrap());
    rec.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (tot[tot.len() / 2], rec[rec.len() / 2], graphs)
}

fn main() {
    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no adapter");
        return;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("breakdown"), ..Default::default() })).expect("device");
    let mut backend = ClassicBackend::new(&device);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("breakdown target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });

    println!("whole-viewport per-segment, {N} heavy nodes @ {W}x{H}. Ablation: each row removes ONE effect.\n");

    let (full, full_rec, full_g) = time_mask(&device, &queue, &mut backend, &target, FX_ALL);
    let (plain, plain_rec, plain_g) = time_mask(&device, &queue, &mut backend, &target, 0);
    println!("{:<22} {:>9} {:>9} {:>9} {:>8}", "variant", "total ms", "cpu ms", "vs full", "graphs");
    println!("{:<22} {full:>9.1} {full_rec:>9.1} {:>9} {full_g:>8.0}", "full stack", "—");
    println!("{:<22} {plain:>9.1} {plain_rec:>9.1} {:>9} {plain_g:>8.0}   <- base render floor (no effects)", "plain bodies", format!("-{:.0}", full - plain));

    println!();
    for (name, bit) in [("drop shadows (2)", FX_DROP), ("inner shadow (1)", FX_INNER), ("layer blur", FX_BLUR)] {
        let (t, r, g) = time_mask(&device, &queue, &mut backend, &target, FX_ALL & !bit);
        println!("{:<22} {t:>9.1} {r:>9.1} {:>9} {g:>8.0}   <- removing it saves {:.0} ms", format!("full minus {name}"), format!("-{:.0}", full - t), full - t);
    }

    println!("\neffect total = full - plain = {:.0} ms; base render floor = {plain:.0} ms.", full - plain);
    println!("A per-effect saving is that effect's whole cost: silhouette/body raster + blur graph + composites.");

    println!("\n-- shadow cost split (silhouette raster+composite vs Gaussian blur) --");
    let shadows_only = FX_DROP | FX_INNER;
    let (blurred, _, bg) = time_mask(&device, &queue, &mut backend, &target, shadows_only);
    let (sharp, _, sg) = time_mask(&device, &queue, &mut backend, &target, shadows_only | FX_SHARP);
    println!("3 shadows/node, blurred   {blurred:>8.1} ms   graphs {bg:>4.0}");
    println!("3 shadows/node, SHARP     {sharp:>8.1} ms   graphs {sg:>4.0}   <- raster + composite only");
    println!(
        "  => silhouette raster+composite {:.0} ms ({:.0}%),  Gaussian blur {:.0} ms ({:.0}%)",
        sharp - plain,
        (sharp - plain) / (blurred - plain) * 100.0,
        blurred - sharp,
        (blurred - sharp) / (blurred - plain) * 100.0,
    );
}
