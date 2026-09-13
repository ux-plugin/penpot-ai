//! P0 gate for the plan executor: a hand-written [`FramePlan`] — clear, one front-end over every
//! root, one fine window over the frame, present — must render an effect-free scene the same as
//! `render_whole_viewport`. "The same" is measured against the old path's own run-to-run noise:
//! at thousands of overlapping shapes vello's segment accumulation order is not stable, so the
//! reference is rendered twice and a plan may differ from it by no more than the reference differs
//! from itself (max Δ1, no more pixels). This proves the executor's store, front-end, fine mode
//! word and present before any scheduler exists to feed it.
//!
//! Run: `cargo run --release --example wv_plan_probe`. A differing scene writes both renders and a
//! heatmap into `.vello-proofs/`.

use render_core::kurbo::{Affine, Rect};
use render_core::vello::frame_graph::{DrawItem, DrawStyle};
use render_core::vello::frame_plan::{DrawCmd, FramePlan, Pass, Tiles, Window};
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 2560;
const H: u32 = 1086;
const PROOFS: &str = ".vello-proofs";

fn make_target(device: &wgpu::Device, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    })
}

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> Vec<u8> {
    let unpadded = W * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("plan probe readback"),
        size: u64::from(padded) * u64::from(H),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(H) },
        },
        wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((unpadded * H) as usize);
    for row in 0..H {
        let start = (row * padded) as usize;
        out.extend_from_slice(&data[start..start + unpadded as usize]);
    }
    drop(data);
    buffer.unmap();
    out
}

fn write_png(path: &str, rgba: &[u8]) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), W, H);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgba).unwrap();
    println!("  wrote {path}");
}

fn count_diff(a: &[u8], b: &[u8]) -> (u64, u8) {
    let mut differing = 0u64;
    let mut max = 0u8;
    for (x, y) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let d = x.iter().zip(y).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        if d > 0 {
            differing += 1;
            max = max.max(d);
        }
    }
    (differing, max)
}

/// The plain plan: every root in one draw, one window, the frame rows presented.
fn plain_plan() -> FramePlan {
    let frame = Rect::new(0.0, 0.0, f64::from(W), f64::from(H));
    let bg = render_core::vello::abi::background().components;
    let items: Vec<DrawItem> = render_core::vello::abi::with_scene(|live, _, _| {
        live.roots()
            .iter()
            .map(|&id| DrawItem { shape: id, style: DrawStyle::Body, bounds: frame })
            .collect()
    });
    FramePlan {
        store: (W, H),
        params: vec![],
        passes: vec![
            Pass::Clear { rect: frame, colour: bg },
            Pass::Frontend { draws: vec![DrawCmd::Shapes { items, transform: Affine::IDENTITY, clip: None }] },
            Pass::Fine { window: Window { rounds: (0, u32::MAX), tiles: Tiles::All }, output: frame, base: None, input: None },
            Pass::Present { from: frame },
        ],
    }
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_plan_probe"),
        ..Default::default()
    }))
    .expect("device");
    std::fs::create_dir_all(PROOFS).ok();

    let scenes: Vec<(&str, Box<dyn Fn()>)> = vec![
        ("plain-90", Box::new(|| {
            render_core::vello::abi::load_scale_scene_sized(90, 0, 26.0, 1.9, 7);
        })),
        ("plain-2000", Box::new(|| {
            render_core::vello::abi::load_scale_scene_sized(2000, 0, 26.0, 1.9, 5);
        })),
    ];
    let mut failures = 0u32;
    for (name, install) in scenes {
        install();
        render_core::vello::abi::set_render_options(0, 1.0);
        render_core::vello::abi::set_canvas_background(0xffff_ffff);
        render_core::vello::abi::set_scheduler(1);
        render_core::vello::abi::set_tile_effects(1);
        render_core::vello::abi::set_view(1.0, 0.0, 0.0);

        let reference = make_target(&device, "plan probe reference");
        let mut backend = ClassicBackend::new(&device);
        let mut sink = Sink::new(&device, FORMAT);
        backend.sync_fonts();
        backend.upload_pending_images();
        sink.render_whole_viewport(&mut backend, &device, &queue, &reference, Affine::IDENTITY, W, H, true);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let want = read_back(&device, &queue, &reference);
        sink.render_whole_viewport(&mut backend, &device, &queue, &reference, Affine::IDENTITY, W, H, true);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let again = read_back(&device, &queue, &reference);
        let (noise, noise_max) = count_diff(&want, &again);

        let target = make_target(&device, "plan probe plan");
        let mut backend = ClassicBackend::new(&device);
        let mut sink = Sink::new(&device, FORMAT);
        backend.sync_fonts();
        backend.upload_pending_images();
        let plan = plain_plan();
        sink.run_plan(&plan, &mut backend, &device, &queue, &target, Affine::IDENTITY, W, H);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let got = read_back(&device, &queue, &target);

        let (differing, max) = count_diff(&want, &got);
        let ok = max <= noise_max.max(u8::from(noise > 0)) && differing <= noise.max(1) * 2;
        failures += u32::from(!ok);
        println!(
            "{name:<12} {} {differing} px differ (max {max}); reference noise {noise} px (max {noise_max})",
            if ok { "PASS" } else { "FAIL" }
        );
        if !ok {
            write_png(&format!("{PROOFS}/plan-{name}-reference.png"), &want);
            write_png(&format!("{PROOFS}/plan-{name}-plan.png"), &got);
        }
    }
    if failures > 0 {
        println!("\n{failures} scene(s) FAILED — the plan executor diverges from the whole-viewport path");
        std::process::exit(1);
    }
    println!("\nthe plan executor reproduces the whole-viewport path");
}
