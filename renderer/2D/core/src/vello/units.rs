//! Lens **unit** shaders — the fragment snippet library the effect executor composes into passes.
//!
//! Lens is not a shader here; it is a *graph of generic units* (see [`crate::effect_graph`]):
//! `warp → blur → scatter → shade → mask-mix`. The footprint partition decides which units share a
//! fragment (a gather head plus its pointwise tail), and [`UnitPipeline::units`] compiles ONE
//! pipeline per distinct composition from the snippet bodies below, cached by composition key. Sharp
//! lens (`warp+shade+mask-mix`, one draw, no intermediates) and the frosted composite
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

/// One operation in the frame — the SINGLE alphabet, shared by the scheduler and the executor. The
/// fragment units below (warp … custom) are what a fine arm runs, and several fuse into one fragment
/// ([`fuse`]); the three STRUCTURAL ops ([`UnitOp::Rasterize`]/[`UnitOp::Reload`]/[`UnitOp::Compose`])
/// are the plumbing the whole-frame DAG ([`crate::vello::frame_dag`]) needs to express dependency and
/// barrier structure — they are not fragment snippets and never enter `fuse`/`units()`. Keeping both
/// kinds in one enum is what lets the DAG node BE the operation the executor runs, with no separate
/// scheduler alphabet to translate through. For a fragment unit the discriminant selects its snippet
/// and the payload is the 20-float IR uniform it was declared with
/// ([`crate::effect_graph::EffectPass`] unit kinds).
/// Which separable axis a [`UnitOp::Blur`] pass runs. The X pass reads the blur's source; the Y pass
/// reads the X draft. Stamped at DAG build (the builder makes X then Y), so `bake` reads it off the op
/// instead of inferring it from "is my input another blur?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlurAxis {
    #[default]
    X,
    Y,
}

/// What a [`UnitOp::Blur`] finds beyond its source — the out-of-bounds tap behaviour, stamped at DAG
/// build from what the blur reads. `Coverage` = a shadow silhouette over transparency (OOB taps fade to
/// 0, the `SHADOW_EDGE` behaviour); `Backdrop` = the reloaded page or a warped backdrop (OOB taps are
/// the page). So `bake` reads it off the op instead of tracing the input chain to a `Rasterize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlurEdge {
    #[default]
    Backdrop,
    Coverage,
}

/// How a [`UnitOp::Compose`] lands its chain on the accumulator. A chain grown from the backdrop
/// (`Reload` root) mixes in under the effect's mask; one grown from the shape's own coverage
/// (`Rasterize` root — a shadow) IS a coverage, and its colour lays source-over the accumulator.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
pub enum ComposeMode {
    #[default]
    MaskedMix,
    Over,
}

/// What a [`UnitOp::Rasterize`] draws — the command's payload, stamped at DAG build exactly like a
/// blur's `axis`/`edge`, never re-derived downstream from the authored effect.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RasterSource {
    /// The shape's coverage silhouette, translated by `offset` (page units). `analytic` says the
    /// marker's own rasterised area reproduces this coverage per pixel (false for glyph coverage,
    /// whose marker area is only a box) — the flood-recovery fold keys on it.
    Coverage { offset: [f32; 2], analytic: bool },
    /// The shape's full painted body (fills/strokes/text), translated by `offset` (page units) —
    /// like `Coverage`, geometry ops bake into the rasterization rather than becoming units.
    Body { offset: [f32; 2] },
    /// A signed-distance field of the outline; `decode` is the encoded distance range in device
    /// pixels, stamped by the per-frame fill (it is view-dependent).
    Distance { decode: f32 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum UnitOp {
    /// STRUCTURAL: turn scene geometry into pixels — a plain-shape band, a shape body, a coverage
    /// silhouette, or a distance field, per its [`RasterSource`]. Not a fragment snippet; the scene
    /// rasterizer runs it. Whether it writes the spine or a scratch is the DAG node's `target`.
    Rasterize(RasterSource),
    /// STRUCTURAL: snapshot the accumulator so a gather can sample the composited backdrop. Its own
    /// barrier (the reload); not a fragment snippet.
    Reload,
    /// STRUCTURAL: land the chain's result on the accumulator (the spine write). WHERE it lands is
    /// z-order (the node's place on the spine); HOW it lands is the carried [`ComposeMode`], stamped
    /// at build from the effect's authored compose — never re-derived downstream. `colour` is the
    /// slot's folded Tint (normalization dissolves the Tint nodes into the compose that lands them).
    Compose { mode: ComposeMode, colour: Option<[f32; 4]> },
    /// Masked displaced sample + chromatic aberration (a composed pass's sampling head).
    Warp(Vec<f32>),
    /// Jittered sample (a composed pass's sampling head).
    Scatter(Vec<f32>),
    /// Pointwise lit term, weighted by the field's specular output.
    Shade(Vec<f32>),
    /// Pointwise final lerp against a second input by the field's mask output.
    MaskMix(Vec<f32>),
    /// Pointwise multiply by the input's alpha at the undisplaced pixel — confines a displaced
    /// result to the coverage it started from.
    ClipToSource(Vec<f32>),
    /// Pointwise erase by a second input's alpha (`DestOut`) — what is left of this input where the
    /// other one is not. The inner-shadow band is this applied to a silhouette and its blurred punch.
    EraseBy(Vec<f32>),
    /// The chain's straight-colour parameter. EXECUTED only by the über path (`units_body`), as a
    /// pointwise multiply that turns a coverage silhouette into a coloured one without
    /// re-rasterising the geometry (colour × coverage — the in-register form of `COLOUR_OVER`).
    /// On the whole-viewport path it never executes: normalization folds it into the slot's
    /// `Compose { colour }`. Distinct from fine's TINT bit, which is a content-recolouring WASH.
    Colour(Vec<f32>),
    /// A separable Gaussian of `sigma` device pixels — a NEIGHBORHOOD unit, so it is a fusion
    /// barrier: it reads the whole prior result and cannot share a fragment with the units after it.
    /// Runs as its own pass(es), never through `fs_uber`. `linear` blurs in linear light. `axis` is the
    /// separable pass (X reads the source, Y reads the X draft) and `edge` is the OOB behaviour
    /// (`Coverage` = a shadow silhouette, `Backdrop` = the page) — both stamped at build so `bake`
    /// serializes the op without re-deriving them from the graph.
    Blur { sigma: f32, linear: bool, axis: BlurAxis, edge: BlurEdge },
    /// STRUCTURAL: the ONE transport node (piece-graph law 2). Domain, side, density and address
    /// freedom in a single op — crop, combine, re-side, resample and preserve/snapshot are its
    /// arms, distinguished only by the node's rect/inputs/lease data, never by a kind tag. The
    /// node's `reach` is the destination window; its inputs are the source values assembled into
    /// one contiguous lease. The executor lowers it from the lease formats (an acc-format
    /// snapshot blit, an atlas-to-atlas draw); a ≤2:1 density crossing rides the consumer's
    /// bilinear taps instead of materializing a rung.
    Copy,
}

/// A composed pass's pipeline cache key. Named fields rather than a tuple: the composition grew
/// past the point where a positional index is readable, and one stale `key.3` silently selected the
/// wrong bind-group layout.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub(crate) struct UnitKey {
    /// Sampling head: 0 plain, 1 warp, 2 scatter.
    pub head: u8,
    pub shade: bool,
    pub maskmix: bool,
    pub clip: bool,
    pub erase: bool,
    pub colour: bool,
    /// Binds a second texture — the mask-mix backdrop or the erase punch.
    pub two_tex: bool,
}

pub struct UnitPipeline {
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

impl UnitPipeline {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let one_tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("unit layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        let two_tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("unit layout (original)"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2), texture_entry(3)],
        });

        let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("unit clamp-fill"),
            source: wgpu::ShaderSource::Wgsl(clamp_fill_shader().into()),
        });
        let clamp_fill = make_pipeline(device, "unit clamp fill", &clamp_shader, &one_tex_layout, format);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("unit sampler"),
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
            label: Some("unit clamp bind"),
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
            label: Some("unit uniform"),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }

    fn full_pass(encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, bind: &wgpu::BindGroup) {
        crate::vello::sink::note_passes(1);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("unit pass"),
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
        let key = UnitKey::from_ops(ops, original.is_some());
        if !self.units.borrow().contains_key(&key) {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("unit pass (composed)"),
                source: wgpu::ShaderSource::Wgsl(units_shader(key, field).into()),
            });
            let layout = if key.two_tex { &self.two_tex_layout } else { &self.one_tex_layout };
            let pipeline = make_pipeline(device, "unit pipeline", &module, layout, self.format);
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
            label: Some("unit bind"),
            layout: if key.two_tex { &self.two_tex_layout } else { &self.one_tex_layout },
            entries: &entries,
        });
        let cache = self.units.borrow();
        Self::full_pass(encoder, target, &cache[&key], &bind);
    }
}

impl UnitKey {
    /// Derive the pipeline key from a fused run's units: head from the first unit (warp/scatter/plain),
    /// one bit per pointwise unit present, and `two_tex` when a second texture is bound (a mask-mix
    /// backdrop or an erase punch). The ONE derivation the per-shape `units()` draw and the batched
    /// `arm_tag` both use, so a composition can never key one way for one path and another for the
    /// other.
    #[must_use]
    pub(crate) fn from_ops(ops: &[UnitOp], two_tex: bool) -> Self {
        UnitKey {
            head: match ops.first() {
                Some(UnitOp::Warp(_)) => 1,
                Some(UnitOp::Scatter(_)) => 2,
                _ => 0,
            },
            shade: ops.iter().any(|o| matches!(o, UnitOp::Shade(_))),
            maskmix: ops.iter().any(|o| matches!(o, UnitOp::MaskMix(_))),
            clip: ops.iter().any(|o| matches!(o, UnitOp::ClipToSource(_))),
            erase: ops.iter().any(|o| matches!(o, UnitOp::EraseBy(_))),
            colour: ops.iter().any(|o| matches!(o, UnitOp::Colour(_))),
            two_tex,
        }
    }
}

impl UnitOp {
    /// A NEIGHBORHOOD/GLOBAL unit — it reads past its own pixel of the *previous* result, so it
    /// cannot share a fragment with the units after it and forces a materialised pass. `Blur` (reads
    /// a neighborhood) is the barrier; every other unit fuses.
    #[must_use]
    pub fn is_barrier(&self) -> bool {
        matches!(self, UnitOp::Blur { .. })
    }

    /// A sampling head — it reads an *input texture* at an offset (its own pixel of the input, not the
    /// previous unit's output), so it can START a fused run and absorb a pointwise tail, but two heads
    /// cannot share one fragment.
    #[must_use]
    pub fn is_head(&self) -> bool {
        matches!(self, UnitOp::Warp(_) | UnitOp::Scatter(_))
    }

    /// STRUCTURAL plumbing (rasterize / reload / compose) rather than a fragment unit — the scheduler
    /// treats these as nodes but they never enter a fused fragment.
    #[must_use]
    pub fn is_structural(&self) -> bool {
        matches!(
            self,
            UnitOp::Rasterize(_) | UnitOp::Reload | UnitOp::Compose { .. } | UnitOp::Copy
        )
    }

    /// A gather reads its input at coordinates other than its own pixel (a neighbourhood or a
    /// displacement), so it can cross tiles — the property the DAG's barrier predicate turns on. A head
    /// (warp/scatter) or a barrier (blur) gathers; every other fragment unit is pointwise, and
    /// [`UnitOp::Reload`] is its own barrier handled separately.
    #[must_use]
    pub fn is_gather(&self) -> bool {
        self.is_head() || self.is_barrier()
    }
}

/// Cut an ordered unit chain into fused runs — the whole of "fusion", as a linear scan, no search.
/// A barrier ([`UnitOp::is_barrier`]) is its own run and materialises. A head ([`UnitOp::is_head`])
/// starts a run and absorbs the pointwise units after it into one fragment. Each returned run is one
/// [`crate::vello::fx::Op`]; a headless run is a plain pointwise stamp.
#[must_use]
pub fn fuse(units: Vec<UnitOp>) -> Vec<Vec<UnitOp>> {
    let mut runs: Vec<Vec<UnitOp>> = Vec::new();
    let mut cur: Vec<UnitOp> = Vec::new();
    for u in units {
        if u.is_barrier() {
            if !cur.is_empty() {
                runs.push(std::mem::take(&mut cur));
            }
            runs.push(vec![u]);
        } else if u.is_head() {
            if !cur.is_empty() {
                runs.push(std::mem::take(&mut cur));
            }
            cur.push(u);
        } else {
            cur.push(u);
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    runs
}

/// Assemble the composed 24-float uniform from the run's units: the field geometry (0..16) comes
/// from the head (every unit in a run carries the identically-scaled field), and each unit
/// contributes its own trailing params to the composed slots — `chromaticAberration` 17, `frost` 18,
/// `specularOpacity` 19, `specularSaturation` 20.
pub(crate) fn units_uniform(ops: &[UnitOp]) -> [f32; 24] {
    let mut out = [0.0_f32; 24];
    for op in ops {
        // Blur/Custom are barrier units — they never appear inside a fused run, so they carry no
        // field uniform to merge here.
        let (UnitOp::Warp(u) | UnitOp::Scatter(u) | UnitOp::Shade(u) | UnitOp::MaskMix(u)
        | UnitOp::ClipToSource(u) | UnitOp::EraseBy(u) | UnitOp::Colour(u)) = op
        else {
            continue;
        };
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
/// specular tint) is particular to lens, and the source is the single place a different geometry
/// would plug in.
///
/// Slots address the shared 24-float uniform: centre `0.zw`, half-extents `1.xy`, corner `1.z`,
/// profile kind `1.w`, bezel `2.x`, thickness `2.y`, index of refraction `2.z`, light angle `2.w`,
/// splay `3.x`, tilt `3.y`, edge boost `3.z`, zoom `3.w`, device scale `4.x`.
pub(crate) fn lens_field_program() -> crate::field::FieldProgram {
    use crate::field::{FieldSource, Slot, Slot2};
    lens_field_program_with(FieldSource::RoundedBox {
        centre: Slot2::new(0, 2),
        half: Slot2::new(1, 0),
        corner: Slot::new(1, 2),
    })
}

/// The shape-following lens: identical to [`lens_field_program`] except its distance comes from a
/// BAKED signed-distance field of the actual shape ([`FieldSource::Sampled`]) rather than the analytic
/// rounded box. `centre`/`half` still describe the bake's box, so every operator downstream — the ramp,
/// the refraction, the specular, the mask — follows the shape without a single change; `decode` reuses
/// the corner-radius slot (a sampled lens has no corner) to map the stored value back to device pixels.
#[cfg(test)]
pub(crate) fn lens_field_program_sampled() -> crate::field::FieldProgram {
    use crate::field::{FieldSource, Slot, Slot2};
    lens_field_program_with(FieldSource::Sampled {
        centre: Slot2::new(0, 2),
        half: Slot2::new(1, 0),
        decode: Slot::new(1, 2),
    })
}

/// The lens field program parameterised over its distance SOURCE — the one line that decides whether
/// the lens is a rectangle (analytic) or the shape (baked). Everything after the distance node is
/// source-agnostic, which is the whole point of factoring the source out of the units.
fn lens_field_program_with(source: crate::field::FieldSource) -> crate::field::FieldProgram {
    use crate::field::{FieldOp, FieldProgram, FieldRef, Slot, Slot2};
    FieldProgram {
        nodes: vec![
            FieldOp::Distance(source),
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
/// an outline uses — and only the lighting term below is particular to lens.
pub(crate) const UNIT_SPECULAR: &str = r#"
fn unitSpecular(t: f32, bezel: f32, lightAngle: f32, dir: vec2<f32>, scale: f32) -> f32 {
    if (t <= 0.0 || t >= 1.0) { return 0.0; }
    let band = fieldBand(t * bezel, 2.0 * scale, scale);
    let ld = vec2<f32>(cos(lightAngle), sin(lightAngle));
    var f = abs(dot(dir, ld));
    f = pow(f, 2.0);
    return band * f;
}
"#;

/// The lens-specific `computeField` assembly — edge boost, zoom, specular — over the outputs
/// [`lens_field_program`] declares. In `fieldU(gi, n)` slot form; [`super::fine_field`] re-emits it
/// through its dialect transform so fine's lens arm and the über lens stay one text.
pub(crate) const LENS_ASSEMBLY: &str = r#"    let bezel = min(fieldU(gi, 2u).x, min(fieldU(gi, 1u).x, fieldU(gi, 1u).y));
    var disp = refracted * scale;
    let edgeFade = pow(1.0 - edgeT, 1.5);
    disp = disp * (1.0 + fieldU(gi, 3u).z * edgeFade);
    var dpx = dir * disp;
    let zoomFactor = 1.0 / max(fieldU(gi, 3u).w, 0.1) - 1.0;
    dpx = dpx + localPos * zoomFactor;
    let specular = unitSpecular(edgeT, bezel, fieldU(gi, 2u).w, dir, scale);
    return vec4<f32>(dpx.x, dpx.y, specular, mask);
"#;

/// Pack a non-lens program's declared outputs as the `(displacement.xy, specular, mask)` field
/// vector, defaulting each undeclared component — no displacement, no shine, full coverage.
pub(crate) fn generic_field_pack(p: &crate::field::FieldProgram) -> String {
    format!(
        "    return vec4<f32>({d}.x, {d}.y, {s}, {m});\n",
        d = if p.declares("displacement") { "displacement" } else { "vec2<f32>(0.0)" },
        s = if p.declares("specular") { "specular" } else { "0.0" },
        m = if p.declares("mask") { "mask" } else { "1.0" },
    )
}

/// `computeField`, generated from [`lens_field_program`] plus the lens-specific assembly. The
/// early-out sits immediately after the distance so nothing beyond the shape is evaluated, which is
/// why the program is emitted in two runs rather than one.
pub(crate) fn field_prelude(p: &crate::field::FieldProgram) -> String {
    // A lens declares `refracted`, and only a lens wants the bezel/zoom/specular assembly. Any
    // other program — a procedural displacement, a stroke, a bevel — is packed straight from
    // whatever it says it produces, defaulting to no displacement and full coverage. This is the
    // seam that lets `computeField` serve a field with no shape at all.
    let tail = if p.declares("refracted") {
        LENS_ASSEMBLY.to_string()
    } else {
        generic_field_pack(p)
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
        spec = UNIT_SPECULAR,
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
/// - `fieldU(gi, i)`, `unitSample(gi, uv)`, `unitSampleOrig(gi, uv)` — the geometry accessors,
/// - `unitParam(gi, i)` — the *unit's own* parameters (a tint colour, an enable flag), which live in
///   the field uniform for a per-shape run but in the INSTANCE for a batched one, so a stamp can
///   carry its colour in 16 bytes instead of a 96-byte field entry it has no other use for,
/// and it leaves the result in `value`.
///
/// A composition that evaluates no field (a plain head with no shade and no mask-mix — every stamp)
/// omits the field preamble entirely, so it never touches the field buffer and a batched stamp can
/// bind the one-element placeholder.
///
/// `Colour` is self-disabling: a colour whose alpha is below zero leaves `value` where it was. One
/// arm therefore serves a coloured silhouette and an uncoloured body, which is what keeps the batch
/// from needing a second stamp pipeline for the shapes that carry no colour of their own. This is
/// the REPLACE (colour × coverage) op — deliberately not fine's TINT wash, which recolours content;
/// a wash here would bleed the silhouette's white into every shadow.
pub(crate) fn units_body(key: UnitKey, p: &crate::field::FieldProgram) -> String {
    let UnitKey { head, shade, maskmix, clip, erase, colour, .. } = key;
    let mut fs = String::new();
    if head != 0 || shade || maskmix {
        fs.push_str(
            r#"
    let resolution = fieldU(gi, 0u).xy;
    let scale = fieldU(gi, 4u).x;
    let field = computeField(gi, fc);
    let dpx = field.xy;
    let specular = field.b;
    let mask = field.a;
"#,
        );
    }
    let lens = p.declares("refracted");
    fs.push_str(match head {
        1 if !lens => r#"
    let dispUV = dpx / resolution;
    var value = unitSample(gi, uvpix + dispUV);
"#,
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
        unitSample(gi, refUV - caShift).r,
        unitSample(gi, refUV).g,
        unitSample(gi, refUV + caShift).b,
        unitSample(gi, refUV).a
    );
    let srcbg = unitSample(gi, uvpix);
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
            frostSum = frostSum + unitSample(gi, uvpix + off);
            totalW = totalW + 1.0;
        }
        value = frostSum / totalW;
    } else {
        value = unitSample(gi, uvpix);
    }
"#,
        _ => r#"
    var value = unitSample(gi, uvpix);
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
    if clip {
        fs.push_str(
            r#"
    let srcCoverage = unitSample(gi, uvpix).a;
    value = mix(value, value * srcCoverage, unitParam(gi, 5u).y);
"#,
        );
    }
    if colour {
        fs.push_str(
            r#"
    let unitColour = unitParam(gi, 3u);
    let coloured = vec4<f32>(unitColour.rgb * unitColour.a, unitColour.a) * value.a;
    value = mix(value, coloured, select(0.0, 1.0, unitColour.a >= 0.0));
"#,
        );
    }
    if erase {
        fs.push_str(
            r#"
    let punch = unitSampleOrig(gi, uvpix);
    value = value * (1.0 - punch.a * unitParam(gi, 3u).w);
"#,
        );
    }
    if maskmix {
        fs.push_str(
            r#"
    let bg = unitSampleOrig(gi, uvpix);
    value = vec4<f32>(mix(bg.rgb, value.rgb, mask), mix(bg.a, value.a, mask));
"#,
        );
    }
    fs
}

/// Whether a composition's head samples with a noise jitter — the one unit needing [`HASH_PRELUDE`].
pub(crate) fn needs_hash(key: UnitKey) -> bool {
    key.head == 2
}

/// Compose the per-shape fragment shader for one unit run: the shared [`units_body`] wired to a
/// dedicated source texture (and an `original` texture when a mask-mix reads a distinct backdrop),
/// with the field in a uniform (so `gi` is always `0u`).
fn units_shader(key: UnitKey, program: &crate::field::FieldProgram) -> String {
    let two_tex = key.two_tex;
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
fn unitParam(gi: u32, i: u32) -> vec4<f32> { return u[i]; }
fn unitSample(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(src, samp, uv); }
"#,
    );
    bindings.push_str(if two_tex {
        "fn unitSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(original, samp, uv); }\n"
    } else {
        "fn unitSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> { return textureSample(src, samp, uv); }\n"
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
        body = units_body(key, program)
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

#[cfg(test)]
mod fuse_tests {
    use super::{fuse, UnitOp};

    /// Dump the built-in field programs' WGSL (`computeField` + helpers) so they can be baked into
    /// fine.wgsl for effects-in-fine (Phase B). Run with `--ignored --nocapture`.
    #[test]
    #[ignore]
    fn dump_field_wgsl_for_fine() {
        let dir = "/private/tmp/claude-501/-Users-dhiat-coding-penpot-ai--claude-worktrees-ai-chat-feature-status-bbf703/50ceaa3f-c306-4ef6-83e9-0fe15d702017/scratchpad";
        let lens = super::field_prelude(&super::lens_field_program());
        let sampled = super::field_prelude(&super::lens_field_program_sampled());
        let texture = super::field_prelude(&crate::effect_graph::texture_field_program());
        std::fs::write(format!("{dir}/field_lens.wgsl"), &lens).unwrap();
        std::fs::write(format!("{dir}/field_lens_sampled.wgsl"), &sampled).unwrap();
        std::fs::write(format!("{dir}/field_texture.wgsl"), &texture).unwrap();
        eprintln!("lens={} bytes, sampled={} bytes, texture={} bytes", lens.len(), sampled.len(), texture.len());
    }

    /// The `Sampled` lens is a clean SOURCE substitution: its generated WGSL differs from the analytic
    /// lens ONLY in the `fieldDistance` body (formula vs texture read). Everything downstream — the ramp,
    /// refraction, specular, coverage, and the `computeField` assembly — is byte-identical, which is the
    /// whole promise of factoring the source out of the units.
    #[test]
    fn sampled_lens_differs_only_in_field_distance() {
        let analytic = super::field_prelude(&super::lens_field_program());
        let sampled = super::field_prelude(&super::lens_field_program_sampled());
        assert!(analytic.contains("sdfRoundedBox"), "analytic uses the rounded-box formula");
        assert!(!analytic.contains("textureSampleLevel(fieldTex"), "analytic reads no texture");
        assert!(sampled.contains("textureSampleLevel(fieldTex"), "sampled reads the baked field");
        assert!(!sampled.contains("sdfRoundedBox"), "sampled has no rounded-box formula");
        // `fn fieldRamp` is the first shared helper after the distance source; everything from there on
        // — the ramp, refraction, specular, coverage, and the whole `computeField` body (which calls
        // `fieldDistance` identically in both) — must be byte-for-byte the same.
        let tail = |w: &str| w.split("fn fieldRamp").nth(1).expect("prelude has fieldRamp").to_string();
        assert_eq!(tail(&analytic), tail(&sampled), "everything below the distance source is identical");
    }

    fn warp() -> UnitOp { UnitOp::Warp(vec![]) }
    fn scatter() -> UnitOp { UnitOp::Scatter(vec![]) }
    fn shade() -> UnitOp { UnitOp::Shade(vec![]) }
    fn maskmix() -> UnitOp { UnitOp::MaskMix(vec![]) }
    fn colour() -> UnitOp { UnitOp::Colour(vec![]) }
    fn blur() -> UnitOp { UnitOp::Blur { sigma: 4.0, linear: false, axis: Default::default(), edge: Default::default() } }

    /// Sharp glass — the scatter is dropped as identity at lower time, so `[Warp, Shade, MaskMix]`
    /// is one sampling head plus a pointwise tail: ONE fused op, no intermediate.
    #[test]
    fn sharp_glass_fuses_to_one_op() {
        let runs = fuse(vec![warp(), shade(), maskmix()]);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len(), 3);
    }

    /// Frosted glass — the blur is a barrier, so the chain splits into three ops: `[Warp]`, `[Blur]`,
    /// `[Scatter, Shade, MaskMix]`. Exactly today's per-round lens stages, derived from reach alone.
    #[test]
    fn frosted_glass_splits_into_three_ops_at_the_blur() {
        let runs = fuse(vec![warp(), blur(), scatter(), shade(), maskmix()]);
        assert_eq!(runs.len(), 3, "warp | blur | scatter+shade+maskmix");
        assert_eq!(runs[0].len(), 1, "the warp alone");
        assert!(runs[1][0].is_barrier(), "the blur is its own run");
        assert_eq!(runs[2].len(), 3, "scatter head + pointwise tail");
    }

    /// A headless pointwise chain — a plain tint stamp (a drop shadow with no blur) — is one op.
    #[test]
    fn a_pointwise_only_chain_is_one_stamp() {
        let runs = fuse(vec![colour()]);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len(), 1);
    }

    /// A drop shadow: tint then blur. The tint fuses into its own run, the blur is a barrier after —
    /// two ops. (The blur-less case is the stamp above.)
    #[test]
    fn a_blurred_drop_shadow_is_stamp_then_blur() {
        let runs = fuse(vec![colour(), blur()]);
        assert_eq!(runs.len(), 2);
        assert!(!runs[0][0].is_barrier());
        assert!(runs[1][0].is_barrier());
    }

    /// from_ops matches the batched arm derivation: sharp glass = warp head + shade + maskmix.
    #[test]
    fn from_ops_derives_the_composition_key() {
        use super::UnitKey;
        let k = UnitKey::from_ops(&[warp(), shade(), maskmix()], false);
        assert_eq!(k.head, 1);
        assert!(k.shade && k.maskmix);
        assert!(!k.colour && !k.clip && !k.erase);
        let stamp = UnitKey::from_ops(&[colour()], false);
        assert_eq!(stamp.head, 0);
        assert!(stamp.colour);
    }
}
