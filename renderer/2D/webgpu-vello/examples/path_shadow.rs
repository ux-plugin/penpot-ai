//! Renders the path drop-shadow test through the **full scheduler + sink** (not the tree walk) to
//! `.vello-proofs/path-shadow.png` — the headless proof that a non-box (arbitrary path) shape gets a
//! soft drop shadow that follows its true silhouette. Classic vello has no inline arbitrary-shape
//! blur, so the shadow is a scheduled `PaintPathShadow`: the sink renders the offset silhouette,
//! blurs it with the `run_graph` Gaussian, and composites it behind the body.
//!
//! Drives the real ABI globals exactly as the wasm shell does (`load_path_shadow_scene` + `set_view`
//! + `build_schedule` + `sink.execute`), but targets a plain texture instead of a swapchain.
//!
//! Run: `cargo run --release --example path_shadow`.

use std::collections::HashSet;

use render_core::kurbo::Affine;
use render_core::tiling::TileKey;
use render_core::vello::rasterize::RasterBackend;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

fn main() {
    // Which sink-path effect scene to render (default path-shadow); pass another via the SCENE env var,
    // e.g. `SCENE=layer-blur cargo run --release --example path_shadow`.
    let scene = std::env::var("SCENE").unwrap_or_else(|_| "path-shadow".to_string());
    // Install the fixture into the ABI globals + frame it 1:1 (dpr 1, zoom 1, no pan) over a white page.
    let cells = match scene.as_str() {
        "layer-blur" => render_core::vello::abi::load_layer_blur_scene(),
        _ => render_core::vello::abi::load_path_shadow_scene(),
    };
    let (w, h) = render_core::parity::canvas_size(cells as usize);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff); // opaque white, so the dark shadow reads
    println!("path shadow: {cells} cells, {w}x{h}");

    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()
    else {
        eprintln!("no wgpu adapter — cannot render the path shadow test");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("path_shadow"),
        ..Default::default()
    }))
    .expect("device");

    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, FORMAT);

    // Same frame setup the renderer does (non-whole-viewport path): plan the dirty tiles, build the
    // schedule, execute it onto a texture target.
    let root = Affine::IDENTITY;
    let full_view = render_core::vello::abi::effective_view(root);
    let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
    let dirty = sink.plan_frame(full_view, w, h, dirty_all, &dirty_rects);
    let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
    let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, dirty_all);

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("path shadow target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    backend.upload_pending_images();
    sink.execute(&schedule, &dirty, &mut backend, &device, &queue, &target, root, w, h);

    let rgba = read_back(&device, &queue, &target, w, h);
    let path = format!("/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs/{scene}.png");
    let path = path.as_str();
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(&rgba).unwrap();
    println!("wrote {path}");
}

/// Copy the texture to a padded staging buffer, map it, and strip the 256-byte row padding.
fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let unpadded = w * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("path shadow readback"),
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
