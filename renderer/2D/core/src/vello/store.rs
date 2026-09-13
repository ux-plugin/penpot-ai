//! The two rect operations the executor runs on the packed store outside `fine`: fill a rect
//! with a colour, copy a rect to a disjoint rect. Both are compute over the store's read-write
//! binding — no attachment, no second texture — so they sit in the same usage the `fine`
//! dispatches hold and need no view juggling. The store is banded into 8192-row layers exactly
//! as `fine` addresses it.

const SHADER: &str = r#"
struct Op {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    sx: u32,
    sy: u32,
    colour: u32,
    kind: u32,
};
@group(0) @binding(0) var<uniform> op: Op;
@group(0) @binding(1) var store: texture_storage_2d_array<r32uint, read_write>;

const LAYER_PX: i32 = 8192;

fn ld(p: vec2<i32>) -> u32 {
    return textureLoad(store, vec2(p.x, p.y % LAYER_PX), p.y / LAYER_PX).x;
}

fn st(p: vec2<i32>, v: u32) {
    textureStore(store, vec2(p.x, p.y % LAYER_PX), p.y / LAYER_PX, vec4<u32>(v, 0u, 0u, 0u));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = op.x0 + gid.x;
    let y = op.y0 + gid.y;
    if (x >= op.x1 || y >= op.y1) {
        return;
    }
    let p = vec2<i32>(i32(x), i32(y));
    if (op.kind == 0u) {
        st(p, op.colour);
    } else {
        let s = vec2<i32>(i32(op.sx + gid.x), i32(op.sy + gid.y));
        st(p, ld(s));
    }
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct OpUniform {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    sx: u32,
    sy: u32,
    colour: u32,
    kind: u32,
}

/// The fill/copy pipeline over one store. Built once per `Sink`.
pub struct StoreOps {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

impl StoreOps {
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("store ops"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("store ops layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::ReadWrite,
                        format: wgpu::TextureFormat::R32Uint,
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("store ops pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("store ops pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
        Self { pipeline, layout }
    }

    /// Fill `rect` (store texels, `[x0, y0, x1, y1]`) with a packed texel.
    pub fn fill(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, store: &wgpu::TextureView, rect: [u32; 4], packed: u32) {
        self.run(device, enc, store, OpUniform { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3], sx: 0, sy: 0, colour: packed, kind: 0 });
    }

    /// Copy the rect at `src` (origin) into `dst` (`[x0, y0, x1, y1]`). The two must not overlap.
    pub fn copy(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, store: &wgpu::TextureView, src: [u32; 2], dst: [u32; 4]) {
        self.run(device, enc, store, OpUniform { x0: dst[0], y0: dst[1], x1: dst[2], y1: dst[3], sx: src[0], sy: src[1], colour: 0, kind: 1 });
    }

    fn run(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, store: &wgpu::TextureView, op: OpUniform) {
        let ubuf = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor {
            label: Some("store op"),
            contents: bytemuck::bytes_of(&op),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("store op bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(store) },
            ],
        });
        crate::vello::sink::note_passes(1);
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("store op"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups((op.x1 - op.x0).div_ceil(16), (op.y1 - op.y0).div_ceil(16), 1);
    }
}
