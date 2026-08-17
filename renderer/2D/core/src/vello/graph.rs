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
use crate::vello::glass::GlassPipeline;

/// Feature gate for the sharp-glass fusion (refraction+composite → one draw). On by default; flip to
/// `false` to force the two-pass path for an A/B (pixel-diff + cost) against the fused path.
const FUSE_SHARP_GLASS: bool = true;

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
    /// kernel, a downsample pyramid for a large one (see [`gaussian_blur`]). `linear` blurs in linear
    /// light (sRGB-decode taps, re-encode the result).
    Blur { sigma: f32, linear: bool },
    /// Glass refraction + chromatic aberration. Input `[backdrop]`; the SDF field is recomputed inline
    /// from the 20-float uniform (chromatic-aberration at index 17).
    GlassRefraction { u: [f32; 20] },
    /// Glass frost / specular composite. Inputs `[blurred, original]`; field recomputed inline from the
    /// 20-float uniform (`frost/specularOpacity/specularSaturation` at 17/18/19).
    GlassComposite { u: [f32; 20] },
    /// **Fused** sharp-glass refraction + composite in one draw over `[backdrop]` — the collapse the
    /// footprint partition picks when frost ≤ 0.01 (no scatter, no blur). Carries both passes' uniforms;
    /// [`GlassPipeline::fused`] combines them. No intermediate texture is allocated.
    GlassFused { refr_u: [f32; 20], comp_u: [f32; 20] },
    /// A hand-written WGSL pass — the escape hatch. Runs the (already-compiled, cached) `pipeline`
    /// over its inputs with `u` (surface resolution + params), sized to exactly `param_vec4s` vec4s
    /// (the shader's declared `array<vec4<f32>, N>`). The pipeline's own `@group(0)` layout is
    /// honoured: binding 0 uniform, 1 sampler, 2.. the input textures in order.
    Custom { pipeline: Rc<wgpu::RenderPipeline>, u: Vec<f32>, param_vec4s: u32 },
}

/// Lower a render-core effect graph to runnable [`Pass`]es. Every kind maps one-to-one except
/// [`EffectPass::Custom`], whose pipeline the IR does not carry: `custom` supplies the shape's
/// compiled pipeline (the caller resolved + cached it from the shader source). A `Custom` pass with
/// no pipeline provided is dropped with a warning rather than panicking mid-frame.
pub fn lower_graph(graph: &[GraphPass], custom: Option<&Rc<wgpu::RenderPipeline>>) -> Vec<Pass> {
    // Partition the graph into fused segments + barriers, then lower each. The one multi-pass fusion the
    // built-in effects produce is sharp glass — a `Fused([GlassRefraction, GlassComposite])` segment
    // (which by construction is the whole graph: any blur between them is a barrier that splits them).
    // Collapse that to a single `GlassFused` draw; everything else lowers pass-for-pass, so `Src::Pass`
    // indices stay valid (the collapse only fires when there are no downstream passes to reference it).
    let stages = crate::footprint::partition(graph);
    let mut out = Vec::with_capacity(graph.len());
    for stage in &stages {
        match stage {
            crate::footprint::Stage::Fused(idxs) => {
                if FUSE_SHARP_GLASS {
                if let [i, j] = idxs.as_slice() {
                    if let (
                        EffectPass::GlassRefraction { u: refr_u },
                        EffectPass::GlassComposite { u: comp_u },
                    ) = (&graph[*i].pass, &graph[*j].pass)
                    {
                        out.push(Pass {
                            kind: PassKind::GlassFused { refr_u: *refr_u, comp_u: *comp_u },
                            inputs: graph[*i].inputs.clone(), // the backdrop, Input(0)
                        });
                        continue;
                    }
                }
                }
                for &i in idxs {
                    if let Some(p) = lower_pass(&graph[i], custom) {
                        out.push(p);
                    }
                }
            }
            crate::footprint::Stage::Barrier(i) => {
                if let Some(p) = lower_pass(&graph[*i], custom) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Lower one neutral [`GraphPass`] to a runnable [`Pass`]. `None` only for a `Custom` pass whose
/// pipeline the caller did not resolve (dropped with a warning rather than panicking mid-frame).
fn lower_pass(gp: &GraphPass, custom: Option<&Rc<wgpu::RenderPipeline>>) -> Option<Pass> {
    let kind = match &gp.pass {
        EffectPass::Blur { sigma, linear } => PassKind::Blur { sigma: *sigma, linear: *linear },
        EffectPass::GlassRefraction { u } => PassKind::GlassRefraction { u: *u },
        EffectPass::GlassComposite { u } => PassKind::GlassComposite { u: *u },
        EffectPass::Custom { u, param_vec4s } => match custom {
            Some(pipeline) => PassKind::Custom { pipeline: pipeline.clone(), u: u.clone(), param_vec4s: *param_vec4s },
            None => {
                log::warn!("custom effect pass with no pipeline resolved; skipping");
                return None;
            }
        },
    };
    Some(Pass { kind, inputs: gp.inputs.clone() })
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
            PassKind::GlassRefraction { .. } => prof_bucket::REFRACTION,
            PassKind::Blur { .. } => prof_bucket::BLUR,
            PassKind::GlassComposite { .. } => prof_bucket::COMPOSITE,
            PassKind::GlassFused { .. } => prof_bucket::COMPOSITE,
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

    // Opening boundary stamp for the per-pass profiler: mark the GPU timeline just before pass 0, so
    // the first delta (this → after-pass-0) is pass 0's own GPU-busy time. Any live view works as the
    // empty pass's attachment; the first input is always present for the effects that carry inputs.
    if let (Some(p), Some(v)) = (prof.as_deref_mut(), inputs.first()) {
        // The interval ending here (since the caller's pre-crop stamp) is the backdrop crop blit.
        p.stamp(enc, v, prof_bucket::CROP);
    }

    let last = passes.len().saturating_sub(1);
    for (idx, pass) in passes.iter().enumerate() {
        // Resolve (cloned, so allocating the new output below can't collide with these borrows).
        let bound: Vec<wgpu::TextureView> = pass
            .inputs
            .iter()
            .map(|s| match *s {
                Src::Input(i) => inputs[i].clone(),
                Src::Pass(i) => outputs[i].1.clone(),
            })
            .collect();

        // The final pass's texture is the returned result — a caller may install it as a durable sink
        // surface and the tile-fuse then inlines it via `register_texture`, which COPIES from it. So the
        // last output must carry `COPY_SRC` (without it a custom-shader spread surface can't be inlined
        // and the shape renders empty). `COPY_SRC` ONLY — emphatically NOT `COPY_DST`: adding COPY_DST
        // widens the pool bucket so this gather-output texture aliases a copy-destination surface and gets
        // overwritten mid-frame, corrupting ~500k px of the phased render (measured). Intermediates are
        // only ever sampled by a later pass, so they stay lean.
        let extra = if idx == last {
            wgpu::TextureUsages::COPY_SRC
        } else {
            wgpu::TextureUsages::empty()
        };
        let tex = pool.acquire_target(device, w, h, pass.kind.output_format(format), extra, "effect target");
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

        match &pass.kind {
            PassKind::Blur { sigma, linear } => {
                gaussian_blur(compositor, device, enc, &view, &bound[0], w, h, *sigma, *linear, format, pool, keep_tex, keep_views);
            }
            PassKind::GlassRefraction { u } => {
                glass.refraction(device, enc, &view, &bound[0], u);
            }
            PassKind::GlassComposite { u } => {
                glass.composite(device, enc, &view, &bound[0], &bound[1], u);
            }
            PassKind::GlassFused { refr_u, comp_u } => {
                glass.fused(device, enc, &view, &bound[0], refr_u, comp_u);
            }
            PassKind::Custom { pipeline, u, param_vec4s } => {
                custom_pass(device, enc, &view, pipeline, sampler, &bound, u, *param_vec4s);
            }
        }
        // Closing boundary stamp for this pass: the delta from the previous stamp is this pass's time.
        if let Some(p) = prof.as_deref_mut() {
            p.stamp(enc, &view, pass.kind.prof_bucket());
        }
        outputs.push((tex, view));
    }

    let final_out = outputs.pop();
    // Every non-final pass output is read by a later pass but not by the returned result; it must
    // still outlive the caller's submit, so hand it to the keepalive rather than dropping it here.
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
    // Standalone: a throwaway pool (this call owns its whole lifetime, so there is nothing to reuse
    // across). The whole-viewport path uses `run_graph_into` with the sink's persistent pool instead.
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

    // Downsample by repeated halving (each ×2 bilinear = a 2×2 box, no aliasing).
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

    // Blur at the coarse level with the reduced sigma.
    let coarse_sigma = sigma / level;
    let coarse_size = (cw as f32, ch as f32);
    let scratch = pool.acquire_target(device, cw, ch, format, wgpu::TextureUsages::empty(), "blur coarse scratch");
    let scv = scratch.create_view(&vd);
    let blurred = pool.acquire_target(device, cw, ch, format, wgpu::TextureUsages::empty(), "blur coarse");
    let bv = blurred.create_view(&vd);
    compositor.blur1d(device, enc, &scv, &BlurPass { src: &cur, size: coarse_size, dir: (1.0, 0.0), sigma: coarse_sigma, linear });
    compositor.blur1d(device, enc, &bv, &BlurPass { src: &scv, size: coarse_size, dir: (0.0, 1.0), sigma: coarse_sigma, linear });

    // Upsample the coarse blurred result to the full-size dst (bilinear). dst is fresh → clear first
    // so the SrcOver blit lands exactly (transparent dst → out == src).
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
        // binding 0: resolution + params, a small uniform block sized to the shader's declared
        // `array<vec4<f32>, N>` (may be unused by the shader). The backend binds a buffer of exactly
        // `param_vec4s * 4` floats (see `custom_pass`), so its size always matches the shader's fixed
        // `N` — no size mismatch is possible, hence no runtime-sized array / storage buffer needed.
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
    // Resize to exactly the declared `N * 4` floats: pad short with zeros, drop any overflow.
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
