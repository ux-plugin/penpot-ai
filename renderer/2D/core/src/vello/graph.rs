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

use crate::effect_graph::{EffectPass, GraphPass, Src};
use wgpu::util::DeviceExt;

use crate::vello::blend::{Blit, BlurPass, Compositor};
use crate::vello::glass::{GlassPipeline, UnitOp};

/// Above this device-σ a single separable pass would exceed [`Compositor::blur1d`]'s 160-tap cap
/// and truncate the Gaussian; the pyramid path kicks in instead. Chosen so the coarse blur samples
/// fully (`3·32 = 96` taps ≤ 160) with margin.
/// The largest device sigma one separable `blur1d` pair renders faithfully (the 160-tap cap at
/// `3σ`); past it [`gaussian_blur`] power-lowers through a downsample pyramid. Shared with the
/// batched planner, whose instanced blur has no pyramid and must reject what it cannot express.
pub(crate) const BLUR_MAX_SIGMA: f32 = 32.0;

/// One full-screen pass, **lowered** for execution: render-core describes the effect as a neutral
/// [`GraphPass`]; [`lower_graph`] turns each into this by resolving `Custom` to its compiled wgpu
/// pipeline. The kind selects the pipeline and carries its uniform; `inputs` (render-core's [`Src`])
/// binds the texture reads in the order that pipeline expects.
pub struct Pass {
    pub kind: PassKind,
    pub inputs: Vec<Src>,
    /// Render-scale fraction of the graph's surface this pass's target is allocated at (`1.0` =
    /// surface size); carried from [`crate::effect_graph::GraphPass::scale`]. Readers sample
    /// normalized, so a reduced pass upscales transparently at its consumer.
    pub scale: f32,
}

/// The pipeline a lowered pass dispatches to — the backend twin of render-core's [`EffectPass`],
/// differing only in that `Custom` carries the resolved wgpu pipeline rather than just its uniform.
pub enum PassKind {
    /// A full 2D Gaussian of `sigma` device pixels over its 1 input — separable H+V for a small
    /// kernel, a downsample pyramid for a large one (see [`gaussian_blur`]). `linear` blurs in linear
    /// light (sRGB-decode taps, re-encode the result).
    Blur { sigma: f32, linear: bool },
    /// One **composed unit run** — an execution group's units (a sampling head plus its pointwise
    /// tail) fused into a single draw by [`GlassPipeline::units`]. Inputs `[src]`, or
    /// `[src, original]` when a mask-mix reads a backdrop distinct from the head's source. Sharp
    /// glass is `[Warp, Shade, MaskMix]` in one pass; the frosted composite is
    /// `[Scatter, Shade, MaskMix]`; a same-pixel scatter is the identity and lowers to nothing.
    Units(Vec<UnitOp>),
    /// A hand-written WGSL pass — the escape hatch. Runs the (already-compiled, cached) `pipeline`
    /// over its inputs with `u` (surface resolution + params), sized to exactly `param_vec4s` vec4s
    /// (the shader's declared `array<vec4<f32>, N>`). The pipeline's own `@group(0)` layout is
    /// honoured: binding 0 uniform, 1 sampler, 2.. the input textures in order.
    Custom { pipeline: Rc<wgpu::RenderPipeline>, u: Vec<f32>, param_vec4s: u32 },
}

/// Lower a render-core effect graph to runnable [`Pass`]es, one per **execution group**
/// ([`crate::footprint::execution_groups`]): a fused run of unit passes (a sampling head plus its
/// pointwise tail) becomes ONE [`PassKind::Units`] draw; a blur or custom barrier stands alone. The
/// grouping is the same rule the scale assigner used, so every group's members already share the
/// group's render scale. [`EffectPass::Custom`]'s pipeline the IR does not carry: `custom` supplies
/// the shape's compiled pipeline (the caller resolved + cached it from the shader source); a
/// `Custom` pass with no pipeline provided is dropped with a warning rather than panicking mid-frame.
pub fn lower_graph(graph: &[GraphPass], custom: Option<&Rc<wgpu::RenderPipeline>>) -> Vec<Pass> {
    let mut out = Vec::with_capacity(graph.len());
    for group in crate::footprint::execution_groups(graph) {
        let Some(&head) = group.first() else { continue };
        match &graph[head].pass {
            EffectPass::Blur { sigma, linear } => {
                out.push(Pass {
                    kind: PassKind::Blur { sigma: *sigma, linear: *linear },
                    inputs: graph[head].inputs.clone(),
                    scale: graph[head].scale,
                });
            }
            EffectPass::Custom { u, param_vec4s } => match custom {
                Some(pipeline) => out.push(Pass {
                    kind: PassKind::Custom {
                        pipeline: pipeline.clone(),
                        u: u.clone(),
                        param_vec4s: *param_vec4s,
                    },
                    inputs: graph[head].inputs.clone(),
                    scale: graph[head].scale,
                }),
                None => log::warn!("custom effect pass with no pipeline resolved; skipping"),
            },
            _ => {
                let head_src = graph[head].inputs.first().copied();
                let mut inputs: Vec<Src> = head_src.into_iter().collect();
                let mut ops = Vec::with_capacity(group.len());
                for &i in &group {
                    match &graph[i].pass {
                        EffectPass::Warp { u } => ops.push(UnitOp::Warp(*u)),
                        // A same-pixel scatter (frost ≤ 0.01) is the identity: the run's head
                        // sample already reads its input, so it lowers to nothing.
                        EffectPass::Scatter { u } => {
                            if u[17] > 0.01 {
                                ops.push(UnitOp::Scatter(*u));
                            }
                        }
                        EffectPass::Shade { u } => ops.push(UnitOp::Shade(*u)),
                        EffectPass::MaskMix { u } => {
                            ops.push(UnitOp::MaskMix(*u));
                            if let Some(orig) = graph[i].inputs.get(1) {
                                if Some(*orig) != head_src {
                                    inputs.push(*orig);
                                }
                            }
                        }
                        EffectPass::Blur { .. } | EffectPass::Custom { .. } => {
                            debug_assert!(false, "blur/custom can never share an execution group");
                        }
                    }
                }
                out.push(Pass {
                    kind: PassKind::Units(ops),
                    inputs,
                    scale: graph[*group.last().unwrap_or(&head)].scale,
                });
            }
        }
    }
    out
}

/// DBG buckets the [`crate::vello::gputime::PassProfiler`] accumulates each whole-viewport region into, by
/// role (summed across every gather in the frame). The host reads `prof_read(100 + b) / frames`.
pub mod prof_bucket {
    pub const CROP: usize = 16;
    pub const DISPLACEMENT: usize = 17;
    pub const REFRACTION: usize = 18;
    pub const BLUR: usize = 19;
    pub const COMPOSITE: usize = 20;
    pub const STAMP: usize = 21;
    pub const SWAP_BLIT: usize = 22;
    pub const OTHER: usize = 23;
}

impl PassKind {
    /// The profiler bucket for this pass's own interval (the delta ending just after it runs).
    fn prof_bucket(&self) -> usize {
        match self {
            PassKind::Blur { .. } => prof_bucket::BLUR,
            PassKind::Units(ops) => {
                if ops.iter().any(|o| matches!(o, UnitOp::Warp(_))) {
                    prof_bucket::REFRACTION
                } else {
                    prof_bucket::COMPOSITE
                }
            }
            PassKind::Custom { .. } => prof_bucket::COMPOSITE,
        }
    }

    /// The output format — every fused pass now writes the swapchain format (the old signed-float
    /// displacement field is gone; its math is recomputed inline in the refraction/composite passes).
    fn output_format(&self, swapchain: wgpu::TextureFormat) -> wgpu::TextureFormat {
        swapchain
    }
}

/// Run an effect's pass-graph and return the final pass's `(texture, view)`, or `None` for an empty
/// graph. All passes share one encoder and one submit; the caller wraps the result in its surface
/// map and stamps it into the destination tiles.
#[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
/// Record the effect graph into the caller's `enc` — no internal encoder, no submit — so a whole
/// frame of gathers can share ONE `queue.submit`. Every scratch and intermediate texture/view is
/// parked in `keep_tex`/`keep_views`; the caller MUST keep those alive until it submits `enc`, since
/// with no submit here the recorded passes still reference them. The final pass output `(tex, view)`
/// is returned for the caller to consume (and likewise keep alive until its submit).
///
/// The read-after-write against an input that an earlier command in `enc` wrote (a gather reading the
/// backdrop the prior phase's fine just produced) is ordered for free: wgpu inserts the barrier
/// between passes within one encoder. That is exactly why the flush-per-gather submit is unnecessary.
#[expect(clippy::too_many_arguments, reason = "the GPU context + keepalive travel together")]
pub fn run_graph_into(
    compositor: &Compositor,
    glass: &GlassPipeline,
    device: &wgpu::Device,
    enc: &mut wgpu::CommandEncoder,
    inputs: &[&wgpu::TextureView],
    passes: &[Pass],
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    pool: &mut crate::vello::sink::TexturePool,
    keep_tex: &mut Vec<wgpu::Texture>,
    keep_views: &mut Vec<wgpu::TextureView>,
    mut prof: Option<&mut crate::vello::gputime::PassProfiler>,
) -> Option<(wgpu::Texture, wgpu::TextureView)> {
    crate::vello::prof::inc_graph();
    let sampler = compositor.sampler();
    let mut outputs: Vec<(wgpu::Texture, wgpu::TextureView)> = Vec::with_capacity(passes.len());

    if let (Some(p), Some(v)) = (prof.as_deref_mut(), inputs.first()) {
        p.stamp(enc, v, prof_bucket::CROP);
    }

    let last = passes.len().saturating_sub(1);
    for (idx, pass) in passes.iter().enumerate() {
        let bound: Vec<wgpu::TextureView> = pass
            .inputs
            .iter()
            .map(|s| match *s {
                Src::Input(i) => inputs[i].clone(),
                Src::Pass(i) => outputs[i].1.clone(),
            })
            .collect();

        let extra = if idx == last {
            wgpu::TextureUsages::COPY_SRC
        } else {
            wgpu::TextureUsages::empty()
        };
        let (pw, ph) = (
            crate::effect_graph::pass_dim(w, pass.scale),
            crate::effect_graph::pass_dim(h, pass.scale),
        );
        let tex = pool.acquire_target(device, pw, ph, pass.kind.output_format(format), extra, "effect target");
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

        match &pass.kind {
            PassKind::Blur { sigma, linear } => {
                gaussian_blur(compositor, device, enc, &view, &bound[0], pw, ph, *sigma, *linear, format, pool, keep_tex, keep_views);
            }
            PassKind::Units(ops) => {
                glass.units(device, enc, &view, &bound[0], bound.get(1), ops);
            }
            PassKind::Custom { pipeline, u, param_vec4s } => {
                custom_pass(device, enc, &view, pipeline, sampler, &bound, u, *param_vec4s);
            }
        }
        if let Some(p) = prof.as_deref_mut() {
            p.stamp(enc, &view, pass.kind.prof_bucket());
        }
        outputs.push((tex, view));
    }

    let final_out = outputs.pop();
    for (tex, view) in outputs {
        keep_tex.push(tex);
        keep_views.push(view);
    }
    final_out
}

/// Standalone effect graph: make an encoder, [`run_graph_into`] it, and submit. For callers not
/// folding the graph into a larger frame encoder (the tiled gather path, focus mode). Dropping the
/// scratch right after the submit is safe — the submit retains every resource until the GPU is done.
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
    let mut enc =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("effect graph") });
    let mut pool = crate::vello::sink::TexturePool::default();
    let mut keep_tex: Vec<wgpu::Texture> = Vec::new();
    let mut keep_views: Vec<wgpu::TextureView> = Vec::new();
    let out = run_graph_into(compositor, glass, device, &mut enc, inputs, passes, w, h, format, &mut pool, &mut keep_tex, &mut keep_views, None);
    queue.submit([enc.finish()]);
    out
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
    linear: bool,
    format: wgpu::TextureFormat,
    pool: &mut crate::vello::sink::TexturePool,
    keep: &mut Vec<wgpu::Texture>,
    keep_views: &mut Vec<wgpu::TextureView>,
) {
    let vd = wgpu::TextureViewDescriptor::default();

    if sigma <= BLUR_MAX_SIGMA {
        let scratch = pool.acquire_target(device, w, h, format, wgpu::TextureUsages::empty(), "blur scratch");
        let sv = scratch.create_view(&vd);
        compositor.blur1d(device, enc, &sv, &BlurPass { src, size: (w as f32, h as f32), dir: (1.0, 0.0), sigma, linear });
        compositor.blur1d(device, enc, dst, &BlurPass { src: &sv, size: (w as f32, h as f32), dir: (0.0, 1.0), sigma, linear });
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

    let mut cur = src.clone();
    let (mut cw, mut ch) = (w, h);
    while cw > target_w || ch > target_h {
        let nw = cw.div_ceil(2).max(target_w);
        let nh = ch.div_ceil(2).max(target_h);
        let t = pool.acquire_target(device, nw, nh, format, wgpu::TextureUsages::empty(), "blur downsample");
        let tv = t.create_view(&vd);
        Compositor::clear(enc, &tv, [0.0, 0.0, 0.0, 0.0], None);
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

    let coarse_sigma = sigma / level;
    let coarse_size = (cw as f32, ch as f32);
    let scratch = pool.acquire_target(device, cw, ch, format, wgpu::TextureUsages::empty(), "blur coarse scratch");
    let scv = scratch.create_view(&vd);
    let blurred = pool.acquire_target(device, cw, ch, format, wgpu::TextureUsages::empty(), "blur coarse");
    let bv = blurred.create_view(&vd);
    compositor.blur1d(device, enc, &scv, &BlurPass { src: &cur, size: coarse_size, dir: (1.0, 0.0), sigma: coarse_sigma, linear });
    compositor.blur1d(device, enc, &bv, &BlurPass { src: &scv, size: coarse_size, dir: (0.0, 1.0), sigma: coarse_sigma, linear });

    Compositor::clear(enc, dst, [0.0, 0.0, 0.0, 0.0], None);
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
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
    ];
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
                blend: None,
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

/// Run a compiled custom pipeline over `inputs` (bound at 2..) with `u` (surface resolution + params),
/// sharing the effect `sampler` at 1, into `target`. `u` is normalised to *exactly* `param_vec4s`
/// vec4s — the size the shader declares in `array<vec4<f32>, N>` — by zero-filling a short `u` and
/// truncating a long one. Because the bound buffer's size is always the shader's declared size, no
/// param-count mismatch can ever reach wgpu: there is no "too few → validation error" and no
/// "too many → ignored" to reason about. The effect's one declared number is honoured verbatim.
fn custom_pass(
    device: &wgpu::Device,
    enc: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    sampler: &wgpu::Sampler,
    inputs: &[wgpu::TextureView],
    u: &[f32],
    param_vec4s: u32,
) {
    let mut padded = u.to_vec();
    padded.resize(param_vec4s as usize * 4, 0.0);
    let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("custom params"),
        contents: bytemuck::cast_slice(&padded),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let layout = pipeline.get_bind_group_layout(0);
    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
    ];
    for (i, v) in inputs.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry { binding: 2 + i as u32, resource: wgpu::BindingResource::TextureView(v) });
    }
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("custom bind"), layout: &layout, entries: &entries });
    crate::vello::sink::note_passes(1);
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
///
/// The graph's own passes are render-pipeline blits/shaders, so `RENDER_ATTACHMENT | TEXTURE_BINDING`
/// is all they need. A target the sink rasterizes into with a *backend* scene (the gather coverage
/// mask) needs the backend's extra usage too — see [`new_target_with_usage`].
pub fn new_target(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
    new_target_with_usage(device, w, h, format, wgpu::TextureUsages::empty())
}

/// [`new_target`] plus `extra` usage flags. Used for the gather coverage mask, which the sink fills
/// via `backend.rasterize` — classic writes that from a compute shader, so the mask must also carry
/// `STORAGE_BINDING` (supplied by `RasterBackend::rasterize_target_usage`). Without it the compute
/// bind group is invalid, the mask render is dropped, and the blur silently vanishes.
pub fn new_target_with_usage(
    device: &wgpu::Device,
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    extra: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("effect target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | extra,
        view_formats: &[],
    })
}
