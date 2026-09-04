//! Render an editor ABI recording natively — the "dump, replay, gate" loop's manual tool.
//! Grab a capture in the dev editor (`JSON.stringify(window.__abiRecorder.recording())`), save
//! it under `fixtures/`, and this harness installs the exact live document and renders it
//! through the production whole-viewport sink at any view.
//!
//! Run: `cargo run --release --example wv_replay -- fixtures/showcase-editor.abi.json`
//! Env: `WV_ZOOM`/`WV_PANX`/`WV_PANY` override the recorded view; `WV_W`/`WV_H` the target
//! (default = the recording's `init` canvas size × its recorded dpr); `WV_DUMP=path` writes the
//! frame as a PNG; `WV_RW=1` selects the rw-accumulator tier.

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

#[path = "util/replay.rs"]
mod replay_util;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

fn env_f32(key: &str) -> Option<f32> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fixture = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "fixtures/showcase-editor.abi.json".to_string());

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
        label: Some("wv_replay"),
        required_features: if rw {
            wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES
        } else {
            wgpu::Features::empty()
        },
        ..Default::default()
    }))
    .expect("device");
    vello_gpu_renderer::set_rw_accumulator_supported(rw);

    let rep = replay_util::replay(&fixture);
    println!("replayed {} calls from {fixture} (rw-accumulator {rw})", rep.applied);

    let w = std::env::var("WV_W")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or((rep.canvas.0 as f32 * rep.dpr) as u32);
    let h = std::env::var("WV_H")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or((rep.canvas.1 as f32 * rep.dpr) as u32);
    if let Some(dpr) = env_f32("WV_DPR") {
        render_core::vello::abi::set_render_options(0, dpr);
    }
    if let Some(zoom) = env_f32("WV_ZOOM") {
        render_core::vello::abi::set_view(
            zoom,
            env_f32("WV_PANX").unwrap_or(0.0),
            env_f32("WV_PANY").unwrap_or(0.0),
        );
    }

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("replay target"),
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
    });
    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, FORMAT);
    backend.sync_fonts();
    backend.upload_pending_images();
    sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, w, h, true);
    device
        .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
        .expect("poll");
    println!("rendered {w}x{h}");

    if let Ok(path) = std::env::var("WV_DUMP") {
        let unpadded = w * 4;
        let padded = unpadded.div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("replay readback"),
            size: u64::from(padded) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
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
        let file = std::fs::File::create(&path).expect("create png");
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&out).unwrap();
        println!("wrote {path}");
    }
}
