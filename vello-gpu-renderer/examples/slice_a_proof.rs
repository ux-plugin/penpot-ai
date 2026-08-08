//! Slice A proof: classic vello renders a real render-core document — solid fills, a **linear
//! gradient**, a rounded-corner outline, a circle, and a half-opacity isolation group — entirely
//! through the *shared* `render_vello_core::draw` path (the same code render-vello's hybrid sink now
//! delegates to). No hand-built scene: the document is built with the model API and walked by
//! `draw_scene`. Writes `proofs/slice-a-classic-shared-draw.png`.
//!
//! Run: `cargo run --example slice_a_proof --manifest-path vello-gpu-renderer/Cargo.toml`

use render_core::kurbo::{Rect as PageRect, RoundedRectRadii};
use render_core::model::{Brush, Node, Paint, Scene, ShapeKind, ROOT_ID};
use render_core::peniko::{Color, ColorStop, Gradient};
use vello_gpu_renderer::walk::draw_scene;
use render_vello_core::rasterize::SceneRasterizer;
use vello_gpu_renderer::{ClassicEnv, ClassicRenderer};

fn main() {
    let (w, h) = (256u32, 192u32);

    // A document that exercises every paint kind classic can draw today, plus isolation.
    let mut scene = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![1, 2, 3, 4];
    scene.insert(root);

    // 1) Solid red, rounded corners → goes through the outline() fill_path branch.
    let mut red = Node::new(1, ShapeKind::Rect);
    red.bounds = PageRect::new(16.0, 16.0, 112.0, 96.0);
    red.corners = Some(RoundedRectRadii::from_single_radius(18.0));
    red.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(226, 54, 54, 255)))];
    scene.insert(red);

    // 2) Linear gradient red→blue, left to right → the new non-solid paint kind.
    let stops = [
        ColorStop { offset: 0.0, color: Color::from_rgba8(230, 40, 40, 255).into() },
        ColorStop { offset: 1.0, color: Color::from_rgba8(40, 70, 235, 255).into() },
    ];
    let grad = Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(&stops[..]);
    let mut gr = Node::new(2, ShapeKind::Rect);
    gr.bounds = PageRect::new(128.0, 16.0, 240.0, 96.0);
    gr.fills = vec![Paint::plain(Brush::Gradient(grad))];
    scene.insert(gr);

    // 3) Solid green circle → the ellipse outline branch.
    let mut circ = Node::new(3, ShapeKind::Circle);
    circ.bounds = PageRect::new(24.0, 112.0, 96.0, 176.0);
    circ.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(48, 176, 96, 255)))];
    scene.insert(circ);

    // 4) A half-opacity group over the others → isolation push/pop layer.
    let mut group = Node::new(4, ShapeKind::Group);
    group.opacity = 0.5;
    group.children = vec![5];
    scene.insert(group);
    let mut inner = Node::new(5, ShapeKind::Rect);
    inner.bounds = PageRect::new(120.0, 108.0, 236.0, 172.0);
    inner.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(30, 40, 60, 255)))];
    scene.insert(inner);

    // --- classic vello device + rasterize through the shared drawer ---
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("no wgpu adapter — cannot produce the proof");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("slice-a proof"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .expect("device");

    let mut renderer = ClassicRenderer::new(&device);
    let mut ctx = renderer.new_scene(w as u16, h as u16);
    draw_scene(
            &mut ctx,
            &mut (),
            &ClassicEnv,
            &mut render_vello_core::text::TextState::new(),
            &scene,
            render_core::kurbo::Affine::IDENTITY,
        );

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("proof target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    renderer.rasterize(&ctx, &device, &queue, &view, w, h, Color::WHITE);

    let data = read_back(&device, &queue, &texture, w, h);

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../proofs/slice-a-classic-shared-draw.png");
    let file = std::fs::File::create(path).expect("create png");
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().expect("png header").write_image_data(&data).expect("png data");
    println!("wrote {path} ({w}x{h})");
}

/// Copy the target texture into a mappable buffer and return row-major RGBA8. `w·4` must be a
/// multiple of 256 (w=256 → 1024).
fn read_back(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    w: u32,
    h: u32,
) -> Vec<u8> {
    let bpr = w * 4;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(bpr * h),
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
                bytes_per_row: Some(bpr),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    slice.get_mapped_range().to_vec()
}
