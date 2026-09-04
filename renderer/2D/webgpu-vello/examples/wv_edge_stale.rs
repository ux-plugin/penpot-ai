//! Regression gate for stale-state edge artifacts: a WARM pipeline (frames rendered at a
//! different pan first — pooled leases, snapshots and drafts all carry the old view's content)
//! must render the SAME final view byte-identically to a COLD pipeline (fresh sink + backend,
//! zeroed textures). Any read escaping its refreshed/valid region — a scatter tap past the
//! frame, a blur tap into a lease's previous tenant, an unrefreshed snapshot row — shows the
//! old view's pixels in the warm frame and breaks the equality. Static-view batteries are
//! structurally blind to this class (stale content == fresh content when nothing moved), which
//! is how the editor shipped visible bands that every fixture passed.
//!
//! Cases: a frosted lens crossing each viewport edge (top/bottom/left/right), fully inside as
//! a control, and a high-zoom top crossing that exercises the strided blur kernel. The pan
//! shift between warmup and the timed frame mimics the editor's wheel pan.
//!
//! Run: `cargo run --release --example wv_edge_stale` (WV_RW=1 for the rw-accumulator tier).
//! Exit code 1 on any mismatch beyond the documented 1-px AA wobble; failing frames and a
//! difference map land in `.vello-proofs/`.

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 2560;
const H: u32 = 1086;
const PROOFS: &str = ".vello-proofs";

struct Case {
    name: &'static str,
    zoom: f32,
    warm_pan: (f32, f32),
    pan: (f32, f32),
}

fn cases() -> Vec<Case> {
    let c = |name, zoom, warm_pan, pan| Case { name, zoom, warm_pan, pan };
    vec![
        c("top", 8.0, (-434.0, -78.2), (-434.0, -118.2)),
        c("bottom", 8.0, (-434.0, 70.0), (-434.0, 30.0)),
        c("left", 8.0, (-438.5, -53.0), (-478.5, -53.0)),
        c("right", 8.0, (-62.3, -53.0), (-102.3, -53.0)),
        c("inside", 8.0, (-476.0, -93.0), (-436.0, -53.0)),
        c("top-strided", 16.0, (-500.0, -99.1), (-500.0, -119.1)),
    ]
}

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
        label: Some("edge stale readback"),
        size: u64::from(padded) * u64::from(H),
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
                rows_per_image: Some(H),
            },
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

fn render(
    sink: &mut Sink,
    backend: &mut ClassicBackend,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    target: &wgpu::Texture,
    zoom: f32,
    pan: (f32, f32),
) {
    render_core::vello::abi::set_view(zoom, pan.0, pan.1);
    sink.render_whole_viewport(backend, device, queue, target, Affine::IDENTITY, W, H, true);
    device
        .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
        .expect("poll");
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("adapter");
    let rw = std::env::var("WV_RW").is_ok_and(|v| v == "1")
        && adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .flags
            .contains(wgpu::TextureFormatFeatureFlags::STORAGE_READ_WRITE);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_edge_stale"),
        required_features: if rw {
            wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES
        } else {
            wgpu::Features::empty()
        },
        ..Default::default()
    }))
    .expect("device");
    vello_gpu_renderer::set_rw_accumulator_supported(rw);
    println!("wv edge-stale gate: {W}x{H}, rw-accumulator {rw}");

    render_core::vello::abi::load_glass_grid_scene(1, 1);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);

    let mut failures = 0u32;
    for case in cases() {
        let warm_target = make_target(&device, "edge stale warm");
        let mut warm_backend = ClassicBackend::new(&device);
        let mut warm_sink = Sink::new(&device, FORMAT);
        warm_backend.sync_fonts();
        warm_backend.upload_pending_images();
        for _ in 0..2 {
            render(&mut warm_sink, &mut warm_backend, &device, &queue, &warm_target, case.zoom, case.warm_pan);
        }
        render(&mut warm_sink, &mut warm_backend, &device, &queue, &warm_target, case.zoom, case.pan);
        let warm = read_back(&device, &queue, &warm_target);

        let cold_target = make_target(&device, "edge stale cold");
        let mut cold_backend = ClassicBackend::new(&device);
        let mut cold_sink = Sink::new(&device, FORMAT);
        cold_backend.sync_fonts();
        cold_backend.upload_pending_images();
        render(&mut cold_sink, &mut cold_backend, &device, &queue, &cold_target, case.zoom, case.pan);
        let cold = read_back(&device, &queue, &cold_target);

        let mut count = 0u64;
        let mut max_delta = 0u8;
        for (a, b) in warm.iter().zip(cold.iter()) {
            let d = a.abs_diff(*b);
            if d > 0 {
                max_delta = max_delta.max(d);
            }
        }
        for (a, b) in warm.chunks_exact(4).zip(cold.chunks_exact(4)) {
            if a != b {
                count += 1;
            }
        }
        let wobble = count <= 2 && max_delta <= 1;
        let verdict = if count == 0 {
            "PASS"
        } else if wobble {
            "PASS (wobble)"
        } else {
            failures += 1;
            "FAIL"
        };
        println!("{:<14} {verdict:<14} {count} px differ, max channel delta {max_delta}", case.name);
        if !wobble && count > 0 {
            write_png(&format!("{PROOFS}/edge-stale-{}-warm.png", case.name), &warm);
            write_png(&format!("{PROOFS}/edge-stale-{}-cold.png", case.name), &cold);
        }
    }
    if failures > 0 {
        println!("\n{failures} case(s) FAILED — a warm pipeline diverged from cold at the same view");
        std::process::exit(1);
    }
    println!("\nall cases at parity: no stale-state reads at any viewport edge");
}
