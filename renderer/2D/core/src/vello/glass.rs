//! Glass **unit** shaders — the fragment snippet library the effect executor composes into passes.
//!
//! Glass is not a shader here; it is a *graph of generic units* (see [`crate::effect_graph`]):
//! `warp → blur → scatter → shade → mask-mix`. The footprint partition decides which units share a
//! fragment (a gather head plus its pointwise tail), and [`GlassPipeline::units`] compiles ONE
//! pipeline per distinct composition from the snippet bodies below, cached by composition key. Sharp
//! glass (`warp+shade+mask-mix`, one draw, no intermediates) and the frosted composite
//! (`scatter+shade+mask-mix`) are *derived* fusions — there is no hand-written fused shader left.
//!
//! The rounded-box SDF + surface-profile bezel → field `(dx, dy, specular, mask)` is pure arithmetic
//! on the uniform, recomputed inline by every composed pass via the generated [`field_prelude`]'s `computeField` —
//! a procedural generator is register-fused, never stored.
//!
//! Every composed pass reads one 24-float (`6×vec4`) uniform: indices 0..16 the field geometry,
//! then `chromaticAberration` at 17, `frost` at 18, `specularOpacity` at 19, `specularSaturation`
//! at 20 (packed as `array<vec4<f32>, N>` to sidestep std140 scalar alignment). Colours are
//! premultiplied; the mask-mix carries the backdrop's alpha through so a transparent scoped
//! backdrop stays transparent.

use std::cell::RefCell;
use std::collections::HashMap;

use wgpu::util::DeviceExt;

/// One unit in a composed pass, lowered: the discriminant selects its snippet, the payload is the
/// 20-float IR uniform it was declared with ([`crate::effect_graph::EffectPass`] unit kinds).
#[derive(Debug, Clone, PartialEq)]
pub enum UnitOp {
    /// Masked displaced sample + chromatic aberration (a composed pass's sampling head).
    Warp(Vec<f32>),
    /// Jittered sample (a composed pass's sampling head).
    Scatter(Vec<f32>),
    /// Pointwise lit term, weighted by the field's specular output.
    Shade(Vec<f32>),
    /// Pointwise final lerp against a second input by the field's mask output.
    MaskMix(Vec<f32>),
}

/// A composed pass's pipeline cache key: (sampling head: 0 plain / 1 warp / 2 scatter,
/// has shade, has mask-mix, binds a distinct original texture).
type UnitKey = (u8, bool, bool, bool);

pub struct GlassPipeline {
    format: wgpu::TextureFormat,
    one_tex_layout: wgpu::BindGroupLayout,
    two_tex_layout: wgpu::BindGroupLayout,
    /// Composed unit pipelines, built lazily per distinct composition — a handful of keys total.
    units: RefCell<HashMap<UnitKey, wgpu::RenderPipeline>>,
    /// `TileMode::Clamp` fill: extend the scope's content over the transparent surround so a lens that
    /// overhangs its scope reads the clamped edge instead of nil — see [`Self::clamp_fill`].
    clamp_fill: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

fn make_pipeline(
    device: &wgpu::Device,
    label: &str,
    shader: &wgpu::ShaderModule,
    layout: &wgpu::BindGroupLayout,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
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
}

impl GlassPipeline {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let one_tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass units layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        let two_tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass units layout (original)"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2), texture_entry(3)],
        });

        let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass clamp-fill"),
            source: wgpu::ShaderSource::Wgsl(clamp_fill_shader().into()),
        });
        let clamp_fill = make_pipeline(device, "glass clamp fill", &clamp_shader, &one_tex_layout, format);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glass sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            format,
            one_tex_layout,
            two_tex_layout,
            units: RefCell::new(HashMap::new()),
            clamp_fill,
            sampler,
        }
    }

    /// `TileMode::Clamp` fill: read `src` (the composed scoped backdrop — content over a transparent
    /// surround) and write `target` with the transparent surround replaced by the nearest content along
    /// the ray toward the texture centre. That "extends" the scope's edge outward so a lens overhanging
    /// its scope reads the clamped edge instead of nil. `resolution` is the backdrop's `(w, h)` in texels.
    pub fn clamp_fill(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, src: &wgpu::TextureView, resolution: (f32, f32), content_rect: [f32; 4]) {
        let uniform = Self::uniform(device, &[
            resolution.0, resolution.1, 0.0, 0.0,
            content_rect[0], content_rect[1], content_rect[2], content_rect[3],
        ]);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass clamp bind"),
            layout: &self.one_tex_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        Self::full_pass(encoder, target, &self.clamp_fill, &bind);
    }

    fn uniform(device: &wgpu::Device, data: &[f32]) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("glass uniform"),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }

    fn full_pass(encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, bind: &wgpu::BindGroup) {
        crate::vello::sink::note_passes(1);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glass pass"),
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
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, bind, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Run one **composed pass** — the fused run of `ops` (a sampling head plus pointwise tail) —
    /// over `src` into `target`, binding `original` only when a mask-mix reads a backdrop distinct
    /// from `src`. The pipeline for this composition is compiled on first use and cached; the
    /// composed uniform is assembled from the units' IR uniforms by [`units_uniform`].
    ///
    /// When a run fuses what used to be separate materialised passes, the result is *more* accurate,
    /// never worse: the intermediate stays in registers as float instead of quantising to 8-bit.
    pub fn units(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, src: &wgpu::TextureView, original: Option<&wgpu::TextureView>, ops: &[UnitOp], field: &std::rc::Rc<crate::field::FieldProgram>) {
        let head = match ops.first() {
            Some(UnitOp::Warp(_)) => 1u8,
            Some(UnitOp::Scatter(_)) => 2,
            _ => 0,
        };
        let shade = ops.iter().any(|o| matches!(o, UnitOp::Shade(_)));
        let maskmix = ops.iter().any(|o| matches!(o, UnitOp::MaskMix(_)));
        let key: UnitKey = (head, shade, maskmix, original.is_some());
        if !self.units.borrow().contains_key(&key) {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("glass units (composed)"),
                source: wgpu::ShaderSource::Wgsl(units_shader(key, field).into()),
            });
            let layout = if key.3 { &self.two_tex_layout } else { &self.one_tex_layout };
            let pipeline = make_pipeline(device, "glass units", &module, layout, self.format);
            self.units.borrow_mut().insert(key, pipeline);
        }
        let uniform = Self::uniform(device, &units_uniform(ops));
        let mut entries = vec![
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
        ];
        if let Some(orig) = original {
            entries.push(wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(orig) });
        }
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass units bind"),
            layout: if key.3 { &self.two_tex_layout } else { &self.one_tex_layout },
            entries: &entries,
        });
        let cache = self.units.borrow();
        Self::full_pass(encoder, target, &cache[&key], &bind);
    }
}

/// Assemble the composed 24-float uniform from the run's units: the field geometry (0..16) comes
/// from the head (every unit in a run carries the identically-scaled field), and each unit
/// contributes its own trailing params to the composed slots — `chromaticAberration` 17, `frost` 18,
/// `specularOpacity` 19, `specularSaturation` 20.
pub(crate) fn units_uniform(ops: &[UnitOp]) -> [f32; 24] {
    let mut out = [0.0_f32; 24];
    for op in ops {
        let (UnitOp::Warp(u) | UnitOp::Scatter(u) | UnitOp::Shade(u) | UnitOp::MaskMix(u)) = op;
        // Every unit of a run carries the same field geometry; each contributes only the trailing
        // slots its own kind uses, so merging them is a per-slot max of what was actually set.
        for (i, v) in u.iter().enumerate().take(24) {
            if out[i] == 0.0 {
                out[i] = *v;
            }
        }
    }
    out
}

/// The lens's field, as a [`crate::field::FieldProgram`]: a rounded-box distance, the inward edge
/// ramp, the surface direction, the Snell refraction of the bevel, and the coverage mask. Everything
/// here is a generic field operator — only the assembly in [`field_prelude`] (edge boost, zoom,
/// specular tint) is particular to glass, and the source is the single place a different geometry
/// would plug in.
///
/// Slots address the shared 24-float uniform: centre `0.zw`, half-extents `1.xy`, corner `1.z`,
/// profile kind `1.w`, bezel `2.x`, thickness `2.y`, index of refraction `2.z`, light angle `2.w`,
/// splay `3.x`, tilt `3.y`, edge boost `3.z`, zoom `3.w`, device scale `4.x`.
pub(crate) fn glass_field_program() -> crate::field::FieldProgram {
    use crate::field::{FieldOp, FieldProgram, FieldRef, FieldSource, Slot, Slot2};
    FieldProgram {
        nodes: vec![
            FieldOp::Distance(FieldSource::RoundedBox {
                centre: Slot2::new(0, 2),
                half: Slot2::new(1, 0),
                corner: Slot::new(1, 2),
            }),
            FieldOp::Ramp { d: FieldRef::Node(0), edge: Slot::new(2, 0), clamp_edge_to_extent: true },
            FieldOp::RadialDirection {
                half: Slot2::new(1, 0),
                splay: Slot::new(3, 0),
                tilt: Slot::new(3, 1),
            },
            FieldOp::Refract {
                t: FieldRef::Node(1),
                thickness: Slot::new(2, 1),
                ior: Slot::new(2, 2),
                kind: Slot::new(1, 3),
            },
            FieldOp::Coverage { d: FieldRef::Node(0), softness: Slot::new(4, 0), softness_gain: 1.5 },
        ],
        outputs: vec![
            ("dist", FieldRef::Node(0)),
            ("edgeT", FieldRef::Node(1)),
            ("dir", FieldRef::Node(2)),
            ("refracted", FieldRef::Node(3)),
            ("mask", FieldRef::Node(4)),
        ],
    }
}

/// The lens's specular streak: a Gaussian band across the bevel, modulated by how squarely the
/// surface faces the light. The band is [`crate::field::FIELD_BAND`] — the same operator a stroke or
/// an outline uses — and only the lighting term below is particular to glass.
const GLASS_SPECULAR: &str = r#"
fn glassSpecular(t: f32, bezel: f32, lightAngle: f32, dir: vec2<f32>, scale: f32) -> f32 {
    if (t <= 0.0 || t >= 1.0) { return 0.0; }
    let band = fieldBand(t * bezel, 2.0 * scale, scale);
    let ld = vec2<f32>(cos(lightAngle), sin(lightAngle));
    var f = abs(dot(dir, ld));
    f = pow(f, 2.0);
    return band * f;
}
"#;

/// `computeField`, generated from [`glass_field_program`] plus the lens-specific assembly. The
/// early-out sits immediately after the distance so nothing beyond the shape is evaluated, which is
/// why the program is emitted in two runs rather than one.
pub(crate) fn field_prelude(p: &crate::field::FieldProgram) -> String {
    // A lens declares `refracted`, and only a lens wants the bezel/zoom/specular assembly below.
    // Any other program — a procedural displacement, a stroke, a bevel — is packed straight from
    // whatever it says it produces, defaulting to no displacement and full coverage. This is the
    // seam that lets `computeField` serve a field with no shape at all.
    let tail = if p.declares("refracted") {
        r#"    let bezel = min(fieldU(gi, 2u).x, min(fieldU(gi, 1u).x, fieldU(gi, 1u).y));
    var disp = refracted * scale;
    let edgeFade = pow(1.0 - edgeT, 1.5);
    disp = disp * (1.0 + fieldU(gi, 3u).z * edgeFade);
    var dpx = dir * disp;
    let zoomFactor = 1.0 / max(fieldU(gi, 3u).w, 0.1) - 1.0;
    dpx = dpx + localPos * zoomFactor;
    let specular = glassSpecular(edgeT, bezel, fieldU(gi, 2u).w, dir, scale);
    return vec4<f32>(dpx.x, dpx.y, specular, mask);
"#
        .to_string()
    } else {
        format!(
            "    return vec4<f32>({d}.x, {d}.y, {s}, {m});\n",
            d = if p.declares("displacement") { "displacement" } else { "vec2<f32>(0.0)" },
            s = if p.declares("specular") { "specular" } else { "0.0" },
            m = if p.declares("mask") { "mask" } else { "1.0" },
        )
    };
    // The outside-the-shape early-out only exists for a program measuring distance from a shape.
    let (guard, distance, rest) = if p.declares("dist") {
        (
            "    if (n0 > 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }\n".to_string(),
            p.wgsl_nodes(0..1),
            p.wgsl_nodes(1..p.nodes.len()),
        )
    } else {
        (String::new(), String::new(), p.wgsl_nodes(0..p.nodes.len()))
    };
    format!(
        "{helpers}{band}{spec}\n\
// The field at device pixel `fc`, packed as (displacement.x, displacement.y, specular, mask).\n\
fn computeField(gi: u32, fc: vec2<f32>) -> vec4<f32> {{\n\
    let scale = fieldU(gi, 4u).x;\n\
{prologue}{distance}{guard}{rest}{outputs}{tail}}}\n",
        helpers = p.helpers(),
        band = crate::field::FIELD_BAND,
        spec = GLASS_SPECULAR,
        prologue = p.wgsl_prologue(),
        outputs = p.wgsl_outputs(),
    )
}

const VERTEX_SHADER: &str = r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#;

/// Noise helpers for the frost scatter — included only when a composed pass has a scatter head.
pub(crate) const HASH_PRELUDE: &str = r#"
fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn hash2(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(hash(p), hash(p + vec2<f32>(73.7, 157.3))) * 2.0 - 1.0;
}
"#;

/// The **unit chain body** for one composition — the shared math, emitted identically by every
/// backend that runs these units (the per-shape pipelines below and the instanced batch stages in
/// [`super::batch`]). It is a straight-line chain over a running `value`: a sampling head (plain
/// same-pixel sample, the warp's masked displaced sample, or the frost scatter), then the pointwise
/// tails in unit order. Every sample sits in uniform control flow (the frost branch tests a uniform;
/// WGSL forbids `textureSample` under per-pixel branches, and the warp's passthrough is covered by
/// `mask == 0 → refUV == uvpix` instead of a branch). The mask-mix carries the backdrop's
/// premultiplied alpha through so a transparent scoped backdrop stays transparent instead of
/// compositing as opaque black, and the shade gates its shine by the running alpha so a scoped lens
/// is fully NIL where its scope has no content.
///
/// The body is written against a small contract the caller must have in scope, which is what lets
/// one text serve a dedicated texture and an atlas cell alike:
/// - `gi: u32` — the field index (`0u` when the field lives in a uniform),
/// - `fc: vec2<f32>` — the fragment's position in the *cell's* pixel space,
/// - `uvpix: vec2<f32>` — the same position in the cell's normalised space,
/// - `fieldU(gi, i)`, `glassSample(gi, uv)`, `glassSampleOrig(gi, uv)` — the accessors,
/// and it leaves the result in `value`.
pub(crate) fn units_body((head, shade, maskmix, _two_tex): UnitKey) -> String {
    let mut fs = String::from(
        r#"
    let resolution = fieldU(gi, 0u).xy;
    let scale = fieldU(gi, 4u).x;
    let field = computeField(gi, fc);
    let dpx = field.xy;
    let specular = field.b;
    let mask = field.a;
"#,
    );
    fs.push_str(match head {
        1 => r#"
    let chromaticAberration = fieldU(gi, 4u).y;
    let dispUV = dpx / resolution;
    let dLen = length(dpx);
    let caStr = smoothstep(0.0, 5.0 * scale, dLen);
    var caDir = vec2<f32>(0.0);
    if (dLen > 0.01 * scale) { caDir = dpx / dLen; }
    let caShift = caDir * chromaticAberration * caStr / resolution;
    let refUV = uvpix + dispUV;
    let refracted = vec4<f32>(
        glassSample(gi, refUV - caShift).r,
        glassSample(gi, refUV).g,
        glassSample(gi, refUV + caShift).b,
        glassSample(gi, refUV).a
    );
    let srcbg = glassSample(gi, uvpix);
    var value = mix(srcbg, refracted, mask);
"#,
        2 => r#"
    let frost = fieldU(gi, 4u).z;
    let texel = vec2<f32>(1.0) / resolution;
    var value = vec4<f32>(0.0);
    if (frost > 0.01) {
        var frostSum = vec4<f32>(0.0);
        var totalW = 0.0;
        for (var i = 0.0; i < 12.0; i = i + 1.0) {
            let noise = hash2(fc + vec2<f32>(i * 7.3, i * 13.1));
            let off = noise * frost * 6.0 * scale * texel;
            frostSum = frostSum + glassSample(gi, uvpix + off);
            totalW = totalW + 1.0;
        }
        value = frostSum / totalW;
    } else {
        value = glassSample(gi, uvpix);
    }
"#,
        _ => r#"
    var value = glassSample(gi, uvpix);
"#,
    });
    if shade {
        fs.push_str(
            r#"
    let specularOpacity = fieldU(gi, 4u).w;
    let specularSaturation = fieldU(gi, 5u).x;
    let specLuma = dot(value.rgb, vec3<f32>(0.299, 0.587, 0.114));
    var saturated = mix(vec3<f32>(specLuma), value.rgb, 1.0 + specularSaturation);
    saturated = max(saturated, vec3<f32>(0.0));
    let highlightColor = mix(vec3<f32>(1.0, 0.98, 0.95), saturated, min(specularSaturation / 9.0, 1.0));
    value = vec4<f32>(value.rgb + specular * specularOpacity * highlightColor * value.a, value.a);
"#,
        );
    }
    if maskmix {
        fs.push_str(
            r#"
    let bg = glassSampleOrig(gi, uvpix);
    value = vec4<f32>(mix(bg.rgb, value.rgb, mask), mix(bg.a, value.a, mask));
"#,
        );
    }
    fs
}

/// Whether a composition's head samples with a noise jitter — the one unit needing [`HASH_PRELUDE`].
pub(crate) fn needs_hash(key: UnitKey) -> bool {
    key.0 == 2
}

/// Compose the per-shape fragment shader for one unit run: the shared [`units_body`] wired to a
/// dedicated source texture (and an `original` texture when a mask-mix reads a distinct backdrop),
/// with the field in a uniform (so `gi` is always `0u`).
fn units_shader(key: UnitKey, program: &crate::field::FieldProgram) -> String {
    let (_, _, _, two_tex) = key;
    let mut bindings = String::from(
        r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 6>;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
"#,
    );
    if two_tex {
        bindings.push_str("@group(0) @binding(3) var original: texture_2d<f32>;\n");
    }
    if needs_hash(key) {
        bindings.push_str(HASH_PRELUDE);
    }
    bindings.push_str(
        r#"
fn fieldU(gi: u32, i: u32) -> vec4<f32> { return u[i]; }
fn glassSample(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(src, samp, uv); }
"#,
    );
    bindings.push_str(if two_tex {
        "fn glassSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(original, samp, uv); }\n"
    } else {
        "fn glassSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(src, samp, uv); }\n"
    });

    let fs = format!(
        r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {{
    let gi = 0u;
    let fc = fragCoord.xy;
    let uvpix = fc / fieldU(gi, 0u).xy;
{body}
    return value;
}}
"#,
        body = units_body(key)
    );
    format!("{bindings}{field}{vs}{fs}", field = field_prelude(program), vs = VERTEX_SHADER)
}

/// `TileMode::Clamp` fill. The composed scoped backdrop is the scope's content over a transparent
/// surround. `u[1]` carries the scope's content rect (`min.xy, max.xy`) in this texture's UV space.
/// For a pixel outside that rect, `clamp` snaps its UV to the rect's edge and samples there — a
/// deterministic "extend the edge outward", equivalent to a hardware `ClampToEdge` of a content-sized
/// texture but without resizing (so: no marching, no streaks). The sampled edge is composited over
/// **black** and forced opaque, so a translucent edge darkens toward black rather than revealing the
/// canvas behind the lens. Pixels already inside the content are kept unchanged.
fn clamp_fill_shader() -> String {
    format!(
        "{bindings}{vs}{fs}",
        bindings = r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 2>;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
"#,
        vs = VERTEX_SHADER,
        fs = r#"
@fragment
fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let rect = u[1];
    let uv = fc.xy / resolution;
    let here = textureSampleLevel(src, samp, uv, 0.0);
    if (here.a > 0.0039) { return here; }
    let cuv = clamp(uv, rect.xy, rect.zw);
    let edge = textureSampleLevel(src, samp, cuv, 0.0);
    if (edge.a > 0.0039) { return vec4<f32>(edge.rgb, 1.0); }
    return here;
}
"#
    )
}
