//! The browser bench's 6-glass stack (`bench.html?n=2000&stack=6&stackFx=glass&stackHalf=400`,
//! 3840×2160) built through the same ABI calls, rendered once natively so `WV_PLAN_DUMP=1` shows the
//! plan the wasm build runs. Structure only: timings from this binary are not the product's.

use render_core::kurbo::Affine;
use render_core::vello::abi;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const W: u32 = 3840;
const H: u32 = 2160;
const N: u32 = 2000;
const CELL: f32 = 40.0;
const REC: usize = 164;

fn solid_fill(color: u32) {
    let size = 4 + REC;
    let ptr = abi::alloc_bytes(size);
    let bytes = unsafe { std::slice::from_raw_parts_mut(ptr, size) };
    bytes.fill(0);
    bytes[0] = 1;
    bytes[8..12].copy_from_slice(&color.to_le_bytes());
    abi::set_shape_fills();
}

fn main() {
    let stack: u32 = std::env::var("STACK").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");

    abi::init(W as i32, H as i32);
    abi::set_render_options(0, 1.0);
    abi::set_scheduler(1);
    abi::set_tile_effects(1);
    abi::init_shapes_pool((N + stack + 200 + stack + 32) as usize);
    let cols = (N as f32).sqrt().ceil() as u32;
    for i in 0..N {
        let (cx, cy) = (((i % cols) as f32) * CELL, ((i / cols) as f32) * CELL);
        abi::use_shape(0, 0, 0, i + 1);
        abi::set_shape_type(3);
        abi::set_shape_selrect(cx + 2.0, cy + 2.0, cx + CELL - 2.0, cy + CELL - 2.0);
        solid_fill(0xff00_0000 | (i.wrapping_mul(2_654_435_761) & 0x00ff_ffff));
        abi::use_shape(0, 0, 0, 0);
        abi::add_shape_child(0, 0, 0, i + 1);
    }
    let mut id = N + stack + 100;
    for s in 0..stack {
        let half = 400.0 - s as f32 * 18.0;
        let (gx, gy) = (W as f32 / 2.0, H as f32 / 2.0);
        abi::use_shape(0, 0, 0, id);
        abi::set_shape_type(3);
        abi::set_shape_selrect(gx - half, gy - half, gx + half, gy + half);
        abi::set_shape_glass(0, 4.0, 8.0, 1.5, 0.0, 0.4, 1.0, 0.2, 0.0, 0.0, 0.0, 1.0, 6.0, 3.0, 1.0, 0, 0);
        abi::use_shape(0, 0, 0, 0);
        abi::add_shape_child(0, 0, 0, id);
        id += 1;
    }
    abi::set_view(1.0, 0.0, 0.0);

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("bench stack"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    });
    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, wgpu::TextureFormat::Rgba8Unorm);
    backend.sync_fonts();
    backend.upload_pending_images();
    sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, W, H, true);
    device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
}
