//! Instanced batch pipelines for the whole-viewport effect scheduler: **one render pass per stage**,
//! one quad instance per source cell inside it.
//!
//! The per-effect path pays a pass boundary (measured ~55µs on Metal) for every blur and composite of
//! every shape — thousands of boundaries at hundreds of effects. Here a stage (blur-H, blur-V, one
//! round's composites) is a single pass whose instances each carry their own geometry and blur
//! parameters, so the boundary cost is per *stage*, not per *shape*. Draw order inside a pass is
//! API order, which is what makes shadow-under-body composition correct with plain `SrcOver`.
//!
//! The blur fragment mirrors [`super::blend`]'s `BLUR_SHADER` tap for tap (same radius formula, same
//! normalised weighted sum, same linear-light decode). Cells sit side by side in one surface, so the
//! private texture's clamp-to-edge becomes an explicit UV clamp to the instance's own cell rect —
//! same replicated edge texels, and a tap can never cross into the neighbouring cell.

use std::ops::Range;

/// Per-quad instance: destination rect in the target's NDC, source rect in the source's UV, the tap
/// clamp rect, and the blur parameters. `step` is the blur direction pre-divided by the source size
/// (a copy/composite instance leaves it unused). Layout matches the WGSL `Inst` struct: seven
/// `vec2<f32>` then four `f32`, 72 bytes, align 8.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Inst {
    pub dst_min: [f32; 2],
    pub dst_max: [f32; 2],
    pub src_min: [f32; 2],
    pub src_max: [f32; 2],
    pub clamp_min: [f32; 2],
    pub clamp_max: [f32; 2],
    pub step: [f32; 2],
    pub sigma: f32,
    pub radius: f32,
    pub linearize: f32,
    pub alpha: f32,
}

impl Inst {
    /// An instance moving `src_rect` (pixels in a `src_size` texture) to `dst_rect` (pixels in a
    /// `dst_size` target), blurring along `dir` with `sigma` device pixels (`sigma <= 0` = plain
    /// copy). Taps are clamped to the source rect's texel centres.
    pub fn new(
        dst_rect: (f32, f32, f32, f32),
        dst_size: (f32, f32),
        src_rect: (f32, f32, f32, f32),
        src_size: (f32, f32),
        dir: (f32, f32),
        sigma: f32,
        linear: bool,
    ) -> Self {
        let (dx, dy, dw, dh) = dst_rect;
        let (tw, th) = dst_size;
        let (sx, sy, sw, sh) = src_rect;
        let (iw, ih) = (1.0 / src_size.0, 1.0 / src_size.1);
        let ndc_x = |x: f32| (x / tw) * 2.0 - 1.0;
        let ndc_y = |y: f32| 1.0 - (y / th) * 2.0;
        let blurred = sigma > 0.0;
        let s = if blurred { sigma } else { 1e-3 };
        Self {
            dst_min: [ndc_x(dx), ndc_y(dy)],
            dst_max: [ndc_x(dx + dw), ndc_y(dy + dh)],
            src_min: [sx * iw, sy * ih],
            src_max: [(sx + sw) * iw, (sy + sh) * ih],
            clamp_min: [(sx + 0.5) * iw, (sy + 0.5) * ih],
            clamp_max: [(sx + sw - 0.5) * iw, (sy + sh - 0.5) * ih],
            step: [dir.0 * iw, dir.1 * ih],
            sigma: s,
            radius: (3.0 * s).ceil().clamp(1.0, 160.0),
            linearize: if blurred && linear { 1.0 } else { 0.0 },
            alpha: 1.0,
        }
    }
}

const BATCH_SHADER: &str = r#"
struct Inst {
    dst_min: vec2<f32>,
    dst_max: vec2<f32>,
    src_min: vec2<f32>,
    src_max: vec2<f32>,
    clamp_min: vec2<f32>,
    clamp_max: vec2<f32>,
    step: vec2<f32>,
    sigma: f32,
    radius: f32,
    linearize: f32,
    alpha: f32,
};
@group(0) @binding(0) var<storage, read> insts: array<Inst>;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn srgb_to_lin(c: f32) -> f32 {
    if (c <= 0.04045) { return c / 12.92; }
    return pow((c + 0.055) / 1.055, 2.4);
}
fn lin_to_srgb(c: f32) -> f32 {
    if (c <= 0.0031308) { return c * 12.92; }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn premul_srgb_to_lin(s: vec4<f32>) -> vec4<f32> {
    let a = max(s.a, 1e-5);
    let straight = s.rgb / a;
    return vec4<f32>(vec3<f32>(srgb_to_lin(straight.r), srgb_to_lin(straight.g), srgb_to_lin(straight.b)) * a, s.a);
}
fn premul_lin_to_srgb(s: vec4<f32>) -> vec4<f32> {
    let a = max(s.a, 1e-5);
    let straight = s.rgb / a;
    return vec4<f32>(vec3<f32>(lin_to_srgb(straight.r), lin_to_srgb(straight.g), lin_to_srgb(straight.b)) * a, s.a);
}

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) inst: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    let it = insts[ii];
    var out: VSOut;
    out.pos = vec4<f32>(mix(it.dst_min, it.dst_max, corner), 0.0, 1.0);
    out.uv = mix(it.src_min, it.src_max, corner);
    out.inst = ii;
    return out;
}

@fragment
fn fs_blur(in: VSOut) -> @location(0) vec4<f32> {
    let it = insts[in.inst];
    let r = i32(it.radius);
    let inv2s2 = 1.0 / (2.0 * it.sigma * it.sigma);
    let lin = it.linearize > 0.5;
    var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var wsum = 0.0;
    for (var i = -r; i <= r; i = i + 1) {
        let fi = f32(i);
        let w = exp(-fi * fi * inv2s2);
        // Taps clamp to the instance's own cell rect — the exact clamp-to-edge the legacy private
        // texture gave (edge texels replicate, which matters where the viewport clipped a shape
        // mid-ink), expressed as a UV clamp so a tap can never cross into the neighbouring cell.
        let uv = clamp(in.uv + it.step * fi, it.clamp_min, it.clamp_max);
        wsum = wsum + w;
        var s = textureSampleLevel(tex, samp, uv, 0.0);
        if (lin) { s = premul_srgb_to_lin(s); }
        sum = sum + s * w;
    }
    var outc = sum / wsum;
    if (lin) { outc = premul_lin_to_srgb(outc); }
    return outc;
}

@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4<f32> {
    let it = insts[in.inst];
    let uv = clamp(in.uv, it.clamp_min, it.clamp_max);
    return textureSampleLevel(tex, samp, uv, 0.0) * it.alpha;
}
"#;

/// The two instanced pipelines (blur = replace, composite = premultiplied `SrcOver`, both the format
/// the sink renders in) plus their shared bind layout. Built once per sink.
pub(crate) struct BatchPipelines {
    blur: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
}

impl BatchPipelines {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("wv batch"),
            source: wgpu::ShaderSource::Wgsl(BATCH_SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("wv batch layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("wv batch pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let make = |entry: &str, blend: Option<wgpu::BlendState>, label: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleStrip,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let srcover = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        Self {
            blur: make("fs_blur", None, "wv batch blur"),
            composite: make("fs_composite", Some(srcover), "wv batch composite"),
            layout,
        }
    }

    fn bind(
        &self,
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        src: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wv batch bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
            ],
        })
    }

    /// Upload `insts` and run ONE blur pass drawing them all into `target`. The target is cleared
    /// first: the packing's gaps must be transparent, because the next stage's linear sampler grazes
    /// half a texel past each cell rect.
    pub fn blur_pass(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        src: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        insts: &[Inst],
    ) {
        if insts.is_empty() {
            return;
        }
        use wgpu::util::DeviceExt as _;
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("wv batch blur insts"),
            contents: bytemuck::cast_slice(insts),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bind = self.bind(device, &buffer, src, sampler);
        crate::vello::sink::note_passes(1);
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("wv batch blur"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.blur);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..insts.len() as u32);
    }

    /// Run ONE composite pass drawing the instance range `range` of the pre-uploaded `buffer` over
    /// `target` (loaded, `SrcOver`). Instances blend in API order, so a shape's shadow instances
    /// placed before its body instance land under it exactly like the sequential blits did.
    #[expect(clippy::too_many_arguments, reason = "the GPU context travels with the pass")]
    pub fn composite_pass(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        src: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        buffer: &wgpu::Buffer,
        range: Range<u32>,
    ) {
        if range.is_empty() {
            return;
        }
        let bind = self.bind(device, buffer, src, sampler);
        crate::vello::sink::note_passes(1);
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("wv batch composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.composite);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, range);
    }
}
