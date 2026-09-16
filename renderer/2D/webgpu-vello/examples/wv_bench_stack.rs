//! The browser bench's glass stacks (see `util/stack_scene.rs` for the env that shapes them) rendered
//! once natively so `WV_PLAN_DUMP=1` shows the plan the wasm build runs. Structure only: timings
//! from this binary are not the product's.

use render_core::kurbo::Affine;
use render_core::vello::abi;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const W: u32 = 3840;
const H: u32 = 2160;

#[path = "util/stack_scene.rs"]
mod stack_scene;

fn main() {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");

    abi::init(W as i32, H as i32);
    abi::set_render_options(0, 1.0);
    abi::set_scheduler(1);
    abi::set_tile_effects(1);
    stack_scene::build_from_env(W, H);
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
