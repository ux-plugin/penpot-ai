//! Step-by-step debug of the in-scene source strip: render one frame of a scene whose document is
//! LARGER than the viewport (the case the parity fixtures cannot express) and dump what each stage
//! actually produced — the presented frame, and the whole accumulator including the strip, so the
//! source surfaces the effects consume can be looked at rather than inferred.
//!
//! Env: `SHAPES`, `EVERY`, `STEP`, `SIZE` shape the fixture; `W`/`H` the viewport; `WV_TILED=1`
//! renders through the tiled scheduler instead — the independent reference implementation that
//! arbitrates when whole-viewport variants disagree (it is what caught the prepass phantom ink).
//!
//! Run: `cargo run --release --example wv_strip_debug`.

use std::fs::File;
use std::io::BufWriter;

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const PROOFS: &str = "/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs";

fn env_u32(k: &str, d: u32) -> u32 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn env_f32(k: &str, d: f32) -> f32 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = File::create(path).unwrap_or_else(|e| panic!("create {path}: {e}"));
    let mut enc = png::Encoder::new(BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(rgba).unwrap();
    println!("  wrote {path}");
}

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let unpadded = w * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("strip debug readback"),
        size: u64::from(padded) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(h) },
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

fn main() {
    let (w, h) = (env_u32("W", 1280), env_u32("H", 800));
    let shapes = env_u32("SHAPES", 2000);
    let every = env_u32("EVERY", 7);
    let (step, size) = (env_f32("STEP", 26.0), env_f32("SIZE", 1.9));
    let tag = std::env::var("TAG").unwrap_or_else(|_| {
        if std::env::var("WV_TILED").is_ok() { "tiled".into() } else { "wv".into() }
    });

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let feats = adapter.features() & wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_strip_debug"),
        required_features: feats,
        ..Default::default()
    }))
    .expect("device");

    let cells = render_core::vello::abi::load_scale_scene_sized(shapes, every, step, size, 0);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    if let Ok(v) = std::env::var("WV_DBG_ATLAS") {
        render_core::vello::abi::set_debug_atlas(v.parse().unwrap_or(0));
    }
    println!("scene: {shapes} shapes ({cells} cells), effect every {every}, step {step} size {size}, {w}x{h} [{tag}]");

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("strip debug target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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

    if std::env::var("WV_TILED").is_ok() {
        use std::collections::HashSet;
        use render_core::tiling::TileKey;
        let root = Affine::IDENTITY;
        let full_view = render_core::vello::abi::effective_view(root);
        let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
        let dirty = sink.plan_frame(full_view, w, h, dirty_all, &dirty_rects);
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
        let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, dirty_all);
        sink.execute(&schedule, &dirty, &mut backend, &device, &queue, &target, root, w, h);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
    } else {
        for _ in 0..2 {
            render_core::vello::abi::set_view(1.0, 0.0, 0.0);
            sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, w, h, true);
            device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        }
    }

    let rgba = read_back(&device, &queue, &target, w, h);
    write_png(&format!("{PROOFS}/strip-debug-{tag}.png"), &rgba, w, h);
}
