//! The effect pass-graph executor — one place that runs any GPU effect.
//!
//! An effect is a *sequence of full-screen passes over textures*: each reads some input views
//! plus a uniform and writes one texture, later passes chaining off earlier ones. Background blur
//! and glass differ only in *which* passes and *what* uniforms — the data, not the control flow.
//! [`run_graph`] executes that data, so the sink no longer carries a bespoke method per effect.
//!
//! What is *not* here: the scene render that produces an effect's inputs (a `Scene`→texture draw
//! via the vello `Renderer`, not a texture→texture shader) and the tile *stamp* that places the
//! result (which needs tile geometry). Those stay in the sink — the graph is the middle, the
//! uniform "produce a surface" step the unify discussion identified.
//!
//! Every pass runs at the graph's working size `(w, h)`; the resolution cap sets that size and the
//! stamp upscales, so the passes themselves stay oblivious to zoom.

use std::rc::Rc;

use render_core::effect_graph::{EffectPass, GraphPass, Src};
use wgpu::util::DeviceExt;

use crate::blend::{Blit, BlurPass, Compositor};
use crate::glass::{GlassPipeline, DISPLACEMENT_FORMAT};

/// Above this device-σ a single separable pass would exceed [`Compositor::blur1d`]'s 160-tap cap
/// and truncate the Gaussian; the pyramid path kicks in instead. Chosen so the coarse blur samples
/// fully (`3·32 = 96` taps ≤ 160) with margin.
const BLUR_MAX_SIGMA: f32 = 32.0;

/// One full-screen pass, **lowered** for execution: render-core describes the effect as a neutral
/// [`GraphPass`]; [`lower_graph`] turns each into this by resolving `Custom` to its compiled wgpu
/// pipeline. The kind selects the pipeline and carries its uniform; `inputs` (render-core's [`Src`])
/// binds the texture reads in the order that pipeline expects.
pub struct Pass {
    pub kind: PassKind,
    pub inputs: Vec<Src>,
}

/// The pipeline a lowered pass dispatches to — the backend twin of render-core's [`EffectPass`],
/// differing only in that `Custom` carries the resolved wgpu pipeline rather than just its uniform.
pub enum PassKind {
    /// A full 2D Gaussian of `sigma` device pixels over its 1 input — separable H+V for a small
    /// kernel, a downsample pyramid for a large one (see [`gaussian_blur`]).
    Blur { sigma: f32 },
    /// Glass pass 1: rounded-box SDF → refraction field. 0 inputs (pure function of the uniform).
    GlassDisplacement { u: [f32; 20] },
    /// Glass pass 2: refraction + chromatic aberration. Inputs `[backdrop, displacement]`.
    GlassRefraction { u: [f32; 4] },
    /// Glass pass 4: frost / tint / specular composite. Inputs `[blurred, original, displacement]`.
    GlassComposite { u: [f32; 8] },
    /// A hand-written WGSL pass — the escape hatch. Runs the (already-compiled, cached) `pipeline`
    /// over its inputs with `u` (surface resolution + params). The pipeline's own `@group(0)` layout
    /// is honoured: binding 0 uniform, 1 sampler, 2.. the input textures in order.
    Custom { pipeline: Rc<wgpu::RenderPipeline>, u: Vec<f32> },
}

/// Lower a render-core effect graph to runnable [`Pass`]es. Every kind maps one-to-one except
/// [`EffectPass::Custom`], whose pipeline the IR does not carry: `custom` supplies the shape's
/// compiled pipeline (the caller resolved + cached it from the shader source). A `Custom` pass with
/// no pipeline provided is dropped with a warning rather than panicking mid-frame.
pub fn lower_graph(graph: &[GraphPass], custom: Option<&Rc<wgpu::RenderPipeline>>) -> Vec<Pass> {
    let mut out = Vec::with_capacity(graph.len());
    for gp in graph {
        let kind = match &gp.pass {
            EffectPass::Blur { sigma } => PassKind::Blur { sigma: *sigma },
            EffectPass::GlassDisplacement { u } => PassKind::GlassDisplacement { u: *u },
            EffectPass::GlassRefraction { u } => PassKind::GlassRefraction { u: *u },
            EffectPass::GlassComposite { u } => PassKind::GlassComposite { u: *u },
            EffectPass::Custom { u } => match custom {
                Some(pipeline) => PassKind::Custom { pipeline: pipeline.clone(), u: u.clone() },
                None => {
                    log::warn!("custom effect pass with no pipeline resolved; skipping");
                    continue;
                }
            },
        };
        out.push(Pass { kind, inputs: gp.inputs.clone() });
    }
    out
}

impl PassKind {
    /// The output format — glass's displacement field is signed float, everything else matches the
    /// swapchain.
    fn output_format(&self, swapchain: wgpu::TextureFormat) -> wgpu::TextureFormat {
        match self {
            PassKind::GlassDisplacement { .. } => DISPLACEMENT_FORMAT,
            _ => swapchain,
        }
    }
}

/// Run an effect's pass-graph and return the final pass's `(texture, view)`, or `None` for an empty
/// graph. All passes share one encoder and one submit; the caller wraps the result in its surface
/// map and stamps it into the destination tiles.
#[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
pub fn run_graph(
    compositor: &Compositor,
    glass: &GlassPipeline,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    inputs: &[&wgpu::TextureView],
    passes: &[Pass],
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
) -> Option<(wgpu::Texture, wgpu::TextureView)> {
    let sampler = compositor.sampler();
    let mut outputs: Vec<(wgpu::Texture, wgpu::TextureView)> = Vec::with_capacity(passes.len());
    // Scratch textures/views a pass allocates internally (blur pyramid levels) must outlive the
    // encoder — they're referenced by recorded commands until the submit below.
    let mut keep: Vec<wgpu::Texture> = Vec::new();
    let mut keep_views: Vec<wgpu::TextureView> = Vec::new();
    let mut enc =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("effect graph") });

    for pass in passes {
        // Resolve (cloned, so allocating the new output below can't collide with these borrows).
        let bound: Vec<wgpu::TextureView> = pass
            .inputs
            .iter()
            .map(|s| match *s {
                Src::Input(i) => inputs[i].clone(),
                Src::Pass(i) => outputs[i].1.clone(),
            })
            .collect();

        let tex = new_target(device, w, h, pass.kind.output_format(format));
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

        match &pass.kind {
            PassKind::Blur { sigma } => {
                gaussian_blur(compositor, device, &mut enc, &view, &bound[0], w, h, *sigma, format, &mut keep, &mut keep_views);
            }
            PassKind::GlassDisplacement { u } => {
                glass.displacement(device, &mut enc, &view, u);
            }
            PassKind::GlassRefraction { u } => {
                glass.refraction(device, &mut enc, &view, &bound[0], &bound[1], u);
            }
            PassKind::GlassComposite { u } => {
                glass.composite(device, &mut enc, &view, &bound[0], &bound[1], &bound[2], u);
            }
            PassKind::Custom { pipeline, u } => {
                custom_pass(device, &mut enc, &view, pipeline, sampler, &bound, u);
            }
        }
        outputs.push((tex, view));
    }

    queue.submit([enc.finish()]);
    outputs.pop()
}

/// A full 2D Gaussian blur of `sigma` device pixels, `src`→`dst` (both `w×h`).
///
/// - Small `sigma` → the plain separable path (horizontal then vertical [`Compositor::blur1d`]),
///   byte-identical to the pre-pyramid two-pass blur.
/// - Large `sigma` → **power-lowering**: a single separable pass can't sample past `blur1d`'s
///   160-tap cap, so it would truncate the Gaussian (visible once the resolution cap drives
///   `sigma` toward `TILE/3 ≈ 85`). Instead halve the surface — a ×2 bilinear downsample is a 2×2
///   box, near-lossless for a low-pass target — until `sigma/level ≤ BLUR_MAX_SIGMA`, blur there
///   with the reduced sigma, then bilinear-upsample. Same visual blur, bounded and correct taps.
///
/// `keep`/`keep_views` retain the intermediate surfaces until the caller submits the encoder.
#[expect(clippy::too_many_arguments, reason = "the GPU context + keepalive travel together")]
fn gaussian_blur(
    compositor: &Compositor,
    device: &wgpu::Device,
    enc: &mut wgpu::CommandEncoder,
    dst: &wgpu::TextureView,
    src: &wgpu::TextureView,
    w: u32,
    h: u32,
    sigma: f32,
    format: wgpu::TextureFormat,
    keep: &mut Vec<wgpu::Texture>,
    keep_views: &mut Vec<wgpu::TextureView>,
) {
    let vd = wgpu::TextureViewDescriptor::default();

    if sigma <= BLUR_MAX_SIGMA {
        let scratch = new_target(device, w, h, format);
        let sv = scratch.create_view(&vd);
        compositor.blur1d(device, enc, &sv, &BlurPass { src, size: (w as f32, h as f32), dir: (1.0, 0.0), sigma });
        compositor.blur1d(device, enc, dst, &BlurPass { src: &sv, size: (w as f32, h as f32), dir: (0.0, 1.0), sigma });
        keep.push(scratch);
        keep_views.push(sv);
        return;
    }

    let mut level = 1.0_f32;
    while sigma / level > BLUR_MAX_SIGMA {
        level *= 2.0;
    }
    let target_w = ((w as f32 / level).round() as u32).max(1);
    let target_h = ((h as f32 / level).round() as u32).max(1);

    // Downsample by repeated halving (each ×2 bilinear = a 2×2 box, no aliasing).
    let mut cur = src.clone();
    let (mut cw, mut ch) = (w, h);
    while cw > target_w || ch > target_h {
        let nw = cw.div_ceil(2).max(target_w);
        let nh = ch.div_ceil(2).max(target_h);
        let t = new_target(device, nw, nh, format);
        let tv = t.create_view(&vd);
        Compositor::clear(enc, &tv, [0.0, 0.0, 0.0, 0.0]);
        compositor.blit(device, enc, &tv, (nw as f32, nh as f32), &Blit {
            src: &cur,
            dst: (0.0, 0.0, nw as f32, nh as f32),
            src_rect: (0.0, 0.0, cw as f32, ch as f32),
            src_size: (cw as f32, ch as f32),
            alpha: 1.0,
        });
        cur = tv.clone();
        keep.push(t);
        keep_views.push(tv);
        cw = nw;
        ch = nh;
    }

    // Blur at the coarse level with the reduced sigma.
    let coarse_sigma = sigma / level;
    let coarse_size = (cw as f32, ch as f32);
    let scratch = new_target(device, cw, ch, format);
    let scv = scratch.create_view(&vd);
    let blurred = new_target(device, cw, ch, format);
    let bv = blurred.create_view(&vd);
    compositor.blur1d(device, enc, &scv, &BlurPass { src: &cur, size: coarse_size, dir: (1.0, 0.0), sigma: coarse_sigma });
    compositor.blur1d(device, enc, &bv, &BlurPass { src: &scv, size: coarse_size, dir: (0.0, 1.0), sigma: coarse_sigma });

    // Upsample the coarse blurred result to the full-size dst (bilinear). dst is fresh → clear first
    // so the SrcOver blit lands exactly (transparent dst → out == src).
    Compositor::clear(enc, dst, [0.0, 0.0, 0.0, 0.0]);
    compositor.blit(device, enc, dst, (w as f32, h as f32), &Blit {
        src: &bv,
        dst: (0.0, 0.0, w as f32, h as f32),
        src_rect: (0.0, 0.0, cw as f32, ch as f32),
        src_size: coarse_size,
        alpha: 1.0,
    });
    keep.push(scratch);
    keep_views.push(scv);
    keep.push(blurred);
    keep_views.push(bv);
}

/// Compile a custom WGSL module into a render pipeline over one fullscreen quad.
///
/// The bind-group layout is declared **explicitly** — binding 0 uniform, 1 sampler, and `n_inputs`
/// textures at 2.. — rather than inferred from the shader (`layout: None`). Inference drops any slot
/// the shader doesn't statically reference: a valid shader that never reads the resolution uniform
/// would get a layout without binding 0, and [`custom_pass`] (which always binds 0/1/2) would then
/// fail bind-group creation with "binding 0 not present" and render blank. Declaring the layout
/// pins all the slots the code binds, so an unused uniform is harmless. The sink caches the result
/// by (source hash, n_inputs), so this runs once per distinct (shader, input-count) pair.
pub fn build_custom_pipeline(
    device: &wgpu::Device,
    wgsl: &str,
    n_inputs: usize,
    format: wgpu::TextureFormat,
) -> Rc<wgpu::RenderPipeline> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("custom effect"),
        source: wgpu::ShaderSource::Wgsl(wgsl.into()),
    });
    let mut entries = vec![
        // binding 0: resolution + params uniform (may be unused by the shader).
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
        // binding 1: the shared effect sampler.
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
    ];
    // bindings 2..: the sampled input textures (backdrop and/or body).
    for i in 0..n_inputs {
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 2 + i as u32,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
    }
    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("custom effect bind layout"),
        entries: &entries,
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("custom effect pipeline layout"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("custom effect pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None, // overwrites its full target
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    Rc::new(pipeline)
}

/// Run a compiled custom pipeline over `inputs` (bound at 2..) with `u` (padded to `vec4` and bound
/// at 0), sharing the effect `sampler` at 1, into `target`.
fn custom_pass(
    device: &wgpu::Device,
    enc: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    sampler: &wgpu::Sampler,
    inputs: &[wgpu::TextureView],
    u: &[f32],
) {
    let mut padded = u.to_vec();
    while padded.len() % 4 != 0 {
        padded.push(0.0);
    }
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("custom uniform"),
        contents: bytemuck::cast_slice(&padded),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let layout = pipeline.get_bind_group_layout(0);
    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
    ];
    for (i, v) in inputs.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry { binding: 2 + i as u32, resource: wgpu::BindingResource::TextureView(v) });
    }
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("custom bind"), layout: &layout, entries: &entries });
    let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("custom pass"),
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
    pass.set_bind_group(0, &bind, &[]);
    pass.draw(0..4, 0..1);
}

/// A fresh render-attachment + sampled texture — an effect pass's output (or scratch) surface.
pub fn new_target(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("effect target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}
