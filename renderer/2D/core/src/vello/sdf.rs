//! Bake a shape's **signed-distance field** into a texture — the data behind a
//! [`crate::field::FieldSource::Sampled`] lens.
//!
//! The distance a glass lens measures is non-local (a pixel's nearest edge can be far away), so it
//! can't fall out of `fine`'s per-tile coverage. Instead one pass over the shape's flattened line
//! segments computes the exact signed distance for every texel: min distance to any segment, signed by
//! the winding number. Both the segments and the bake happen in DEVICE pixel space — the fragment's
//! `@builtin(position)` is the device pixel it writes, so a lens's field lands at exactly its device
//! pixels. That lets disjoint lenses pack into ONE viewport-sized scratch (a viewport rect scissors
//! each bake to its own region, `load` preserving the others), which `fine` then samples at the device
//! coordinate directly. The texel stores `0.5 + d / decode` so the source recovers `d` as
//! `(texel − 0.5) · decode`; `decode` is sized to the shape so interior distances stay in `[0, 1]`.

const SHADER: &str = r#"
struct Params {
    decode: f32,
    nseg: u32,
    _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> segs: array<vec4<f32>>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) f32 {
    let p = pos.xy;
    var md = 1e30;
    var wind = 0.0;
    for (var i = 0u; i < params.nseg; i = i + 1u) {
        let s = segs[i];
        let a = s.xy;
        let b = s.zw;
        let pa = p - a;
        let ba = b - a;
        let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
        md = min(md, length(pa - ba * h));
        if ((a.y > p.y) != (b.y > p.y)) {
            let xint = a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x);
            if (p.x < xint) {
                wind = wind + select(-1.0, 1.0, b.y > a.y);
            }
        }
    }
    let sd = select(md, -md, abs(wind) > 0.5);
    return clamp(0.5 + sd / params.decode, 0.0, 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    decode: f32,
    nseg: u32,
    _pad: [f32; 2],
}

/// The bake pipeline. One per `Sink`, built once.
pub struct SdfBaker {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
}

/// The signed-distance format: a single 16-bit float channel, renderable and enough precision for the
/// `[0, 1]`-encoded distance.
pub const SDF_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R16Float;

impl SdfBaker {
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sdf bake"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sdf bake layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("sdf bake pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sdf bake pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: SDF_FORMAT,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self { pipeline, layout }
    }

    /// Bake `segments` (DEVICE px, `[x0,y0,x1,y1]` per line) into `target`'s device rectangle
    /// `region = (x, y, w, h)`, storing the signed distance encoded by `decode`. `clear` wipes the
    /// whole `target` first (the first lens into a fresh scratch); a later lens passes `clear = false`
    /// so its bake `load`s and only its own region — scissored by the viewport — is touched. `target`
    /// must be `SDF_FORMAT` with `RENDER_ATTACHMENT`, at least `region`-sized.
    #[expect(clippy::too_many_arguments, reason = "a bake is device context + target + region + shape")]
    pub fn bake_into(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        segments: &[[f32; 4]],
        region: (u32, u32, u32, u32),
        decode: f32,
        clear: bool,
    ) {
        // A one-line dummy keeps the storage buffer non-empty (and the loop a no-op) for a shape that
        // flattened to nothing — the field then reads a constant "far outside" everywhere.
        let fallback = [[0.0f32, 0.0, 0.0, 0.0]];
        let seg_slice: &[[f32; 4]] = if segments.is_empty() { &fallback } else { segments };
        let params = Params { decode, nseg: segments.len() as u32, _pad: [0.0, 0.0] };
        let ubuf = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor {
            label: Some("sdf bake params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let sbuf = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor {
            label: Some("sdf bake segments"),
            contents: bytemuck::cast_slice(seg_slice),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sdf bake bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: sbuf.as_entire_binding() },
            ],
        });
        // Clear to the MAX encoded value (1.0), which decodes to `+0.5·decode` — "far outside" the shape.
        // Black (0.0) would decode to a NEGATIVE distance ("inside") everywhere the bake doesn't cover, so
        // the lens would refract the whole viewport-minus-region; a max clear makes every untouched texel
        // read as outside (the field early-outs there).
        let load = if clear {
            wgpu::LoadOp::Clear(wgpu::Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 })
        } else {
            wgpu::LoadOp::Load
        };
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("sdf bake pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        // Scissor + viewport to this lens's device rectangle: the fullscreen triangle's fragments carry
        // their device pixel in `@builtin(position)`, so only `region`'s texels run and each holds the
        // distance at its own device coordinate.
        let (rx, ry, rw, rh) = region;
        pass.set_viewport(rx as f32, ry as f32, rw as f32, rh as f32, 0.0, 1.0);
        pass.set_scissor_rect(rx, ry, rw, rh);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
        drop(pass);
    }
}

/// Flatten a shape's outline (in field-local device space, centred at the lens centre) to line
/// segments for the bake. `tolerance` is in the same device pixels.
#[must_use]
pub fn flatten_segments(path: &crate::kurbo::BezPath, tolerance: f64) -> Vec<[f32; 4]> {
    use crate::kurbo::PathEl;
    let mut segs = Vec::new();
    let mut start = crate::kurbo::Point::ZERO;
    let mut cur = crate::kurbo::Point::ZERO;
    let mut line = |a: crate::kurbo::Point, b: crate::kurbo::Point, out: &mut Vec<[f32; 4]>| {
        out.push([a.x as f32, a.y as f32, b.x as f32, b.y as f32]);
    };
    crate::kurbo::flatten(path.elements().iter().copied(), tolerance, |el| match el {
        PathEl::MoveTo(p) => {
            start = p;
            cur = p;
        }
        PathEl::LineTo(p) => {
            line(cur, p, &mut segs);
            cur = p;
        }
        PathEl::ClosePath => {
            line(cur, start, &mut segs);
            cur = start;
        }
        _ => {}
    });
    segs
}
