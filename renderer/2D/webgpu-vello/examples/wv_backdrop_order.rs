//! Write-after-read gate for backdrop reads: content ABOVE an effect in z must never reach the
//! effect's pixels. Each case renders the backdrop-order fixture (a glass lens over a
//! checkerboard) with and without neighbours stacked above the lens just outside its edge —
//! inside its read reach, outside its footprint — and compares the lens interior. Any
//! difference there is a backdrop read that saw rows written later in z.
//!
//! Run: `cargo run --release --example wv_backdrop_order` (`WV_CASE=<substr>` filters, `WV_DUMP=1`
//! writes with/without/diff PNGs into `.vello-proofs/`).

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 1600;
const H: u32 = 1000;
const PROOFS: &str = ".vello-proofs";
/// The lens rect in page units (see `build_backdrop_order_scene`).
const LENS: [f32; 4] = [400.0, 250.0, 800.0, 550.0];
/// Interior inset in device px: keeps the lens's own anti-aliased rim out of the comparison.
const INSET: f32 = 3.0;

struct Case {
    name: String,
    neighbour: u32,
    gap: f32,
    frost: bool,
    zoom: f32,
    pan: (f32, f32),
}

fn cases() -> Vec<Case> {
    let mut v = Vec::new();
    for (neighbour, what) in [(1, "frames"), (2, "bgblur")] {
        for gap in [2.0f32, 8.0, 24.0] {
            for frost in [false, true] {
                for (zoom, pan) in [(1.0f32, (0.0f32, 0.0f32)), (2.0, (-300.0, -150.0))] {
                    v.push(Case {
                        name: format!("{what}-gap{gap}-{}-z{zoom}", if frost { "frost" } else { "sharp" }),
                        neighbour, gap, frost, zoom, pan,
                    });
                }
            }
        }
    }
    v
}

fn make_target(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let unpadded = w * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("crop oracle readback"),
        size: u64::from(padded) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((unpadded * h) as usize);
    for row in 0..h {
        let start = (row * padded) as usize;
        out.extend_from_slice(&data[start..start + unpadded as usize]);
    }
    drop(data);
    buffer.unmap();
    out
}

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgba).unwrap();
    println!("  wrote {path}");
}

fn render(device: &wgpu::Device, queue: &wgpu::Queue, case: &Case, neighbour: u32) -> Vec<u8> {
    render_core::vello::abi::load_backdrop_order_scene(neighbour, case.gap, u32::from(case.frost));
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    let target = make_target(device, W, H, "backdrop order");
    let mut backend = ClassicBackend::new(device);
    let mut sink = Sink::new(device, FORMAT);
    backend.sync_fonts();
    backend.upload_pending_images();
    render_core::vello::abi::set_view(case.zoom, case.pan.0, case.pan.1);
    sink.render_whole_viewport(&mut backend, device, queue, &target, Affine::IDENTITY, W, H, true);
    device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
    read_back(device, queue, &target, W, H)
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("wv_backdrop_order"), ..Default::default() })).expect("device");
    println!("wv backdrop order: lens interior with vs without neighbours above it in z");
    let only = std::env::var("WV_CASE").ok();
    let mut failures = 0u32;
    for case in cases() {
        if only.as_deref().is_some_and(|f| !case.name.contains(f)) {
            continue;
        }
        let with = render(&device, &queue, &case, case.neighbour);
        let without = render(&device, &queue, &case, 0);
        let dev = |v: f32, p: f32| (v + p) * case.zoom;
        let (x0, y0) = ((dev(LENS[0], case.pan.0) + INSET).max(0.0) as u32, (dev(LENS[1], case.pan.1) + INSET).max(0.0) as u32);
        let (x1, y1) = ((dev(LENS[2], case.pan.0) - INSET).min(W as f32) as u32, (dev(LENS[3], case.pan.1) - INSET).min(H as f32) as u32);
        let (mut n, mut max) = (0u64, 0u8);
        let mut diff = vec![0u8; (W * H * 4) as usize];
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y * W + x) * 4) as usize;
                let d = with[i..i + 4].iter().zip(&without[i..i + 4]).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
                if d > 2 {
                    n += 1;
                    max = max.max(d);
                    diff[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        let ok = n == 0;
        if !ok {
            failures += 1;
        }
        println!("{:<32} {:<5} lens interior {n} px differ (max {max})", case.name, if ok { "PASS" } else { "FAIL" });
        if !ok || std::env::var("WV_DUMP").is_ok() {
            let _ = std::fs::create_dir_all(PROOFS);
            write_png(&format!("{PROOFS}/order-{}-with.png", case.name), &with, W, H);
            write_png(&format!("{PROOFS}/order-{}-without.png", case.name), &without, W, H);
            write_png(&format!("{PROOFS}/order-{}-diff.png", case.name), &diff, W, H);
        }
    }
    if failures > 0 {
        println!("\n{failures} case(s) FAILED — content above a lens reached its backdrop");
        std::process::exit(1);
    }
    println!("\nall cases: content above a lens never reaches its pixels");
}
