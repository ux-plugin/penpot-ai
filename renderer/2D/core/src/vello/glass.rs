//! The frosted-glass gather pipeline — a faithful port of render-wasm's SkSL passes to WGSL.
//!
//! **Fused** to two passes (the displacement pass is gone): the rounded-box SDF + surface-profile
//! bezel → refraction field `(dx, dy, specular, mask)` is *pure arithmetic on the uniform*, so instead
//! of materialising it to an `Rgba16Float` texture and reading it back twice, both passes recompute it
//! inline via the shared [`FIELD_PRELUDE`]'s `computeField`. See the fusion rule: a pure-uniform pass
//! is inlined (register-fused), never stored.
//!
//! 1. **Refraction** (`REFRACTION_SHADER`): computes the field, samples the (unblurred) backdrop offset
//!    by the displacement with chromatic aberration, blended to the plain backdrop by the mask.
//! 2. **Blur** happens between 1 and 2 via the compositor's separable Gaussian (`total_blur_sigma`).
//! 3. **Composite** (`COMPOSITE_SHADER`): recomputes the field for its specular + mask, then frost
//!    scatter, prismatic specular, and the final mask composite against the original backdrop.
//!
//! Both passes share one 20-float (`5×vec4`) uniform: indices 0..16 are the field geometry (identical
//! to the old displacement uniform), and the three spare slots [17][18][19] carry each pass's own
//! params — refraction packs `chromaticAberration`, composite packs `frost/specularOpacity/
//! specularSaturation`. Uniforms are packed as `array<vec4<f32>, N>` to sidestep std140 scalar
//! alignment. Colours are premultiplied but the backdrop is opaque (alpha == 1), so the `.rgb` math
//! carries over unchanged.

use wgpu::util::DeviceExt;

pub struct GlassPipeline {
    refraction: wgpu::RenderPipeline,
    refraction_layout: wgpu::BindGroupLayout,
    composite: wgpu::RenderPipeline,
    composite_layout: wgpu::BindGroupLayout,
    /// The **fused** sharp-glass pipeline: refraction and composite in one draw over the backdrop, no
    /// intermediate texture. Selected by the footprint partition only when frost ≤ 0.01 (no scatter,
    /// no blur), where the composite reads the refraction at its own pixel — see [`Self::fused`].
    fused: wgpu::RenderPipeline,
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
                blend: None, // each pass overwrites its own full target
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
        let refr_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass refraction (fused)"),
            source: wgpu::ShaderSource::Wgsl(refraction_shader().into()),
        });
        let comp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass composite (fused)"),
            source: wgpu::ShaderSource::Wgsl(composite_shader().into()),
        });
        let fused_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass refraction+composite (single-draw)"),
            source: wgpu::ShaderSource::Wgsl(fused_shader().into()),
        });

        // Refraction reads only the backdrop now — the displacement field is recomputed inline.
        let refraction_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass refraction layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        // Composite reads the blurred refraction + the original backdrop; the field is inline.
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass composite layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2), texture_entry(3)],
        });

        let refraction = make_pipeline(device, "glass refraction", &refr_shader, &refraction_layout, format);
        let composite = make_pipeline(device, "glass composite", &comp_shader, &composite_layout, format);
        // The fused pass reads only the backdrop, so it reuses the refraction layout (uniform/tex/sampler).
        let fused = make_pipeline(device, "glass fused", &fused_shader, &refraction_layout, format);
        // Clamp-fill also reads one texture with the same (uniform/tex/sampler) layout.
        let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass clamp-fill"),
            source: wgpu::ShaderSource::Wgsl(clamp_fill_shader().into()),
        });
        let clamp_fill = make_pipeline(device, "glass clamp fill", &clamp_shader, &refraction_layout, format);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glass sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            refraction,
            refraction_layout,
            composite,
            composite_layout,
            fused,
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
            layout: &self.refraction_layout,
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

    /// Refraction + chromatic aberration of `backdrop` into `target`. The displacement field is
    /// recomputed inline from `u` (the 20-float `5×vec4` uniform: field geometry in 0..16, with the
    /// chromatic-aberration strength packed at index 17).
    pub fn refraction(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, backdrop: &wgpu::TextureView, u: &[f32; 20]) {
        let uniform = Self::uniform(device, u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass refr bind"),
            layout: &self.refraction_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(backdrop) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        Self::full_pass(encoder, target, &self.refraction, &bind);
    }

    /// Frost / specular / mask composite of the `blurred` refracted image against the `original`
    /// backdrop into `target`. The displacement field (for specular + mask) is recomputed inline from
    /// `u` (field geometry in 0..16, with `frost/specularOpacity/specularSaturation` packed at 17/18/19).
    pub fn composite(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, blurred: &wgpu::TextureView, original: &wgpu::TextureView, u: &[f32; 20]) {
        let uniform = Self::uniform(device, u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass comp bind"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blurred) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(original) },
            ],
        });
        Self::full_pass(encoder, target, &self.composite, &bind);
    }

    /// **Fused** refraction + composite in a single draw over `backdrop` into `target` — no
    /// intermediate texture. Valid only for sharp glass (frost ≤ 0.01, no blur), where the composite
    /// reads the refraction at its own pixel, so the two same-pixel passes collapse into one shader.
    ///
    /// `refr_u` and `comp_u` are the two passes' 20-float uniforms; they share the field geometry
    /// (0..16) and differ only in the trailing params. The combined uniform keeps refraction's
    /// chromatic aberration at 17 and grafts composite's specular opacity/saturation into 18/19 (frost
    /// at 17 is unused here — the fused shader hardwires the no-scatter path). The result is *more*
    /// accurate than the two-pass path, which quantises the refraction to 8-bit before the composite
    /// reads it; here it stays float, so the diff is within 8-bit rounding, never worse.
    pub fn fused(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, backdrop: &wgpu::TextureView, refr_u: &[f32; 20], comp_u: &[f32; 20]) {
        let mut u = *refr_u;
        u[18] = comp_u[18];
        u[19] = comp_u[19];
        let uniform = Self::uniform(device, &u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass fused bind"),
            layout: &self.refraction_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(backdrop) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        Self::full_pass(encoder, target, &self.fused, &bind);
    }
}

/// Shared field computation: the rounded-box SDF + surface-profile bezel → Snell refraction vector,
/// specular, and anti-aliased mask, as pure arithmetic on the 20-float uniform (indices 0..16). Both
/// fused passes concatenate this after their `@binding(0) var<uniform> u` and call `computeField`.
const FIELD_PRELUDE: &str = r#"
fn roundedRectSDF(p: vec2<f32>, halfSize: vec2<f32>, r: f32) -> f32 {
    let d = abs(p) - halfSize + vec2<f32>(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0))) - r;
}
fn surfaceHeight(x: f32, st: i32) -> f32 {
    let t = 1.0 - x;
    if (st == 0) { return sqrt(max(0.0, 1.0 - t * t)); }
    let t4 = t * t * t * t;
    if (st == 1) { return pow(max(0.0, 1.0 - t4), 0.25); }
    if (st == 2) { return 1.0 - pow(max(0.0, 1.0 - t4), 0.25); }
    let c = pow(max(0.0, 1.0 - t4), 0.25);
    let sx = clamp(x, 0.0, 1.0);
    let ss = sx * sx * sx * (sx * (sx * 6.0 - 15.0) + 10.0);
    return mix(c, 1.0 - c, ss);
}
fn surfaceDerivative(x: f32, st: i32) -> f32 {
    let delta = 0.001;
    return (surfaceHeight(min(1.0, x + delta), st) - surfaceHeight(max(0.0, x - delta), st)) / (2.0 * delta);
}
fn snellRefract(theta1: f32, n1: f32, n2: f32) -> f32 {
    let s = (n1 / n2) * sin(theta1);
    if (abs(s) > 1.0) { return -1.0; }
    return asin(s);
}
fn calculateDisplacement(d: f32, thick: f32, n2: f32, st: i32) -> f32 {
    if (d <= 0.0 || d >= 1.0) { return 0.0; }
    let h = surfaceHeight(d, st) * thick;
    let dh = surfaceDerivative(d, st) * thick;
    let sA = atan(dh);
    let tI = abs(sA);
    let tR = snellRefract(tI, 1.0, n2);
    if (tR < 0.0) { return 0.0; }
    return (h * tan(tR) - h * tan(tI)) * sign(dh);
}
fn calculateSpecular(d: f32, bezel: f32, lightAngle: f32, dir: vec2<f32>, scale: f32) -> f32 {
    if (d <= 0.0 || d >= 1.0) { return 0.0; }
    let px = d * bezel;
    let band = exp(-0.5 * pow((px - 2.0 * scale) / max(scale, 1e-4), 2.0));
    let ld = vec2<f32>(cos(lightAngle), sin(lightAngle));
    var f = abs(dot(dir, ld));
    f = pow(f, 2.0);
    return band * f;
}
// The refraction field at device pixel `fc`: (dpx.x, dpx.y, specular, mask). Reads the field geometry
// from the shared uniform `u` indices 0..16 (identical layout to the old displacement uniform).
fn computeField(fc: vec2<f32>) -> vec4<f32> {
    let glassCenter = u[0].zw;
    let glassSize = u[1].xy;
    let cornerRadius = u[1].z;
    let surfaceType = i32(u[1].w);
    let bezelWidth = u[2].x;
    let glassThickness = u[2].y;
    let refractiveIndex = u[2].z;
    let specularAngle = u[2].w;
    let splay = u[3].x;
    let tiltAngle = u[3].y;
    let edgeBoost = u[3].z;
    let zoom = u[3].w;
    let scale = u[4].x;

    let cR = min(cornerRadius, min(glassSize.x, glassSize.y));
    let localPos = fc - glassCenter;
    let dist = roundedRectSDF(localPos, glassSize, cR);
    if (dist > 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

    let bezel = min(bezelWidth, min(glassSize.x, glassSize.y));
    let distFromBorder = clamp(-dist / bezel, 0.0, 1.0);

    let radialDir = normalize(localPos / max(vec2<f32>(1.0), glassSize));
    let flatDir = vec2<f32>(cos(tiltAngle), sin(tiltAngle));
    let blendedDir = mix(flatDir, radialDir, splay);
    let bLen = length(blendedDir);
    var dir = vec2<f32>(0.0);
    if (bLen > 0.001) { dir = blendedDir / bLen; }

    var disp = calculateDisplacement(distFromBorder, glassThickness, refractiveIndex, surfaceType) * scale;
    let edgeFade = pow(1.0 - distFromBorder, 1.5);
    disp = disp * (1.0 + edgeBoost * edgeFade);
    var dpx = dir * disp;

    let zoomFactor = 1.0 / max(zoom, 0.1) - 1.0;
    dpx = dpx + localPos * zoomFactor;

    let specular = calculateSpecular(distFromBorder, bezel, specularAngle, dir, scale);
    let mask = smoothstep(0.0, 1.5 * scale, -dist);
    return vec4<f32>(dpx.x, dpx.y, specular, mask);
}
"#;

const VERTEX_SHADER: &str = r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#;

fn refraction_shader() -> String {
    format!(
        "{bindings}{field}{vs}{fs}",
        bindings = r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 5>;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
"#,
        field = FIELD_PRELUDE,
        vs = VERTEX_SHADER,
        fs = r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let scale = u[4].x;
    let chromaticAberration = u[4].y;

    let field = computeField(fragCoord.xy);
    let dpx = field.xy;
    let mask = field.a;

    let uvpix = fragCoord.xy / resolution;
    let dispUV = dpx / resolution;
    let dLen = length(dpx);
    let caStr = smoothstep(0.0, 5.0 * scale, dLen);
    var caDir = vec2<f32>(0.0);
    if (dLen > 0.01 * scale) { caDir = dpx / dLen; }
    let caShift = caDir * chromaticAberration * caStr / resolution;

    let refUV = uvpix + dispUV;
    // Passthrough is mask==0 → refUV==uvpix → refracted==bg, so the mix below covers it without a
    // non-uniform branch (WGSL forbids textureSample under per-pixel control flow).
    // Carry the backdrop's premultiplied alpha through (the 4th channel): a *scoped* backdrop is
    // transparent outside its scope's content, and a lens over that emptiness must stay transparent so
    // the canvas shows through — not composite as opaque black. Over an opaque backdrop (a full-page
    // effect) alpha is 1 everywhere, so this is identical to the former hardcoded `1.0`.
    let refracted = vec4<f32>(
        textureSample(backdrop, samp, refUV - caShift).r,
        textureSample(backdrop, samp, refUV).g,
        textureSample(backdrop, samp, refUV + caShift).b,
        textureSample(backdrop, samp, refUV).a
    );
    let bg = textureSample(backdrop, samp, uvpix);
    return mix(bg, refracted, mask);
}
"#
    )
}

/// The sharp-glass fusion: refraction then composite in one fragment shader, sampling only the
/// backdrop (no intermediate texture). Faithful to `refraction_shader` → `composite_shader` chained
/// with frost off — the refraction result feeds the composite in registers instead of a texture
/// round-trip. Reads one combined uniform: field geometry 0..16, chromatic aberration at 17, specular
/// opacity at 18, specular saturation at 19 (frost is absent by construction — this pipeline is only
/// selected when frost ≤ 0.01).
fn fused_shader() -> String {
    format!(
        "{bindings}{field}{vs}{fs}",
        bindings = r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 5>;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
"#,
        field = FIELD_PRELUDE,
        vs = VERTEX_SHADER,
        fs = r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let scale = u[4].x;
    let chromaticAberration = u[4].y;
    let specularOpacity = u[4].z;
    let specularSaturation = u[4].w;

    let fc = fragCoord.xy;
    let field = computeField(fc);
    let dpx = field.xy;
    let specular = field.b;
    let mask = field.a;

    let uvpix = fc / resolution;
    // Refraction (inline): the plain backdrop, and the chromatic-split displaced sample, mixed by mask.
    let dispUV = dpx / resolution;
    let dLen = length(dpx);
    let caStr = smoothstep(0.0, 5.0 * scale, dLen);
    var caDir = vec2<f32>(0.0);
    if (dLen > 0.01 * scale) { caDir = dpx / dLen; }
    let caShift = caDir * chromaticAberration * caStr / resolution;
    let refUV = uvpix + dispUV;
    // Carry the backdrop's premultiplied alpha (see refraction_shader) so a transparent scoped backdrop
    // stays transparent instead of compositing as opaque black; over an opaque backdrop alpha is 1 and
    // this matches the former hardcoded `1.0`.
    let refracted = vec4<f32>(
        textureSample(backdrop, samp, refUV - caShift).r,
        textureSample(backdrop, samp, refUV).g,
        textureSample(backdrop, samp, refUV + caShift).b,
        textureSample(backdrop, samp, refUV).a
    );
    let bg = textureSample(backdrop, samp, uvpix);
    // This is exactly what the refraction pass wrote (and the composite would sample at its own pixel).
    var blurred4 = mix(bg, refracted, mask);
    var blurredColor = blurred4.rgb;

    // Composite (inline, frost off): prismatic specular highlight, then the final mask composite.
    let specLuma = dot(blurredColor, vec3<f32>(0.299, 0.587, 0.114));
    var saturated = mix(vec3<f32>(specLuma), blurredColor, 1.0 + specularSaturation);
    saturated = max(saturated, vec3<f32>(0.0));
    let highlightColor = mix(vec3<f32>(1.0, 0.98, 0.95), saturated, min(specularSaturation / 9.0, 1.0));
    // Gate the specular shine by the backdrop's presence (`blurred4.a`) so a scoped lens is fully NIL
    // where its scope has no content — no phantom bezel/shine floats past the scope's border. Over an
    // opaque backdrop alpha is 1, so in-scope glass is unchanged.
    blurredColor = blurredColor + specular * specularOpacity * highlightColor * blurred4.a;

    let outRgb = mix(bg.rgb, blurredColor, mask);
    let outA = mix(bg.a, blurred4.a, mask);
    return vec4<f32>(outRgb, outA);
}
"#
    )
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
    let rect = u[1]; // scope content rect (minU, minV, maxU, maxV) in this texture's UV space
    let uv = fc.xy / resolution;
    let here = textureSampleLevel(src, samp, uv, 0.0);
    // Already content (any non-trivial premultiplied alpha) → keep it.
    if (here.a > 0.0039) { return here; }
    // Outside the content: clamp to the content rect's edge and sample there.
    let cuv = clamp(uv, rect.xy, rect.zw);
    let edge = textureSampleLevel(src, samp, cuv, 0.0);
    // Composite the (premultiplied) edge over black and force opaque — a translucent edge darkens
    // toward black instead of showing the canvas. No content at the edge → stay transparent.
    if (edge.a > 0.0039) { return vec4<f32>(edge.rgb, 1.0); }
    return here;
}
"#
    )
}

fn composite_shader() -> String {
    format!(
        "{bindings}{field}{vs}{fs}",
        bindings = r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 5>;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var original: texture_2d<f32>;

fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn hash2(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(hash(p), hash(p + vec2<f32>(73.7, 157.3))) * 2.0 - 1.0;
}
"#,
        field = FIELD_PRELUDE,
        vs = VERTEX_SHADER,
        fs = r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let scale = u[4].x;
    let frost = u[4].y;
    let specularOpacity = u[4].z;
    let specularSaturation = u[4].w;

    let fc = fragCoord.xy;
    let uvpix = fc / resolution;
    let field = computeField(fc);
    let specular = field.b;
    let mask = field.a;
    let bg = textureSample(original, samp, uvpix);

    var blurred4 = vec4<f32>(0.0);
    let texel = vec2<f32>(1.0) / resolution;
    // `frost` is uniform, so this branch is uniform control flow — textureSample is legal inside it.
    if (frost > 0.01) {
        var frostSum = vec4<f32>(0.0);
        var totalW = 0.0;
        for (var i = 0.0; i < 12.0; i = i + 1.0) {
            let noise = hash2(fc + vec2<f32>(i * 7.3, i * 13.1));
            let off = noise * frost * 6.0 * scale * texel;
            frostSum = frostSum + textureSample(blurred, samp, uvpix + off);
            totalW = totalW + 1.0;
        }
        // Frost only *scatters* (softens) the refracted image; the milky tint + desaturation that
        // used to follow were removed at the designer's request, so glass stays clear, not grayish.
        blurred4 = frostSum / totalW;
    } else {
        blurred4 = textureSample(blurred, samp, uvpix);
    }
    var blurredColor = blurred4.rgb;

    let specLuma = dot(blurredColor, vec3<f32>(0.299, 0.587, 0.114));
    var saturated = mix(vec3<f32>(specLuma), blurredColor, 1.0 + specularSaturation);
    saturated = max(saturated, vec3<f32>(0.0));
    let highlightColor = mix(vec3<f32>(1.0, 0.98, 0.95), saturated, min(specularSaturation / 9.0, 1.0));
    // Gate the specular shine by the backdrop's presence (`blurred4.a`) so a scoped lens is fully NIL
    // where its scope has no content — no phantom bezel/shine floats past the scope's border. Over an
    // opaque backdrop alpha is 1, so in-scope glass is unchanged.
    blurredColor = blurredColor + specular * specularOpacity * highlightColor * blurred4.a;

    // Preserve the premultiplied backdrop alpha so an empty (transparent) scoped backdrop stays
    // transparent instead of compositing as opaque black. Over an opaque backdrop alpha is 1 and this
    // matches the former hardcoded `1.0`.
    let outRgb = mix(bg.rgb, blurredColor, mask);
    let outA = mix(bg.a, blurred4.a, mask);
    return vec4<f32>(outRgb, outA);
}
"#
    )
}
