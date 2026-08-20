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
/// (a copy/composite instance leaves it unused); `src2`/`clamp2` are the second read the erase
/// stage takes (the punch). Layout matches the WGSL `Inst` struct: eleven `vec2<f32>` then eight
/// `f32`, 120 bytes, align 8.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Inst {
    pub dst_min: [f32; 2],
    pub dst_max: [f32; 2],
    pub src_min: [f32; 2],
    pub src_max: [f32; 2],
    pub clamp_min: [f32; 2],
    pub clamp_max: [f32; 2],
    pub src2_min: [f32; 2],
    pub src2_max: [f32; 2],
    pub clamp2_min: [f32; 2],
    pub clamp2_max: [f32; 2],
    pub step: [f32; 2],
    pub sigma: f32,
    pub radius: f32,
    pub linearize: f32,
    pub alpha: f32,
    /// Composite source select: 0 = the blurred atlas (`tex0`), 1 = the combined atlas (`tex1`,
    /// where the erase stage materialised inner-shadow bands). The glass stages reuse it as the
    /// instance's index into the field buffer.
    pub mode: f32,
    /// `[0]` = stage tag (see `fs_uber`); `[1]`/`[2]` = this instance's destination origin in target
    /// pixels, which the glass stages subtract from `@builtin(position)` to recover the cell-local
    /// fragment coordinate the field math is expressed in.
    pub _pad: [f32; 3],
}

/// One glass cell's field parameters — the same 24-float composed uniform the per-shape pipeline
/// binds ([`super::glass`]), here indexed out of a storage array so every cell in a batched stage
/// carries its own. `align(16)` matches the WGSL `array<vec4<f32>, 6>` it maps to.
#[repr(C, align(16))]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct GlassField {
    pub u: [f32; 24],
}

/// Stage tags stamped into `Inst::_pad[0]`, selecting the arm `fs_uber` runs.
pub(crate) mod stage {
    /// Plain copy / composite of one source rect (the default arm).
    pub const COMPOSITE: f32 = 0.0;
    /// Separable Gaussian tap loop along the instance's `step`.
    pub const BLUR: f32 = 2.0;
    /// EraseBy combine: `flood × (1 − punch.a)`.
    pub const COMBINE: f32 = 3.0;
    /// Glass warp alone — the head of a frosted chain, whose result a blur then consumes.
    pub const GLASS_WARP: f32 = 4.0;
    /// Sharp glass: warp + shade + mask-mix fused, the whole lens in one draw.
    pub const GLASS_SHARP: f32 = 5.0;
    /// Frosted glass tail: scatter + shade + mask-mix over the blurred warp.
    pub const GLASS_FROST: f32 = 6.0;
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
            src2_min: [0.0; 2],
            src2_max: [0.0; 2],
            clamp2_min: [0.0; 2],
            clamp2_max: [0.0; 2],
            step: [dir.0 * iw, dir.1 * ih],
            sigma: s,
            radius: (3.0 * s).ceil().clamp(1.0, 160.0),
            linearize: if blurred && linear { 1.0 } else { 0.0 },
            alpha: 1.0,
            mode: 0.0,
            _pad: [0.0; 3],
        }
    }

    /// The instance tagged with its destination origin in target pixels — what the glass arms
    /// subtract from the fragment position to get the cell-local coordinate the field is expressed
    /// in. Integers on both sides, so the recovered coordinate is exactly the dedicated-texture
    /// `fragCoord` the per-shape pipeline sees.
    pub fn at(mut self, dst_rect: (f32, f32, f32, f32)) -> Self {
        self._pad[1] = dst_rect.0;
        self._pad[2] = dst_rect.1;
        self
    }

    /// The instance with a second source rect (pixels in the same `src_size` texture): the erase
    /// stage reads the punch through it, the band composite selects `tex1` through `mode`.
    pub fn with_src2(mut self, src2_rect: (f32, f32, f32, f32), src_size: (f32, f32), mode: f32) -> Self {
        let (sx, sy, sw, sh) = src2_rect;
        let (iw, ih) = (1.0 / src_size.0, 1.0 / src_size.1);
        self.src2_min = [sx * iw, sy * ih];
        self.src2_max = [(sx + sw) * iw, (sy + sh) * ih];
        self.clamp2_min = [(sx + 0.5) * iw, (sy + 0.5) * ih];
        self.clamp2_max = [(sx + sw - 0.5) * iw, (sy + sh - 0.5) * ih];
        self.mode = mode;
        self
    }
}

const BATCH_PRELUDE: &str = r#"
struct Inst {
    dst_min: vec2<f32>,
    dst_max: vec2<f32>,
    src_min: vec2<f32>,
    src_max: vec2<f32>,
    clamp_min: vec2<f32>,
    clamp_max: vec2<f32>,
    src2_min: vec2<f32>,
    src2_max: vec2<f32>,
    clamp2_min: vec2<f32>,
    clamp2_max: vec2<f32>,
    step: vec2<f32>,
    sigma: f32,
    radius: f32,
    linearize: f32,
    alpha: f32,
    mode: f32,
    _p0: f32,
    _p1: f32,
    _p2: f32,
};
@group(0) @binding(0) var<storage, read> insts: array<Inst>;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex2: texture_2d<f32>;

struct GlassField { u: array<vec4<f32>, 6> };
@group(0) @binding(4) var<storage, read> fields: array<GlassField>;

// The running instance's cell rects, published before a glass arm runs its shared unit body: the
// body samples in the CELL's normalised space, and these map that onto the atlas rect the cell
// actually occupies. The clamps reproduce a dedicated texture's ClampToEdge at the rect's own edge
// texels, so a sample can never bleed in from a neighbouring cell.
var<private> g_src_min: vec2<f32>;
var<private> g_src_max: vec2<f32>;
var<private> g_src_cmin: vec2<f32>;
var<private> g_src_cmax: vec2<f32>;
var<private> g_orig_min: vec2<f32>;
var<private> g_orig_max: vec2<f32>;
var<private> g_orig_cmin: vec2<f32>;
var<private> g_orig_cmax: vec2<f32>;

fn fieldU(gi: u32, i: u32) -> vec4<f32> { return fields[gi].u[i]; }
fn glassSample(gi: u32, uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(tex, samp, clamp(mix(g_src_min, g_src_max, uv), g_src_cmin, g_src_cmax), 0.0);
}
fn glassSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(tex2, samp, clamp(mix(g_orig_min, g_orig_max, uv), g_orig_cmin, g_orig_cmax), 0.0);
}
fn glassBegin(it: Inst) {
    g_src_min = it.src_min; g_src_max = it.src_max;
    g_src_cmin = it.clamp_min; g_src_cmax = it.clamp_max;
    g_orig_min = it.src2_min; g_orig_max = it.src2_max;
    g_orig_cmin = it.clamp2_min; g_orig_cmax = it.clamp2_max;
}

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
    @location(1) uv2: vec2<f32>,
    @location(2) @interpolate(flat) inst: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    let it = insts[ii];
    var out: VSOut;
    out.pos = vec4<f32>(mix(it.dst_min, it.dst_max, corner), 0.0, 1.0);
    out.uv = mix(it.src_min, it.src_max, corner);
    out.uv2 = mix(it.src2_min, it.src2_max, corner);
    out.inst = ii;
    return out;
}

fn blur_px(in: VSOut) -> vec4<f32> {
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


// The EraseBy combine: `flood * (1 - punch.a)` — DestOut in one read pair, both rects living in the
// SAME blurred atlas (`tex` and `tex2` bind the same view here). Runs at cell resolution with a
// replace target, so the band is materialised before any filtering — the same order the per-shape
// `blit_dstout` produced.
fn combine_px(in: VSOut) -> vec4<f32> {
    let it = insts[in.inst];
    let flood = textureSampleLevel(tex, samp, clamp(in.uv, it.clamp_min, it.clamp_max), 0.0);
    let punch = textureSampleLevel(tex2, samp, clamp(in.uv2, it.clamp2_min, it.clamp2_max), 0.0);
    return flood * (1.0 - punch.a);
}

fn composite_px(in: VSOut) -> vec4<f32> {
    let it = insts[in.inst];
    let uv = clamp(in.uv, it.clamp_min, it.clamp_max);
    if (it.mode > 0.5) {
        return textureSampleLevel(tex2, samp, uv, 0.0) * it.alpha;
    }
    return textureSampleLevel(tex, samp, uv, 0.0) * it.alpha;
}

"#;



/// Where a stage reads or writes: the frame's accumulator as it stands in the current window, or a
/// slot in the scratch atlas set the plan allocated.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Surface {
    Acc,
    Atlas(usize),
}

/// One batched stage — **every instance in it is drawn by a single pass**.
///
/// This is the whole pass-minimisation rule, as data: work is bucketed by *stage*, and a bucket
/// costs one pass no matter how many shapes contributed to it. A planner's only job is to emit these
/// in dependency order; it never issues a pass itself, so no effect can accidentally reintroduce a
/// per-shape chain. Blur cells, glass lenses and (next) distance-field bakes all reduce to this.
///
/// `round` is `None` for work hoisted out of the round loop — anything whose inputs do not touch the
/// backdrop — and `Some(r)` for work pinned to a round because it reads what that round painted.
pub(crate) struct Stage {
    pub round: Option<u32>,
    pub tag: f32,
    pub target: Surface,
    pub src: Surface,
    pub src2: Surface,
    pub insts: Vec<Inst>,
    /// Per-cell field parameters for the stages that evaluate a field; empty otherwise.
    pub fields: Vec<GlassField>,
    /// Premultiplied `SrcOver` (a composite) rather than replace (a materialisation).
    pub blend: bool,
    /// Clear the target first — for a stage that owns its whole surface, where the packing's gaps
    /// must be transparent because the next stage's sampler grazes half a texel past each cell.
    pub clear: bool,
}

impl Stage {
    /// A materialising stage: replace, no clear, reading one surface.
    pub fn new(tag: f32, target: Surface, src: Surface, insts: Vec<Inst>) -> Self {
        Self { round: None, tag, target, src, src2: src, insts, fields: Vec::new(), blend: false, clear: false }
    }

    pub fn with_round(mut self, round: u32) -> Self {
        self.round = Some(round);
        self
    }

    pub fn with_fields(mut self, fields: Vec<GlassField>) -> Self {
        self.fields = fields;
        self
    }

    pub fn with_src2(mut self, src2: Surface) -> Self {
        self.src2 = src2;
        self
    }

    pub fn composited(mut self) -> Self {
        self.blend = true;
        self
    }

    pub fn cleared(mut self) -> Self {
        self.clear = true;
        self
    }
}

/// The two instanced pipelines (blur = replace, composite = premultiplied `SrcOver`, both the format
/// the sink renders in) plus their shared bind layout. Built once per sink.
pub(crate) struct BatchPipelines {
    /// `fs_uber` with a replace target — the blur and combine passes.
    replace: wgpu::RenderPipeline,
    /// `fs_uber` blending premultiplied `SrcOver` — the per-round composite passes.
    composite: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    /// One-element placeholder bound at binding 4 by every non-glass stage.
    no_fields: wgpu::Buffer,
}

/// Emit one glass arm: publish the instance's cell rects, recover the cell-local fragment
/// coordinate from the destination origin the instance carries, then run the SHARED unit body for
/// this composition ([`super::glass::units_body`]) — the same text the per-shape pipeline compiles,
/// so a batched cell and a dedicated-texture cell execute identical math.
fn glass_arm(name: &str, key: (u8, bool, bool, bool, bool)) -> String {
    format!(
        r#"
fn {name}(in: VSOut) -> vec4<f32> {{
    let it = insts[in.inst];
    glassBegin(it);
    let gi = u32(it.mode);
    let fc = in.pos.xy - vec2<f32>(it._p1, it._p2);
    let uvpix = fc / fieldU(gi, 0u).xy;
{body}
    return value;
}}
"#,
        body = crate::vello::glass::units_body(key, &crate::vello::glass::glass_field_program())
    )
}

/// The whole batch module: the prelude, the glass arms generated from the shared unit bodies, and
/// the single `fs_uber` entry every stage dispatches through.
fn batch_shader() -> String {
    let mut s = String::from(BATCH_PRELUDE);
    s.push_str(&crate::vello::glass::field_prelude(&crate::vello::glass::glass_field_program()));
    if crate::vello::glass::needs_hash((2, false, false, false, false)) {
        s.push_str(crate::vello::glass::HASH_PRELUDE);
    }
    s.push_str(&glass_arm("glass_warp_px", (1, false, false, false, false)));
    s.push_str(&glass_arm("glass_sharp_px", (1, true, true, false, false)));
    s.push_str(&glass_arm("glass_frost_px", (2, true, true, false, true)));
    s.push_str(
        r#"
// Every kernel in ONE function behind a per-instance switch (`_p0` = the stage tag). Measured free
// on Apple (timing A/B vs specialised entries) and AMD (LLPC: 32 VGPRs = max of the arms, full
// occupancy, no spills) — and one function means a future wave pass draws mixed node kinds in a
// single instanced draw with no per-kind sorting.
@fragment
fn fs_uber(in: VSOut) -> @location(0) vec4<f32> {
    let stage = insts[in.inst]._p0;
    if (stage > 5.5) {
        return glass_frost_px(in);
    }
    if (stage > 4.5) {
        return glass_sharp_px(in);
    }
    if (stage > 3.5) {
        return glass_warp_px(in);
    }
    if (stage > 2.5) {
        return combine_px(in);
    }
    if (stage > 1.5) {
        return blur_px(in);
    }
    return composite_px(in);
}
"#,
    );
    s
}

impl BatchPipelines {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("wv batch"),
            source: wgpu::ShaderSource::Wgsl(batch_shader().into()),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
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
        use wgpu::util::DeviceExt as _;
        let no_fields = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("wv batch no fields"),
            contents: bytemuck::cast_slice(&[GlassField { u: [0.0; 24] }]),
            usage: wgpu::BufferUsages::STORAGE,
        });
        Self {
            replace: make("fs_uber", None, "wv batch replace"),
            composite: make("fs_uber", Some(srcover), "wv batch composite"),
            layout,
            no_fields,
        }
    }

    fn bind(
        &self,
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        src: &wgpu::TextureView,
        src2: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        self.bind_fields(device, buffer, src, src2, sampler, &self.no_fields)
    }

    /// [`Self::bind`] with an explicit field buffer — the glass stages' per-cell parameters. Every
    /// other stage binds the one-element placeholder, since the layout always declares binding 4.
    #[expect(clippy::too_many_arguments, reason = "one bind group, one argument per binding")]
    fn bind_fields(
        &self,
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        src: &wgpu::TextureView,
        src2: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        fields: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wv batch bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(src2) },
                wgpu::BindGroupEntry { binding: 4, resource: fields.as_entire_binding() },
            ],
        })
    }

    /// Upload `insts` stamped with `tag` as a storage buffer.
    fn upload(&self, device: &wgpu::Device, insts: &[Inst], tag: f32) -> wgpu::Buffer {
        use wgpu::util::DeviceExt as _;
        let stamped: Vec<Inst> = insts
            .iter()
            .map(|i| {
                let mut i = *i;
                i._pad[0] = tag;
                i
            })
            .collect();
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("wv batch insts"),
            contents: bytemuck::cast_slice(&stamped),
            usage: wgpu::BufferUsages::STORAGE,
        })
    }

    /// Run ONE [`Stage`]: upload its instances and its field parameters, then draw every one of
    /// them in a single render pass. This is the only place the batch issues a pass — planners emit
    /// stages and never touch the encoder, which is what keeps pass count a function of the distinct
    /// stages in a frame rather than of the shapes in it.
    pub fn run_stage(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        stage: &Stage,
        acc: &wgpu::TextureView,
        atlas: &[&wgpu::TextureView],
        sampler: &wgpu::Sampler,
    ) {
        if stage.insts.is_empty() {
            return;
        }
        let resolve = |s: Surface| match s {
            Surface::Acc => acc,
            Surface::Atlas(i) => atlas[i],
        };
        let buffer = self.upload(device, &stage.insts, stage.tag);
        let fields = if stage.fields.is_empty() {
            None
        } else {
            use wgpu::util::DeviceExt as _;
            Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("wv stage fields"),
                contents: bytemuck::cast_slice(&stage.fields),
                usage: wgpu::BufferUsages::STORAGE,
            }))
        };
        let bind = self.bind_fields(
            device,
            &buffer,
            resolve(stage.src),
            resolve(stage.src2),
            sampler,
            fields.as_ref().unwrap_or(&self.no_fields),
        );
        crate::vello::sink::note_passes(1);
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("wv batch stage"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: resolve(stage.target),
                resolve_target: None,
                ops: wgpu::Operations {
                    load: if stage.clear {
                        wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                    } else {
                        wgpu::LoadOp::Load
                    },
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(if stage.blend { &self.composite } else { &self.replace });
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..stage.insts.len() as u32);
    }

    /// Run every stage belonging to `round` (or every hoisted stage when `round` is `None`).
    pub fn run_stages(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        stages: &[Stage],
        round: Option<u32>,
        acc: &wgpu::TextureView,
        atlas: &[&wgpu::TextureView],
        sampler: &wgpu::Sampler,
    ) {
        for stage in stages.iter().filter(|s| s.round == round) {
            self.run_stage(device, enc, stage, acc, atlas, sampler);
        }
    }
}
