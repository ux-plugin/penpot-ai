//! Renders the shared [`render_core::parity`] fixture through the **classic tree walk**
//! (`draw_scene`) to `.vello-proofs/parity-scene.png` — a quick native look at the parity surface.
//!
//! Two honest limits of THIS path (not the fixture): **gather** effects (background blur, glass, and
//! the scoped variants) do not execute in the tree walk — they run in the scheduler sink, so test
//! those in the browser (`load_parity_scene` + bench, via Chrome MCP). And the native `ClassicEnv`
//! resolves image fills to `None`, so image cells draw blank. Cells that render *wrong* (leaf
//! blend/opacity, masked group) are the classic-backend gaps made visible.
//!
//! Run: `cargo run --release --example parity_scene`.

use render_core::kurbo::Affine;
use render_core::parity::{build_parity_scene, canvas_size};
use render_core::peniko::Color;
use vello_gpu_renderer::walk::draw_scene;
use vello_gpu_renderer::{ClassicEnv, ClassicRenderer};

fn main() {
    let (scene, legend) = build_parity_scene();
    let (w, h) = canvas_size(legend.len());

    println!("parity scene: {} feature cells, {w}x{h}", legend.len());
    for (idx, label) in &legend {
        println!("  cell {idx:>2}: {label}");
    }

    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no wgpu adapter — cannot render the parity scene");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("parity_scene"),
        ..Default::default()
    }))
    .expect("device");

    use render_core::vello::rasterize::SceneRasterizer;
    let mut renderer = ClassicRenderer::new(&device);
    let mut ctx = renderer.new_scene(w as u16, h as u16);
    let mut text = render_core::vello::text::TextState::new();
    draw_scene(&mut ctx, &mut (), &ClassicEnv, &mut text, &scene, Affine::IDENTITY, &Default::default());

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("parity target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("parity enc") });
    renderer.rasterize(&ctx, &device, &queue, &mut enc, &view, w, h, Color::WHITE);
    queue.submit([enc.finish()]);

    let rgba = read_back(&device, &queue, &texture, w, h);
    let path = "/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs/parity-scene.png";
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
        label: Some("parity readback"),
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
