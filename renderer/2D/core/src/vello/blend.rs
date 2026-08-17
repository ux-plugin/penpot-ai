//! A minimal "blit with SrcOver blend" pipeline — the scheduler's compositor.
//!
//! The tile store composites its pieces onto the frame with `copy_texture_to_texture`, which
//! *overwrites* the destination. That is correct for opaque, non-overlapping tile centres, but it
//! cannot stack: a drop shadow has to blend *under* its shape, over the background. This pipeline
//! is the alternative — sample a source texture and blend it into a device rect of a target with
//! premultiplied `SrcOver`, so the scheduler can lay down, in z-order, the background, then each
//! pre-produced effect surface, then the plain-content tiles.
//!
//! It is deliberately tiny: no vertex buffers (the quad is generated from `vertex_index`), one
//! small uniform per blit carrying the destination NDC rect and the source UV rect. Each blit
//! creates its own uniform + bind group so nothing is shared across passes — the same
//! one-write-per-GPU-read discipline the tile store's submit-per-tile fix established.

use crate::peniko;
use wgpu::util::DeviceExt;

/// One composite: blend `src`'s `[uv]` region into the target's device rect, premultiplied SrcOver.
pub struct Blit<'a> {
    /// Source texture view to sample.
    pub src: &'a wgpu::TextureView,
    /// Destination rect in target device pixels: `(x, y, w, h)`.
    pub dst: (f32, f32, f32, f32),
    /// Source region in source texels: `(x, y, w, h)`.
    pub src_rect: (f32, f32, f32, f32),
    /// Source texture size in texels: `(w, h)` — to normalise `src_rect` to UV.
    pub src_size: (f32, f32),
    /// Layer opacity `[0,1]` multiplied into the (premultiplied) source before the SrcOver blend —
    /// this is a `ScopeOf` group's / spread shape's `LayerPaint.opacity`. `1.0` is a plain blit.
    pub alpha: f32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dst_min: [f32; 2],
    dst_max: [f32; 2],
    uv_min: [f32; 2],
    uv_max: [f32; 2],
    alpha: f32,
    // Uniform structs pad to 16 bytes; keep the layout explicit for `bytemuck::Pod`.
    _pad: [f32; 3],
}

/// A blit clipped by a coverage mask: `src` (the blurred backdrop) times `mask`'s alpha, so the
/// result shows only through the shape's silhouette rather than its bounding rect. `mask` and `src`
/// share the same device rect, so one `src_rect`/`src_size` addresses both.
pub struct MaskedBlit<'a> {
    pub src: &'a wgpu::TextureView,
    pub mask: &'a wgpu::TextureView,
    pub dst: (f32, f32, f32, f32),
    pub src_rect: (f32, f32, f32, f32),
    pub src_size: (f32, f32),
    pub alpha: f32,
}

/// One directional Gaussian blur pass: read `src`, write a full target, sampling `2·radius+1` taps
/// along `dir`. Two passes (horizontal then vertical) make a separable 2D Gaussian.
pub struct BlurPass<'a> {
    pub src: &'a wgpu::TextureView,
    /// Source size in texels `(w, h)` — same as the target's (a blur pass is size-preserving).
    pub size: (f32, f32),
    /// `(1, 0)` for the horizontal pass, `(0, 1)` for the vertical.
    pub dir: (f32, f32),
    /// Gaussian sigma in device pixels.
    pub sigma: f32,
    /// Blur in linear light: sRGB-decode each tap, accumulate, then re-encode the result. `false`
    /// keeps the historical gamma-space average (raw sRGB bytes).
    pub linear: bool,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams {
    inv_size: [f32; 2],
    dir: [f32; 2],
    sigma: f32,
    radius: f32,
    linearize: f32,
    _pad: f32,
}

/// One non-`SrcOver` blend composite: place `src`'s `src_rect` at the target device rect and blend it
/// (W3C `Mix` + source-over) against `backdrop` — a *copy* of the target sampled 1:1, so the shader
/// can read the destination it is about to overwrite (WebGL2 forbids reading the live target). `alpha`
/// is the layer opacity. The result is the full composited color, written with a replace (no hardware
/// blend), so the shape's opacity+blend land as a single operation against the tile's real backdrop.
pub struct BlendComposite<'a> {
    pub src: &'a wgpu::TextureView,
    /// A copy of the target, same size, sampled at the fragment's own position.
    pub backdrop: &'a wgpu::TextureView,
    pub dst: (f32, f32, f32, f32),
    pub src_rect: (f32, f32, f32, f32),
    pub src_size: (f32, f32),
    pub alpha: f32,
    /// W3C `Mix` mode code (see [`mix_code`]); `Normal` never reaches this path.
    pub mix: u32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlendParams {
    dst_min: [f32; 2],
    dst_max: [f32; 2],
    uv_min: [f32; 2],
    uv_max: [f32; 2],
    // Backdrop UV rect = the target device rect / target size, so the copy is sampled at each
    // fragment's own position (backdrop is the same size as the target).
    bg_min: [f32; 2],
    bg_max: [f32; 2],
    alpha: f32,
    mix: u32,
    _pad: [f32; 2],
}

/// Map a `peniko::Mix` to the WGSL blend code the [`BLEND_SHADER`] switches on. `Normal` is `0` and is
/// composited by the plain SrcOver blit, never this path.
#[must_use]
pub fn mix_code(mix: peniko::Mix) -> u32 {
    use peniko::Mix;
    match mix {
        Mix::Normal => 0,
        Mix::Multiply => 1,
        Mix::Screen => 2,
        Mix::Overlay => 3,
        Mix::Darken => 4,
        Mix::Lighten => 5,
        Mix::ColorDodge => 6,
        Mix::ColorBurn => 7,
        Mix::HardLight => 8,
        Mix::SoftLight => 9,
        Mix::Difference => 10,
        Mix::Exclusion => 11,
        Mix::Hue => 12,
        Mix::Saturation => 13,
        Mix::Color => 14,
        Mix::Luminosity => 15,
        _ => 0,
    }
}

/// A reusable SrcOver blit + Gaussian blur + mask-clipped blit pipeline for one target format.
pub struct Compositor {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    blur_pipeline: wgpu::RenderPipeline,
    blur_layout: wgpu::BindGroupLayout,
    masked_pipeline: wgpu::RenderPipeline,
    masked_layout: wgpu::BindGroupLayout,
    blend_pipeline: wgpu::RenderPipeline,
    blend_layout: wgpu::BindGroupLayout,
    /// Porter-Duff `DestOut` (`out = dst·(1 − src.a)`) — same shader/layout as `pipeline`, only the
    /// blend state differs. Used to punch a blurred silhouette out of an inner-shadow band.
    dstout_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

impl Compositor {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor blit"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compositor bind layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    // Vertex reads the rects; fragment reads `alpha`.
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor pipeline"),
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
                    format,
                    // Premultiplied SrcOver: out = src + dst·(1 − src.a). Vello renders premultiplied.
                    blend: Some(wgpu::BlendState {
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
                    }),
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
        });
        // DestOut variant: same vs/fs + bind layout, but the blend keeps only `dst·(1 − src.a)` — the
        // source colour is discarded (`src_factor: Zero`), so drawing a coverage texture erases the
        // target by that coverage. Punches the blurred offset silhouette out of the inner-shadow band.
        let dstout_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor dstout pipeline"),
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
                    format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::Zero,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::Zero,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
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
        });
        // Separable Gaussian blur: one directional pass, no blending (it overwrites a full target).
        let blur_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor blur"),
            source: wgpu::ShaderSource::Wgsl(BLUR_SHADER.into()),
        });
        let blur_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compositor blur layout"),
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
        let blur_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor blur pipeline layout"),
            bind_group_layouts: &[Some(&blur_layout)],
            immediate_size: 0,
        });
        let blur_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor blur pipeline"),
            layout: Some(&blur_pl),
            vertex: wgpu::VertexState {
                module: &blur_shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &blur_shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None, // overwrites a full scratch target
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
        });

        // Mask-clipped blit: like the plain blit, but multiplies in a coverage mask (binding 3) so
        // the blurred backdrop shows only through the shape's silhouette.
        let masked_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor masked"),
            source: wgpu::ShaderSource::Wgsl(MASKED_SHADER.into()),
        });
        let masked_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compositor masked layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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
            ],
        });
        let masked_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor masked pipeline layout"),
            bind_group_layouts: &[Some(&masked_layout)],
            immediate_size: 0,
        });
        let masked_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor masked pipeline"),
            layout: Some(&masked_pl),
            vertex: wgpu::VertexState {
                module: &masked_shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &masked_shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    // Same premultiplied SrcOver as the plain blit — it composites onto the tile.
                    blend: Some(wgpu::BlendState {
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
                    }),
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
        });

        // Non-`SrcOver` blend: read `src` and a `backdrop` copy (bindings 1 and 3), compute the full
        // W3C blend + source-over result in the shader, and **replace** the target (blend `None`) — the
        // shader already folded in the backdrop, so a hardware SrcOver would double it. Same 4-binding
        // layout as the masked blit (uniform, src, sampler, extra texture).
        let blend_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor blend"),
            source: wgpu::ShaderSource::Wgsl(BLEND_SHADER.into()),
        });
        let blend_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compositor blend layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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
            ],
        });
        let blend_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor blend pipeline layout"),
            bind_group_layouts: &[Some(&blend_layout)],
            immediate_size: 0,
        });
        let blend_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor blend pipeline"),
            layout: Some(&blend_pl),
            vertex: wgpu::VertexState {
                module: &blend_shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &blend_shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    // Replace: the fragment output already includes the backdrop.
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
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("compositor sampler"),
            // Clamp so blur taps past the edge repeat the edge texel rather than wrap.
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            pipeline,
            layout,
            blur_pipeline,
            blur_layout,
            masked_pipeline,
            masked_layout,
            blend_pipeline,
            blend_layout,
            dstout_pipeline,
            sampler,
        }
    }

    /// The shared filtering sampler (ClampToEdge, linear). A custom-shader pass binds it so its
    /// `textureSample` of the backdrop matches every other effect pass.
    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    /// Record a coverage-masked SrcOver blit: `src` clipped by `mask`'s alpha into `target`. Used to
    /// stamp a blurred gather backdrop through the shape's exact silhouette, not its bounding rect.
    pub fn blit_masked(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        target_size: (f32, f32),
        blit: &MaskedBlit,
    ) {
        let (tw, th) = target_size;
        let (dx, dy, dw, dh) = blit.dst;
        let ndc_x = |x: f32| (x / tw) * 2.0 - 1.0;
        let ndc_y = |y: f32| 1.0 - (y / th) * 2.0;
        let (sw, sh) = blit.src_size;
        let (sx, sy, srw, srh) = blit.src_rect;
        let params = Params {
            dst_min: [ndc_x(dx), ndc_y(dy)],
            dst_max: [ndc_x(dx + dw), ndc_y(dy + dh)],
            uv_min: [sx / sw, sy / sh],
            uv_max: [(sx + srw) / sw, (sy + srh) / sh],
            alpha: blit.alpha.clamp(0.0, 1.0),
            _pad: [0.0; 3],
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("compositor masked params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor masked bind"),
            layout: &self.masked_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blit.src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(blit.mask) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor masked blit"),
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
        pass.set_pipeline(&self.masked_pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Record one directional Gaussian pass, overwriting the whole of `target` (same size as `src`).
    /// The caller runs two — horizontal then vertical — through a scratch surface for a 2D blur.
    pub fn blur1d(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        blur: &BlurPass,
    ) {
        let (w, h) = blur.size;
        // 3σ covers the Gaussian; cap the tap count so a pathological sigma can't stall the GPU.
        let radius = (3.0 * blur.sigma).ceil().clamp(1.0, 160.0);
        let params = BlurParams {
            inv_size: [1.0 / w, 1.0 / h],
            dir: [blur.dir.0, blur.dir.1],
            sigma: blur.sigma.max(1e-3),
            radius,
            linearize: if blur.linear { 1.0 } else { 0.0 },
            _pad: 0.0,
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("compositor blur params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor blur bind"),
            layout: &self.blur_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blur.src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor blur pass"),
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
        pass.set_pipeline(&self.blur_pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Record one non-`SrcOver` blend composite into `target`: place `src` at the device rect and
    /// blend it (W3C `Mix` + source-over) against `blend.backdrop` (a copy of `target`, same size,
    /// which the caller must have populated — WebGL2 forbids sampling the live render target). The pass
    /// **replaces** `target` inside the device rect (the shader output already folds in the backdrop)
    /// and loads elsewhere, so nothing outside the shape's rect is touched.
    pub fn composite_blend(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        target_size: (f32, f32),
        blend: &BlendComposite,
    ) {
        let (tw, th) = target_size;
        let (dx, dy, dw, dh) = blend.dst;
        let ndc_x = |x: f32| (x / tw) * 2.0 - 1.0;
        let ndc_y = |y: f32| 1.0 - (y / th) * 2.0;
        let (sw, sh) = blend.src_size;
        let (sx, sy, srw, srh) = blend.src_rect;
        let params = BlendParams {
            dst_min: [ndc_x(dx), ndc_y(dy)],
            dst_max: [ndc_x(dx + dw), ndc_y(dy + dh)],
            uv_min: [sx / sw, sy / sh],
            uv_max: [(sx + srw) / sw, (sy + srh) / sh],
            bg_min: [dx / tw, dy / th],
            bg_max: [(dx + dw) / tw, (dy + dh) / th],
            alpha: blend.alpha.clamp(0.0, 1.0),
            mix: blend.mix,
            _pad: [0.0; 2],
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("compositor blend params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor blend bind"),
            layout: &self.blend_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blend.src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(blend.backdrop) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor blend composite"),
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
        pass.set_pipeline(&self.blend_pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Record one SrcOver blit into `target` (which must be the format this compositor was built
    /// for). `target_size` is the target's device size in pixels. The pass loads, so prior content
    /// under the blit is preserved and blended against.
    pub fn blit(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        target_size: (f32, f32),
        blit: &Blit,
    ) {
        let (tw, th) = target_size;
        let (dx, dy, dw, dh) = blit.dst;
        // Device rect → NDC. y is flipped (device y-down, NDC y-up).
        let ndc_x = |x: f32| (x / tw) * 2.0 - 1.0;
        let ndc_y = |y: f32| 1.0 - (y / th) * 2.0;
        let (sw, sh) = blit.src_size;
        let (sx, sy, srw, srh) = blit.src_rect;
        // `corner` runs (0,0)→(1,1); position and UV must agree on the y direction or the sample is
        // flipped. corner.y=0 → device-top (`dy`, higher NDC) and source-top (`uv_min`).
        let params = Params {
            dst_min: [ndc_x(dx), ndc_y(dy)],
            dst_max: [ndc_x(dx + dw), ndc_y(dy + dh)],
            uv_min: [sx / sw, sy / sh],
            uv_max: [(sx + srw) / sw, (sy + srh) / sh],
            alpha: blit.alpha.clamp(0.0, 1.0),
            _pad: [0.0; 3],
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("compositor params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blit.src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &bind, &[]);
        // Triangle strip: 4 corners (0,0),(1,0),(0,1),(1,1) via vertex_index bit tricks in the shader.
        pass.draw(0..4, 0..1);
    }

    /// Record one Porter-Duff `DestOut` blit (`target = target·(1 − src.a)`): erase `target` by the
    /// source's coverage. Identical bind/geometry to [`Self::blit`]; only the pipeline's blend differs.
    /// Used to punch the blurred, offset silhouette out of an inner-shadow band.
    pub fn blit_dstout(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        target_size: (f32, f32),
        blit: &Blit,
    ) {
        let (tw, th) = target_size;
        let (dx, dy, dw, dh) = blit.dst;
        let ndc_x = |x: f32| (x / tw) * 2.0 - 1.0;
        let ndc_y = |y: f32| 1.0 - (y / th) * 2.0;
        let (sw, sh) = blit.src_size;
        let (sx, sy, srw, srh) = blit.src_rect;
        let params = Params {
            dst_min: [ndc_x(dx), ndc_y(dy)],
            dst_max: [ndc_x(dx + dw), ndc_y(dy + dh)],
            uv_min: [sx / sw, sy / sh],
            uv_max: [(sx + srw) / sw, (sy + srh) / sh],
            alpha: blit.alpha.clamp(0.0, 1.0),
            _pad: [0.0; 3],
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("compositor dstout params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor dstout bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blit.src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor dstout blit"),
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
        pass.set_pipeline(&self.dstout_pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Record a full-target clear to `color` (straight, non-premultiplied RGBA in `[0,1]`). Used to
    /// lay the page background under the composited shadows and shapes.
    /// `timestamp` optionally stamps the start of the frame's GPU span here — this is the first pass
    /// the sink records, so it is where the span has to open (see [`crate::vello::gputime`]).
    pub fn clear(
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        color: [f64; 4],
        timestamp: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) {
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: color[0],
                        g: color[1],
                        b: color[2],
                        a: color[3],
                    }),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: timestamp,
            multiview_mask: None,
        });
    }
}

const SHADER: &str = r#"
struct Params {
    dst_min: vec2<f32>,
    dst_max: vec2<f32>,
    uv_min: vec2<f32>,
    uv_max: vec2<f32>,
    alpha: f32,
    // Pad to 48 bytes (a multiple of 16): WebGL2 requires uniform bindings to be 16-byte aligned,
    // and the type is 40 without this. The Rust `Params` already carries `_pad: [f32; 3]` to match.
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    // Corners of a triangle strip: (0,0), (1,0), (0,1), (1,1).
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    var out: VSOut;
    out.pos = vec4<f32>(mix(p.dst_min, p.dst_max, corner), 0.0, 1.0);
    out.uv = mix(p.uv_min, p.uv_max, corner);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    // Premultiplied source; scaling the whole RGBA by the layer opacity is the correct group fade.
    return textureSample(tex, samp, in.uv) * p.alpha;
}
"#;

const BLUR_SHADER: &str = r#"
struct Blur {
    inv_size: vec2<f32>,
    dir: vec2<f32>,
    sigma: f32,
    radius: f32,
    linearize: f32,
};
@group(0) @binding(0) var<uniform> b: Blur;
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
// Decode a premultiplied-sRGB sample to premultiplied-linear (unpremultiply → decode → re-premultiply),
// so the Gaussian averages in linear light. Alpha is already linear and passes through.
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
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    // Fullscreen quad: corners (0,0),(1,0),(0,1),(1,1) → NDC, with matching UVs.
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    var out: VSOut;
    out.pos = vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
    // NDC y-up vs texture y-down: flip v so the pass samples the right row.
    out.uv = vec2<f32>(corner.x, 1.0 - corner.y);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    let r = i32(b.radius);
    let inv2s2 = 1.0 / (2.0 * b.sigma * b.sigma);
    let lin = b.linearize > 0.5;
    var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var wsum = 0.0;
    for (var i = -r; i <= r; i = i + 1) {
        let fi = f32(i);
        let w = exp(-fi * fi * inv2s2);
        let uv = in.uv + b.dir * (fi * b.inv_size);
        var s = textureSample(tex, samp, uv);
        if (lin) { s = premul_srgb_to_lin(s); }
        sum = sum + s * w;
        wsum = wsum + w;
    }
    // Premultiplied colours combine linearly, so a normalised weighted sum is the correct blur.
    var outc = sum / wsum;
    if (lin) { outc = premul_lin_to_srgb(outc); }
    return outc;
}
"#;

const MASKED_SHADER: &str = r#"
struct Params {
    dst_min: vec2<f32>,
    dst_max: vec2<f32>,
    uv_min: vec2<f32>,
    uv_max: vec2<f32>,
    alpha: f32,
    // Pad to 48 bytes (a multiple of 16): WebGL2 requires uniform bindings to be 16-byte aligned,
    // and the type is 40 without this. The Rust `Params` already carries `_pad: [f32; 3]` to match.
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var mask: texture_2d<f32>;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    var out: VSOut;
    out.pos = vec4<f32>(mix(p.dst_min, p.dst_max, corner), 0.0, 1.0);
    out.uv = mix(p.uv_min, p.uv_max, corner);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    // Premultiplied source clipped by the mask's (anti-aliased) coverage, then layer opacity.
    let cover = textureSample(mask, samp, in.uv).a;
    return textureSample(tex, samp, in.uv) * cover * p.alpha;
}
"#;

const BLEND_SHADER: &str = r#"
struct P {
    dst_min: vec2<f32>,
    dst_max: vec2<f32>,
    uv_min: vec2<f32>,
    uv_max: vec2<f32>,
    bg_min: vec2<f32>,
    bg_max: vec2<f32>,
    alpha: f32,
    mix: u32,
    _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var bg_tex: texture_2d<f32>;

// --- W3C separable blend functions, componentwise over RGB (non-premultiplied) ---
fn f_overlay(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let lo = 2.0 * cb * cs;
    let hi = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
    return select(hi, lo, cb <= vec3<f32>(0.5));
}
fn f_hardlight(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let lo = 2.0 * cb * cs;
    let hi = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
    return select(hi, lo, cs <= vec3<f32>(0.5));
}
fn f_dodge(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let base = min(vec3<f32>(1.0), cb / max(vec3<f32>(1.0) - cs, vec3<f32>(1e-6)));
    let with_one = select(base, vec3<f32>(1.0), cs >= vec3<f32>(1.0));
    return select(with_one, vec3<f32>(0.0), cb <= vec3<f32>(0.0));
}
fn f_burn(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let base = 1.0 - min(vec3<f32>(1.0), (vec3<f32>(1.0) - cb) / max(cs, vec3<f32>(1e-6)));
    let with_zero = select(base, vec3<f32>(0.0), cs <= vec3<f32>(0.0));
    return select(with_zero, vec3<f32>(1.0), cb >= vec3<f32>(1.0));
}
fn f_softlight(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let d = select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= vec3<f32>(0.25));
    let lo = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    let hi = cb + (2.0 * cs - 1.0) * (d - cb);
    return select(hi, lo, cs <= vec3<f32>(0.5));
}

// --- W3C non-separable helpers ---
fn lum(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }
fn clip_color(c: vec3<f32>) -> vec3<f32> {
    let l = lum(c);
    let n = min(c.r, min(c.g, c.b));
    let x = max(c.r, max(c.g, c.b));
    var col = c;
    if (n < 0.0) { col = l + (col - l) * l / (l - n); }
    if (x > 1.0) { col = l + (col - l) * (1.0 - l) / (x - l); }
    return col;
}
fn set_lum(c: vec3<f32>, l: f32) -> vec3<f32> { return clip_color(c + (l - lum(c))); }
fn sat(c: vec3<f32>) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
// Scale so the max channel becomes `s`, the mid proportional, the min 0 (matches W3C SetSat).
fn set_sat(c: vec3<f32>, s: f32) -> vec3<f32> {
    let mn = min(c.r, min(c.g, c.b));
    let mx = max(c.r, max(c.g, c.b));
    let range = mx - mn;
    return select(vec3<f32>(0.0), (c - mn) / range * s, range > 1e-6);
}

fn mix_blend(cb: vec3<f32>, cs: vec3<f32>, mode: u32) -> vec3<f32> {
    switch mode {
        case 1u: { return cb * cs; }
        case 2u: { return cb + cs - cb * cs; }
        case 3u: { return f_overlay(cb, cs); }
        case 4u: { return min(cb, cs); }
        case 5u: { return max(cb, cs); }
        case 6u: { return f_dodge(cb, cs); }
        case 7u: { return f_burn(cb, cs); }
        case 8u: { return f_hardlight(cb, cs); }
        case 9u: { return f_softlight(cb, cs); }
        case 10u: { return abs(cb - cs); }
        case 11u: { return cb + cs - 2.0 * cb * cs; }
        case 12u: { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }
        case 13u: { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }
        case 14u: { return set_lum(cs, lum(cb)); }
        case 15u: { return set_lum(cb, lum(cs)); }
        default: { return cs; }
    }
}

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) src_uv: vec2<f32>,
    @location(1) bg_uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    var out: VSOut;
    out.pos = vec4<f32>(mix(p.dst_min, p.dst_max, corner), 0.0, 1.0);
    out.src_uv = mix(p.uv_min, p.uv_max, corner);
    out.bg_uv = mix(p.bg_min, p.bg_max, corner);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    // Premultiplied source (with layer opacity folded in) and premultiplied backdrop copy.
    let sp = textureSample(src_tex, samp, in.src_uv) * p.alpha;
    let bp = textureSample(bg_tex, samp, in.bg_uv);
    let sa = sp.a;
    let ba = bp.a;
    let cs = select(vec3<f32>(0.0), sp.rgb / sa, sa > 0.0);
    let cb = select(vec3<f32>(0.0), bp.rgb / ba, ba > 0.0);
    let b = mix_blend(cb, cs, p.mix);
    // W3C source-over with blend: premultiplied result color + output alpha.
    let co = sa * ((1.0 - ba) * cs + ba * b) + (1.0 - sa) * ba * cb;
    let ao = sa + ba * (1.0 - sa);
    return vec4<f32>(co, ao);
}
"#;
