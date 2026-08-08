//! The frosted-glass gather pipeline — a faithful port of render-wasm's three SkSL passes to WGSL.
//!
//! 1. **Displacement** (`glass_displacement.sksl`): a rounded-box SDF + surface-profile bezel →
//!    Snell's-law refraction vector, specular, and an anti-aliased mask, written to an `Rgba16Float`
//!    field `(dx, dy, specular, mask)`.
//! 2. **Refraction** (`glass_refraction.sksl`): samples the (unblurred) backdrop offset by the
//!    displacement, with chromatic aberration, blended to the plain backdrop by the mask.
//! 3. **Blur** happens between 2 and 3 via the compositor's separable Gaussian (`total_blur_sigma`).
//! 4. **Composite** (`glass_composite.sksl`): frost scatter, glass tint, prismatic specular, and the
//!    final mask composite against the original backdrop.
//!
//! All passes run over the gather's device-space backdrop surface (sized to the sample rect); the
//! sink stamps the composite result into the tiles. Uniforms are packed as `array<vec4<f32>, N>` to
//! sidestep std140 scalar-alignment. Colours are premultiplied but the backdrop is opaque
//! (alpha == 1), so the SkSL `.rgb` math carries over unchanged.

use wgpu::util::DeviceExt;

/// The displacement field's texture format — signed, out-of-`[0,1]` displacement needs float.
pub const DISPLACEMENT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

pub struct GlassPipeline {
    displacement: wgpu::RenderPipeline,
    displacement_layout: wgpu::BindGroupLayout,
    refraction: wgpu::RenderPipeline,
    refraction_layout: wgpu::BindGroupLayout,
    composite: wgpu::RenderPipeline,
    composite_layout: wgpu::BindGroupLayout,
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
        let disp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass displacement"),
            source: wgpu::ShaderSource::Wgsl(DISPLACEMENT_SHADER.into()),
        });
        let refr_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass refraction"),
            source: wgpu::ShaderSource::Wgsl(REFRACTION_SHADER.into()),
        });
        let comp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass composite"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITE_SHADER.into()),
        });

        let displacement_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass displacement layout"),
            entries: &[uniform_entry(0)],
        });
        let refraction_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass refraction layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2), texture_entry(3)],
        });
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass composite layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2), texture_entry(3), texture_entry(4)],
        });

        let displacement = make_pipeline(device, "glass displacement", &disp_shader, &displacement_layout, DISPLACEMENT_FORMAT);
        let refraction = make_pipeline(device, "glass refraction", &refr_shader, &refraction_layout, format);
        let composite = make_pipeline(device, "glass composite", &comp_shader, &composite_layout, format);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glass sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            displacement,
            displacement_layout,
            refraction,
            refraction_layout,
            composite,
            composite_layout,
            sampler,
        }
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

    /// Pass 1: compute the displacement field into `target` (an [`DISPLACEMENT_FORMAT`] texture).
    /// `u` is the 20-float (`5×vec4`) uniform the sink packs.
    pub fn displacement(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, u: &[f32; 20]) {
        let uniform = Self::uniform(device, u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass disp bind"),
            layout: &self.displacement_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
        });
        Self::full_pass(encoder, target, &self.displacement, &bind);
    }

    /// Pass 2: refraction + chromatic aberration of `backdrop` by the `disp` field into `target`.
    pub fn refraction(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, backdrop: &wgpu::TextureView, disp: &wgpu::TextureView, u: &[f32; 4]) {
        let uniform = Self::uniform(device, u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass refr bind"),
            layout: &self.refraction_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(backdrop) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(disp) },
            ],
        });
        Self::full_pass(encoder, target, &self.refraction, &bind);
    }

    /// Pass 4: frost / tint / specular / mask composite of the `blurred` refracted image against the
    /// `original` backdrop, guided by the `disp` field, into `target`.
    #[expect(clippy::too_many_arguments, reason = "the pass reads three textures + a uniform")]
    pub fn composite(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, blurred: &wgpu::TextureView, original: &wgpu::TextureView, disp: &wgpu::TextureView, u: &[f32; 8]) {
        let uniform = Self::uniform(device, u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass comp bind"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blurred) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(original) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(disp) },
            ],
        });
        Self::full_pass(encoder, target, &self.composite, &bind);
    }
}

const DISPLACEMENT_SHADER: &str = concat!(
r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 5>;

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
"#,
r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#,
r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
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

    let fc = fragCoord.xy;
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
"#);

const REFRACTION_SHADER: &str = concat!(
r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 1>;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var dispTex: texture_2d<f32>;
"#,
r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#,
r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let chromaticAberration = u[0].z;
    let scale = u[0].w;

    let uvpix = fragCoord.xy / resolution;
    let dispData = textureSample(dispTex, samp, uvpix);
    let dpx = vec2<f32>(dispData.r, dispData.g);
    let mask = dispData.a;

    let dispUV = dpx / resolution;
    let dLen = length(dpx);
    let caStr = smoothstep(0.0, 5.0 * scale, dLen);
    var caDir = vec2<f32>(0.0);
    if (dLen > 0.01 * scale) { caDir = dpx / dLen; }
    let caShift = caDir * chromaticAberration * caStr / resolution;

    let refUV = uvpix + dispUV;
    // Passthrough is mask==0 → refUV==uvpix → refracted==bg, so the mix below covers it without a
    // non-uniform branch (WGSL forbids textureSample under per-pixel control flow).
    let refracted = vec3<f32>(
        textureSample(backdrop, samp, refUV - caShift).r,
        textureSample(backdrop, samp, refUV).g,
        textureSample(backdrop, samp, refUV + caShift).b
    );
    let bg = textureSample(backdrop, samp, uvpix).rgb;
    return vec4<f32>(mix(bg, refracted, mask), 1.0);
}
"#);

const COMPOSITE_SHADER: &str = concat!(
r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 2>;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var original: texture_2d<f32>;
@group(0) @binding(4) var dispTex: texture_2d<f32>;

fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn hash2(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(hash(p), hash(p + vec2<f32>(73.7, 157.3))) * 2.0 - 1.0;
}
"#,
r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#,
r#"
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let frost = u[0].z;
    let specularOpacity = u[0].w;
    let specularSaturation = u[1].x;
    let scale = u[1].y;

    let fc = fragCoord.xy;
    let uvpix = fc / resolution;
    let dispData = textureSample(dispTex, samp, uvpix);
    let specular = dispData.b;
    let mask = dispData.a;
    let bg = textureSample(original, samp, uvpix).rgb;

    var blurredColor = vec3<f32>(0.0);
    let texel = vec2<f32>(1.0) / resolution;
    // `frost` is uniform, so this branch is uniform control flow — textureSample is legal inside it.
    if (frost > 0.01) {
        var frostSum = vec3<f32>(0.0);
        var totalW = 0.0;
        for (var i = 0.0; i < 12.0; i = i + 1.0) {
            let noise = hash2(fc + vec2<f32>(i * 7.3, i * 13.1));
            let off = noise * frost * 6.0 * scale * texel;
            frostSum = frostSum + textureSample(blurred, samp, uvpix + off).rgb;
            totalW = totalW + 1.0;
        }
        // Frost only *scatters* (softens) the refracted image; the milky tint + desaturation that
        // used to follow were removed at the designer's request, so glass stays clear, not grayish.
        blurredColor = frostSum / totalW;
    } else {
        blurredColor = textureSample(blurred, samp, uvpix).rgb;
    }

    let specLuma = dot(blurredColor, vec3<f32>(0.299, 0.587, 0.114));
    var saturated = mix(vec3<f32>(specLuma), blurredColor, 1.0 + specularSaturation);
    saturated = max(saturated, vec3<f32>(0.0));
    let highlightColor = mix(vec3<f32>(1.0, 0.98, 0.95), saturated, min(specularSaturation / 9.0, 1.0));
    blurredColor = blurredColor + specular * specularOpacity * highlightColor;

    return vec4<f32>(mix(bg, blurredColor, mask), 1.0);
}
"#);
