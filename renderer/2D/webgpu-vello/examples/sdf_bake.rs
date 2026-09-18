//! Bake a blob's signed-distance field and dump it as a heatmap, to eyeball that the field hugs the
//! shape (concentric bands following the outline) rather than a box.
//!
//! Run: `cargo run --release --example sdf_bake`.

use render_core::kurbo::BezPath;
use render_core::vello::sdf::{flatten_segments, SdfBaker};

const RES: u32 = 128;
const PROOFS: &str = "/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs";

fn blob(half_x: f64, half_y: f64) -> BezPath {
    let mut p = BezPath::new();
    p.move_to((0.0, -half_y));
    p.curve_to((half_x * 0.6, -half_y), (half_x, -half_y * 0.5), (half_x, 0.0));
    p.curve_to((half_x, half_y * 0.55), (half_x * 0.5, half_y), (0.0, half_y));
    p.curve_to((-half_x * 0.4, half_y), (-half_x * 0.3, half_y * 0.2), (-half_x * 0.55, 0.0));
    p.curve_to((-half_x * 0.85, -half_y * 0.25), (-half_x * 0.6, -half_y), (0.0, -half_y));
    p.close_path();
    p
}

fn half_to_f32(h: u16) -> f32 {
    let sign = (h >> 15) & 1;
    let exp = (h >> 10) & 0x1f;
    let mant = h & 0x3ff;
    let val = if exp == 0 {
        (mant as f32) * 2f32.powi(-24)
    } else if exp == 0x1f {
        f32::INFINITY
    } else {
        (1.0 + (mant as f32) / 1024.0) * 2f32.powi(exp as i32 - 15)
    };
    if sign == 1 { -val } else { val }
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");

    let (hx, hy) = (45.0, 35.0);
    let decode = 2.0 * hx as f32;
    let centre = render_core::kurbo::Affine::translate((f64::from(RES) * 0.5, f64::from(RES) * 0.5));
    let segs = flatten_segments(&(centre * blob(hx, hy)), 0.3);
    println!("blob flattened to {} segments", segs.len());

    let baker = SdfBaker::new(&device);
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sdf field"),
        size: wgpu::Extent3d { width: RES, height: RES, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: render_core::vello::sdf::SDF_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    baker.bake_into(&device, &mut enc, &view, &segs, (0, 0, RES, RES), decode, true);

    let bpr = (RES * 2).div_ceil(256) * 256;
    let rb = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sdf readback"),
        size: u64::from(bpr * RES),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &rb,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(RES) },
        },
        wgpu::Extent3d { width: RES, height: RES, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = rb.slice(..).get_mapped_range().to_vec();

    let mut png = vec![0u8; (RES * RES * 4) as usize];
    for y in 0..RES {
        for x in 0..RES {
            let off = (y * bpr + x * 2) as usize;
            let h = u16::from_le_bytes([data[off], data[off + 1]]);
            let d = (half_to_f32(h) - 0.5) * decode;
            let (r, g, b) = if d.abs() < 1.5 {
                (255u8, 255, 255)
            } else if d < 0.0 {
                let t = (-d / (hx as f32)).clamp(0.0, 1.0);
                (40, (60.0 + 180.0 * t) as u8, 230)
            } else {
                let t = (d / (hx as f32)).clamp(0.0, 1.0);
                (230, (60.0 + 120.0 * (1.0 - t)) as u8, 40)
            };
            let o = ((y * RES + x) * 4) as usize;
            png[o] = r;
            png[o + 1] = g;
            png[o + 2] = b;
            png[o + 3] = 255;
        }
    }
    let path = format!("{PROOFS}/sdf-blob.png");
    let file = std::fs::File::create(&path).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(file), RES, RES);
    e.set_color(png::ColorType::Rgba);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(&png).unwrap();
    println!("wrote {path}");
}
