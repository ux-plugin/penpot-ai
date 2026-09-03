//! Minimal reproducer for the document-scale whole-viewport black frame: load the `scale` fixture at
//! N shapes (SHAPES env, default 4000; EVERY env, default 0 = no effects), render one whole-viewport
//! frame, and report how many pixels are non-white. A correct frame paints thousands of blobs over
//! the white page; a bump/capacity overflow paints nothing (all-white after the background clear, or
//! all-black when fine never ran).
//!
//! Run: `SHAPES=4000 cargo run --release --example wv_scale_probe`.

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const PROOFS: &str = "/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs";

fn main() {
    let n: u32 = std::env::var("SHAPES").ok().and_then(|v| v.parse().ok()).unwrap_or(4000);
    let every: u32 = std::env::var("EVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let (w, h) = (
        std::env::var("W").ok().and_then(|v| v.parse().ok()).unwrap_or(1600),
        std::env::var("H").ok().and_then(|v| v.parse().ok()).unwrap_or(1000),
    );

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .ok()
        .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_scale_probe"),
        ..Default::default()
    }))
    .expect("device");
    device.on_uncaptured_error(std::sync::Arc::new(|e: wgpu::Error| eprintln!("WGPU ERROR: {e}")));

    let mut backend = ClassicBackend::new(&device);
    let step: f32 = std::env::var("STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(26.0);
    let size: f32 = std::env::var("SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.9);
    let op_every: u32 = std::env::var("OPEVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(7);
    let cells = render_core::vello::abi::load_scale_scene_sized(n, every, step, size, op_every);
    render_core::vello::abi::init(w as i32, h as i32);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    let zoom: f32 = std::env::var("ZOOM").ok().and_then(|v| v.parse().ok()).unwrap_or(0.5);
    render_core::vello::abi::set_view(zoom, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    backend.sync_fonts();
    backend.upload_pending_images();

    let mut sink = Sink::new(&device, FORMAT);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("probe target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    if let Ok(v) = std::env::var("DRAG") {
        let (dx, dy) = v.split_once(',').map(|(a, b)| (a.parse().unwrap_or(30.0), b.parse().unwrap_or(-22.0))).unwrap_or((30.0, -22.0));
        let count: u32 = std::env::var("DRAG_COUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
        let entries: Vec<(u128, f64, f64)> = (0..count).map(|i| (u128::from(i) + 1, dx, dy)).collect();
        push_modifiers(&entries);
    }
    if std::env::var("PHASES").is_ok() {
        let fit = zoom;
        for phase in 0..4u32 {
            for t in 0..23i32 {
                match phase {
                    0 => render_core::vello::abi::set_view(fit, 0.0, 0.0),
                    1 => render_core::vello::abi::set_view(fit * (1.0 + 0.03 * (t % 8) as f32), 0.0, 0.0),
                    2 => render_core::vello::abi::set_view(fit, -12.0 * (t % 10) as f32, -7.0 * (t % 10) as f32),
                    _ => {
                        render_core::vello::abi::set_view(fit, 0.0, 0.0);
                        let entries: Vec<(u128, f64, f64)> =
                            (0..200).map(|i| (u128::from(i as u32) + 1, f64::from(t) * 1.5, f64::from(t) * -1.1)).collect();
                        push_modifiers(&entries);
                    }
                }
                let _ = render_core::vello::abi::take_dirty();
                sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, w, h, true);
            }
        }
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let rgba = read_back(&device, &queue, &target, w, h);
        let path = format!("{PROOFS}/scale-probe-phases-n{n}.png");
        write_png(&path, &rgba, w, h);
        println!("wrote {path}");
        return;
    }
    if std::env::var("TILED").is_ok() {
        let root = Affine::IDENTITY;
        let full_view = render_core::vello::abi::effective_view(root);
        let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
        let mut tsink = Sink::new(&device, FORMAT);
        let dirty = tsink.plan_frame(full_view, w, h, dirty_all, &dirty_rects);
        let dirty_set: std::collections::HashSet<render_core::tiling::TileKey> =
            dirty.iter().copied().collect();
        let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, dirty_all);
        tsink.execute(&schedule, &dirty, &mut backend, &device, &queue, &target, root, w, h);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let rgba = read_back(&device, &queue, &target, w, h);
        let path = format!("{PROOFS}/scale-probe-tiled-n{n}-e{every}.png");
        write_png(&path, &rgba, w, h);
        println!("wrote {path}");
        return;
    }
    let _ = render_core::vello::abi::take_dirty();
    let root = Affine::IDENTITY;
    if std::env::var("RAW").is_ok() {
        use render_core::vello::rasterize::RasterBackend;
        let inter = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("raw inter"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: backend.rasterize_target_usage() | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = inter.create_view(&wgpu::TextureViewDescriptor::default());
        let mut scene = backend.new_scene(w as u16, h as u16);
        backend.draw_scene_range(&mut scene, root, 0, usize::MAX);
        let e = scene.scene().encoding();
        println!(
            "encoding: n_paths {} n_path_segments {} n_clips {} n_open_clips {} draw_tags {} path_tags {} path_data {}",
            e.n_paths, e.n_path_segments, e.n_clips, e.n_open_clips,
            e.draw_tags.len(), e.path_tags.len(), e.path_data.len()
        );
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("raw") });
        backend.rasterize(&scene, &device, &queue, &mut enc, &view, w, h, render_core::vello::abi::background());
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &inter, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);
        backend.after_submit();
    } else {
        sink.render_whole_viewport(&mut backend, &device, &queue, &target, root, w, h, true);
    }
    let _ = device.poll(wgpu::PollType::wait_indefinitely());

    let rgba = read_back(&device, &queue, &target, w, h);
    let mut white = 0usize;
    let mut black = 0usize;
    let mut other = 0usize;
    for p in rgba.chunks_exact(4) {
        if p[0] > 250 && p[1] > 250 && p[2] > 250 {
            white += 1;
        } else if p[0] < 5 && p[1] < 5 && p[2] < 5 {
            black += 1;
        } else {
            other += 1;
        }
    }
    let total = (w * h) as usize;
    println!(
        "scale probe: {cells} shapes ({n} req, every {every}) at {w}x{h} -> white {white} ({:.1}%), black {black} ({:.1}%), content {other} ({:.1}%)",
        100.0 * white as f64 / total as f64,
        100.0 * black as f64 / total as f64,
        100.0 * other as f64 / total as f64
    );
    println!(
        "diag cell: bx {} by {} bw {} bh {} kw {} k {}",
        render_core::vello::prof::read(116),
        render_core::vello::prof::read(117),
        render_core::vello::prof::read(118),
        render_core::vello::prof::read(119),
        render_core::vello::prof::read(123),
        render_core::vello::prof::read(129) / 1000.0
    );
    let path = format!("{PROOFS}/scale-probe-n{n}-e{every}.png");
    write_png(&path, &rgba, w, h);
    println!("wrote {path}");
}

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let bpr = (w * 4).next_multiple_of(256);
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
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        let o = (row * bpr) as usize;
        out.extend_from_slice(&data[o..o + (w * 4) as usize]);
    }
    out
}

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgba).unwrap();
}

fn push_modifiers(entries: &[(u128, f64, f64)]) {
    let mut bytes = Vec::with_capacity(entries.len() * 40);
    for &(id, dx, dy) in entries {
        let (a, b, c, d) = render_core::vello::abi::uuid_to_quartet(id);
        for w in [a, b, c, d] {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        for f in [1.0f32, 0.0, 0.0, 1.0, dx as f32, dy as f32] {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
    }
    let ptr = render_core::vello::abi::alloc_bytes(bytes.len());
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    render_core::vello::abi::set_modifiers();
}
