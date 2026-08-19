//! Probe: can this adapter bind `rgba8unorm` as a read-write storage texture?
//!
//! Prints the adapter's per-format feature flags for `Rgba8Unorm`, then — when the flags allow —
//! creates a device with `TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES`, compiles a trivial WGSL
//! kernel that increments the texture in place through one `texture_storage_2d<rgba8unorm,
//! read_write>` binding, dispatches it twice over a 4×4 texture, and reads the pixels back.
//! Two in-place increments over a zeroed texture must read back exactly 2 in every byte, which
//! proves load→modify→store against a single binding works end to end on this stack.

fn main() {
    pollster::block_on(run());
}

async fn run() {
    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("adapter");
    let info = adapter.get_info();
    println!("adapter: {} ({:?})", info.name, info.backend);

    let flags = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm).flags;
    println!("rgba8unorm format flags: {flags:?}");
    let rw = flags.contains(wgpu::TextureFormatFeatureFlags::STORAGE_READ_WRITE);
    println!("rgba8unorm STORAGE_READ_WRITE: {rw}");
    if !rw {
        println!("RESULT: unsupported on this adapter");
        return;
    }

    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("rw probe"),
            required_features: wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES,
            ..Default::default()
        })
        .await
        .expect("device with adapter-specific format features");

    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("rw probe tex"),
        size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("rw probe shader"),
        source: wgpu::ShaderSource::Wgsl(
            r"
@group(0) @binding(0) var acc: texture_storage_2d<rgba8unorm, read_write>;

@compute @workgroup_size(4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = vec2<i32>(gid.xy);
    let v = textureLoad(acc, p);
    textureStore(acc, p, v + vec4(1.0 / 255.0));
}
"
            .into(),
        ),
    });

    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("rw probe pipeline"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("rw probe bind"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&view),
        }],
    });

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rw probe readback"),
        size: 256 * 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    for _ in 0..2 {
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    device
        .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
        .expect("poll");
    let data = slice.get_mapped_range();
    let px = &data[..16];
    println!("first pixels after two in-place increments: {px:?}");
    let ok = data.chunks(256).take(4).all(|row| row[..16].iter().all(|&b| b == 2));
    println!("RESULT: {}", if ok { "read-write rgba8unorm WORKS" } else { "unexpected readback" });
}
