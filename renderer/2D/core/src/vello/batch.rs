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
//!
//! **One sampling convention.** The vertex stage hands every arm the fragment's position in the
//! CELL's normalised space, and nothing else — the atlas rect the cell happens to occupy is a
//! mapping the arm applies (`atlasUV`, and the samplers built on it), not a second meaning the same
//! varying carries in some arms. That is what lets the stamp and the inner-shadow band drop their
//! hand-written fragments and run [`super::units::units_body`] instead, the same text the per-shape
//! pipeline compiles: one `Tint`, one `EraseBy`, one place either can be wrong. Every batched cell
//! carries the same 24-float unit uniform the per-shape pipeline binds, indexed per instance, so a
//! unit is never expressible in one path and not the other.

/// Per-quad instance: destination rect in the target's NDC, source rect in the source's UV, the tap
/// clamp rect, and the blur parameters. `step` is the blur direction pre-divided by the source size
/// (a copy/composite instance leaves it unused); `src2`/`clamp2` are the second read the erase
/// stage takes (the punch). Layout matches the WGSL `Inst` struct: eleven `vec2<f32>`, then seven
/// `f32` — 120 bytes, align 8. Unit PARAMETERS are not here: they live in the stage's uniform array,
/// which `_pad[3]` indexes.
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
    /// Composite source select: 0 = the blurred atlas (`tex0`), 1 = the combined atlas (`tex1`,
    /// where the erase stage materialised inner-shadow bands). The lens stages reuse it as the
    /// instance's index into the field buffer.
    pub mode: f32,
    /// `[0]` = arm tag (see `fs_uber`); `[1]`/`[2]` = this instance's destination origin in target
    /// pixels, which the arms subtract from `@builtin(position)` to recover the cell-local fragment
    /// coordinate the unit bodies are expressed in; `[3]` = this instance's index into the stage's
    /// uniform array — where ALL of its unit parameters live.
    ///
    /// The parameters used to be a `tint` vec4 on the instance itself, which is why only the two
    /// units that read uniform slot 3 could ever run in a batch. A unit reading any other slot had
    /// nowhere to read it from, and that — not the two unit names — was the whitelist.
    pub _pad: [f32; 4],
}

/// One lens cell's field parameters — the same 24-float composed uniform the per-shape pipeline
/// binds ([`super::units`]), here indexed out of a storage array so every cell in a batched stage
/// carries its own. `align(16)` matches the WGSL `array<vec4<f32>, 6>` it maps to.
#[repr(C, align(16))]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct FieldUniform {
    pub u: [f32; 24],
}

/// Arm tags stamped into `Inst::_pad[0]`, selecting the arm `fs_uber` runs.
pub(crate) mod stage {
    /// The separable Gaussian. Not a unit arm — its own tap loop — so it keeps a fixed tag apart
    /// from the generated arm table.
    pub const BLUR: f32 = 2.0;
}

/// A pointwise composition, as the bits that pick its arm. One bit per unit that can appear in a
/// tail; the arm table is generated from these, so admitting a new pointwise unit is a bit here.
pub(crate) mod pointwise {
    pub const CLIP: u32 = 1;
    pub const ERASE: u32 = 2;
    pub const TINT: u32 = 4;
    /// How many pointwise combinations exist.
    pub const COUNT: u32 = 8;
}

/// Where the generated arm tags begin (past `stage::BLUR`).
const ARM_BASE: f32 = 8.0;

/// A pointwise `UnitKey` from its bits.
pub(crate) fn pw_key(bits: u32) -> crate::vello::units::UnitKey {
    crate::vello::units::UnitKey {
        clip: bits & pointwise::CLIP != 0,
        erase: bits & pointwise::ERASE != 0,
        tint: bits & pointwise::TINT != 0,
        two_tex: bits & pointwise::ERASE != 0,
        ..Default::default()
    }
}

/// The über-shader's arm table: one `UnitKey` per composition it can run, in tag order. There is no
/// entry for any NAMED effect — the pointwise combinations, then the sampling-head compositions a
/// lens uses. `fs_uber` dispatches by a composition's index here, so nothing is lens, warp or
/// frost to the executor; it is a composition-key and a tag.
pub(crate) fn arm_keys() -> Vec<crate::vello::units::UnitKey> {
    use crate::vello::units::UnitKey;
    let mut v: Vec<UnitKey> = (0..pointwise::COUNT).map(pw_key).collect();
    // Sampling-head compositions: a plain warp, a warp with shade+mask-mix, and a scatter tail with
    // shade+mask-mix over a second texture. These are the lens's, but the table does not say so.
    v.push(UnitKey { head: 1, ..Default::default() });
    v.push(UnitKey { head: 1, shade: true, maskmix: true, ..Default::default() });
    v.push(UnitKey { head: 2, shade: true, maskmix: true, two_tex: true, ..Default::default() });
    v
}

/// The tag that selects `key`'s arm — its index in [`arm_keys`], offset past the blur tag.
pub(crate) fn arm_tag(key: crate::vello::units::UnitKey) -> f32 {
    let i = arm_keys().iter().position(|k| *k == key).expect("every emitted key has an arm");
    ARM_BASE + i as f32
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
            mode: 0.0,
            _pad: [0.0; 4],
        }
    }

    /// The instance pointed at its entry in the stage's uniform array — where every unit in its
    /// chain reads its parameters. What lets one rasterised silhouette serve shadows of different
    /// colours, and what any future unit reads its own slots out of.
    pub fn with_units(mut self, index: usize) -> Self {
        self._pad[3] = index as f32;
        self
    }

    /// The instance tagged with its destination origin in target pixels — what the lens arms
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
    mode: f32,
    _p0: f32,
    _p1: f32,
    _p2: f32,
    _p3: f32,
};
@group(0) @binding(0) var<storage, read> insts: array<Inst>;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex2: texture_2d<f32>;

struct FieldUniform { u: array<vec4<f32>, 6> };
@group(0) @binding(4) var<storage, read> fields: array<FieldUniform>;

// The running instance's cell rects, published before a lens arm runs its shared unit body: the
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
/// The running instance, for the accessors that read its own rects rather than the field.
var<private> g_inst: u32;
/// Head reads take the *second* binding instead of the first — how a stamp selects the atlas the
/// erase stage materialised its band in, without the arm knowing which atlas that was. Per-instance
/// and therefore non-uniform, which is why every sample here is `textureSampleLevel`: an explicit
/// LOD is legal under non-uniform control flow where an implicit-derivative sample is not.
var<private> g_alt: bool;

fn fieldU(gi: u32, i: u32) -> vec4<f32> { return fields[gi].u[i]; }
/// A unit's own parameters — the same 24-float uniform the per-shape pipeline binds, indexed per
/// instance. One array for every arm: a stamp's parameters and a lens's live in the same place, so
/// no unit is expressible in one path and not the other.
fn unitParam(gi: u32, i: u32) -> vec4<f32> { return fields[gi].u[i]; }
/// The cell coordinate mapped onto the instance's rect in the atlas. Deliberately UNCLAMPED — the
/// blur adds its tap offset here and clamps once afterwards, and clamping twice would push a tap at
/// the rect's edge half a texel further than a dedicated texture's clamp-to-edge puts it.
fn atlasUV(uv: vec2<f32>) -> vec2<f32> {
    return mix(g_src_min, g_src_max, uv);
}
fn unitSample(gi: u32, uv: vec2<f32>) -> vec4<f32> {
    let a = clamp(atlasUV(uv), g_src_cmin, g_src_cmax);
    if (g_alt) { return textureSampleLevel(tex2, samp, a, 0.0); }
    return textureSampleLevel(tex, samp, a, 0.0);
}
fn unitSampleOrig(gi: u32, uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(tex2, samp, clamp(mix(g_orig_min, g_orig_max, uv), g_orig_cmin, g_orig_cmax), 0.0);
}
fn unitBegin(ii: u32, alt: bool) {
    let it = insts[ii];
    g_inst = ii;
    g_alt = alt;
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

/// `uv` is the fragment's position in the **cell's own normalised space** — 0..1 across the quad,
/// the one coordinate every unit body is written against. An arm that needs an atlas coordinate
/// derives it (`atlasUV`, or the samplers that call it); an arm that needs the cell's pixel
/// coordinate derives that too. One varying, one meaning.
struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) inst: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    let it = insts[ii];
    var out: VSOut;
    out.pos = vec4<f32>(mix(it.dst_min, it.dst_max, corner), 0.0, 1.0);
    out.uv = corner;
    out.inst = ii;
    return out;
}

fn blur_px(in: VSOut) -> vec4<f32> {
    let it = insts[in.inst];
    unitBegin(in.inst, false);
    let base = atlasUV(in.uv);
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
        let uv = clamp(base + it.step * fi, it.clamp_min, it.clamp_max);
        wsum = wsum + w;
        var s = textureSampleLevel(tex, samp, uv, 0.0);
        if (lin) { s = premul_srgb_to_lin(s); }
        sum = sum + s * w;
    }
    var outc = sum / wsum;
    if (lin) { outc = premul_lin_to_srgb(outc); }
    return outc;
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
/// per-shape chain. Blur cells, lens lenses and (next) distance-field bakes all reduce to this.
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
    pub fields: Vec<FieldUniform>,
    /// The field program whose pipeline this stage runs under. `None` is the lens program — what
    /// every stamp and lens stage uses today. A field-measuring non-lens effect sets its own, and
    /// the executor compiles a pipeline for it on demand. This is the per-cell field program the
    /// batch was missing: the uniform already travelled per cell, now the PROGRAM can too.
    pub program: Option<std::rc::Rc<crate::field::FieldProgram>>,
    /// Premultiplied `SrcOver` (a composite) rather than replace (a materialisation).
    pub blend: bool,
    /// Clear the target first — for a stage that owns its whole surface, where the packing's gaps
    /// must be transparent because the next stage's sampler grazes half a texel past each cell.
    pub clear: bool,
}

impl Stage {
    /// A materialising stage: replace, no clear, reading one surface.
    pub fn new(tag: f32, target: Surface, src: Surface, insts: Vec<Inst>) -> Self {
        Self { round: None, tag, target, src, src2: src, insts, fields: Vec::new(), program: None, blend: false, clear: false }
    }

    pub fn with_round(mut self, round: u32) -> Self {
        self.round = Some(round);
        self
    }

    pub fn with_fields(mut self, fields: Vec<FieldUniform>) -> Self {
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
    layout: wgpu::BindGroupLayout,
    pl: wgpu::PipelineLayout,
    format: wgpu::TextureFormat,
    srcover: wgpu::BlendState,
    /// One compiled `(replace, composite)` pair PER FIELD PROGRAM, built on demand and keyed by the
    /// program's structure. The über-shader bakes a program's `computeField`, so an effect measuring
    /// a different field is a different pipeline — the same way [`super::units::UnitPipeline`] keeps
    /// one pipeline per `UnitKey`. Lens is merely the first entry, not a hardwired baseline: adding
    /// a field-measuring effect to the batch is a new key here, not an edit to [`batch_shader`].
    variants: std::cell::RefCell<std::collections::HashMap<u64, Variant>>,
    /// The lens program's key, so the stamp and lens stages — which is everything today — resolve
    /// without rebuilding the program to hash it every frame.
    lens_key: u64,
    /// One-element placeholder bound at binding 4 by every stage that evaluates no per-cell field.
    no_fields: wgpu::Buffer,
}

/// The two pipelines one field program compiles to: a replace target (blur/combine/materialise) and
/// a premultiplied `SrcOver` composite. Both run `fs_uber` over the same über-shader.
struct Variant {
    replace: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
}

/// A stable key for a field program: its structure determines the generated shader, so two programs
/// that debug-print the same compile to the same pipeline. Cheap enough to hash per stage (the
/// program is a handful of nodes), and correct without a `Hash` impl the float-carrying ops cannot
/// derive.
fn program_key(program: &crate::field::FieldProgram) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{program:?}").hash(&mut h);
    h.finish()
}

/// Emit one arm: publish the instance's rects and parameters, recover the cell-local fragment
/// coordinate from the destination origin the instance carries, then run the SHARED unit body for
/// this composition ([`super::units::units_body`]) — the same text the per-shape pipeline compiles,
/// so a batched cell and a dedicated-texture cell execute identical math.
///
/// `alt` selects the second binding for the head's reads — how a pointwise arm picks up the band the
/// erase stage materialised in the other atlas. The lens arms pass `false`: their head reads the
/// backdrop crop and never the alternate.
///
/// `uvpix` is where the two conventions still meet. A stamp takes the interpolated cell coordinate
/// straight from the vertex stage — the single convention this arm set is built on. A lens arm
/// instead divides its recovered `fc` by the field's own resolution, because its sampling has to
/// land on exactly the pixel its field was evaluated at; routing it through the interpolator instead
/// moves 16 pixels of the `combined` and `matrix` fixtures by one last bit. Lens joins the shared
/// convention in phase 5, where the field evaluation moves with it.
fn unit_arm(name: &str, key: crate::vello::units::UnitKey, alt: &str, uvpix: &str, program: &crate::field::FieldProgram) -> String {
    format!(
        r#"
fn {name}(in: VSOut) -> vec4<f32> {{
    let it = insts[in.inst];
    unitBegin(in.inst, {alt});
    let gi = u32(it._p3);
    let fc = in.pos.xy - vec2<f32>(it._p1, it._p2);
    let uvpix = {uvpix};
{body}
    return value;
}}
"#,
        body = crate::vello::units::units_body(key, program)
    )
}

/// The whole batch module: the prelude, the lens arms generated from the shared unit bodies, and
/// the single `fs_uber` entry every stage dispatches through.
fn batch_shader(program: &crate::field::FieldProgram) -> String {
    let mut s = String::from(BATCH_PRELUDE);
    s.push_str(&crate::vello::units::field_prelude(program));
    if crate::vello::units::needs_hash(crate::vello::units::UnitKey { head: 2, ..Default::default() }) {
        s.push_str(crate::vello::units::HASH_PRELUDE);
    }
    // One arm per composition in the table — nothing hand-named. A key's head decides its two
    // conventions: a sampling head reads at the field's own resolution and never the alternate
    // texture; a pointwise (head 0) arm reads the interpolated cell coordinate and selects the
    // second texture by `mode`.
    const FIELD_UV: &str = "fc / fieldU(gi, 0u).xy";
    const CELL_UV: &str = "in.uv";
    for (i, key) in arm_keys().iter().enumerate() {
        let (alt, uv) = if key.head != 0 { ("false", FIELD_UV) } else { ("it.mode > 0.5", CELL_UV) };
        s.push_str(&unit_arm(&format!("arm{i}_px"), *key, alt, uv, program));
    }
    s.push_str(
        r#"
// Every kernel in ONE function behind a per-instance switch (`_p0` = the stage tag). Measured free
// on Apple (timing A/B vs specialised entries) and AMD (LLPC: 32 VGPRs = max of the arms, full
// occupancy, no spills) — and one function means a future wave pass draws mixed node kinds in a
// single instanced draw with no per-kind sorting.
@fragment
fn fs_uber(in: VSOut) -> @location(0) vec4<f32> {
    let stage = insts[in.inst]._p0;
    if (stage > 1.5 && stage < 2.5) {
        return blur_px(in);
    }
    switch (u32(stage) - 8u) {
        case 0u: { return arm0_px(in); }
        case 1u: { return arm1_px(in); }
        case 2u: { return arm2_px(in); }
        case 3u: { return arm3_px(in); }
        case 4u: { return arm4_px(in); }
        case 5u: { return arm5_px(in); }
        case 6u: { return arm6_px(in); }
        case 7u: { return arm7_px(in); }
        case 8u: { return arm8_px(in); }
        case 9u: { return arm9_px(in); }
        case 10u: { return arm10_px(in); }
        default: { return vec4<f32>(0.0); }
    }
}
"#,
    );
    s
}

impl BatchPipelines {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
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
            contents: bytemuck::cast_slice(&[FieldUniform { u: [0.0; 24] }]),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let this = Self {
            layout,
            pl,
            format,
            srcover,
            variants: std::cell::RefCell::new(std::collections::HashMap::new()),
            lens_key: program_key(&crate::vello::units::lens_field_program()),
            no_fields,
        };
        // Compile the lens variant up front — it is what every stage uses today, so building it now
        // keeps the first lens frame off the compile path and the behaviour identical to the single
        // pipeline this replaced.
        this.ensure_variant(device, &crate::vello::units::lens_field_program());
        this
    }

    /// The pipelines for `program`, compiled and cached on first use. Returns the program's key so a
    /// caller can look the pair back up without rehashing.
    fn ensure_variant(&self, device: &wgpu::Device, program: &crate::field::FieldProgram) -> u64 {
        let key = program_key(program);
        if self.variants.borrow().contains_key(&key) {
            return key;
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("wv batch"),
            source: wgpu::ShaderSource::Wgsl(batch_shader(program).into()),
        });
        let make = |blend: Option<wgpu::BlendState>, label: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&self.pl),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs"),
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs_uber"),
                    targets: &[Some(wgpu::ColorTargetState { format: self.format, blend, write_mask: wgpu::ColorWrites::ALL })],
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
        let variant = Variant {
            replace: make(None, "wv batch replace"),
            composite: make(Some(self.srcover), "wv batch composite"),
        };
        self.variants.borrow_mut().insert(key, variant);
        key
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

    /// [`Self::bind`] with an explicit field buffer — the lens stages' per-cell parameters. Every
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
        let key = stage
            .program
            .as_ref()
            .map_or(self.lens_key, |p| self.ensure_variant(device, p));
        let variants = self.variants.borrow();
        let variant = variants.get(&key).expect("a variant was ensured before this borrow");
        let pipeline = if stage.blend { &variant.composite } else { &variant.replace };
        crate::vello::sink::note_passes_of(crate::vello::sink::pass_kind::BATCH, 1);
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
        pass.set_pipeline(pipeline);
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

#[cfg(test)]
mod sampling_convention_tests {
    use super::batch_shader;
    use crate::vello::units::{lens_field_program, units_body, UnitKey};

    /// The stamp is not hand-written any more. Both of its lines have to be the ones `units_body`
    /// emits, because the moment they are typed out separately they start drifting from the unit the
    /// planner thinks it scheduled — which is exactly how the batch grew an `EraseBy` of its own.
    #[test]
    fn the_stamp_and_the_band_are_generated_from_the_shared_unit_bodies() {
        let s = batch_shader(&lens_field_program());
        for key in [
            UnitKey { tint: true, ..Default::default() },
            UnitKey { erase: true, two_tex: true, ..Default::default() },
        ] {
            let body = units_body(key, &lens_field_program());
            assert!(s.contains(body.trim_end()), "the batch module does not carry this unit body verbatim:\n{body}");
        }
    }

    /// One `EraseBy`, one implementation. The batch used to spell the same `flood × (1 − punch.a)`
    /// out in its own fragment, and the two drifted by 38 levels when the punch stopped being
    /// rasterised in the shadow's colour.
    ///
    /// The arm set is generated, so the math appears once per arm that declares the unit — never
    /// once more than that, which is what a hand-written copy would add.
    #[test]
    /// The batch is generic over the field program: a different program keys to a different
    /// pipeline and bakes a different `computeField`, which is what lets a field-measuring effect
    /// other than lens batch at all. Lens is one entry, not the baseline.
    #[test]
    fn a_second_field_program_is_a_distinct_variant() {
        use super::program_key;
        let lens = lens_field_program();
        let texture = crate::effect_graph::texture_field_program();
        assert_ne!(program_key(&lens), program_key(&texture), "two programs must not share a key");
        assert_ne!(
            batch_shader(&lens),
            batch_shader(&texture),
            "the über-shader must differ — each bakes its own computeField"
        );
        assert_eq!(program_key(&lens), program_key(&lens_field_program()), "the key is stable");
    }

    fn the_erase_math_appears_once_per_arm_that_declares_it() {
        let s = batch_shader(&lens_field_program());
        let arms = (0..super::pointwise::COUNT).filter(|b| b & super::pointwise::ERASE != 0).count();
        assert_eq!(s.matches("1.0 - punch.a").count(), arms, "the batch has an EraseBy of its own");
    }

    /// A stamp measures no field, so its body must not evaluate one — the batch compiles a single
    /// field program, and a chain that needs a different one declines in `batch_admit` rather than
    /// reading the wrong geometry here. Unit PARAMETERS are a separate thing and do come from the
    /// uniform array, which is why the assertion is about `computeField`, not about the buffer.
    #[test]
    fn a_stamp_reads_no_field() {
        let body = units_body(UnitKey { tint: true, ..Default::default() }, &lens_field_program());
        assert!(!body.contains("computeField"), "a stamp evaluated the field:\n{body}");
        assert!(!body.contains("fieldU("), "a stamp read the field uniform:\n{body}");
        assert!(body.contains("unitParam(gi, 3u)"), "a stamp's tint did not come from its instance:\n{body}");
    }

    /// The lens compositions still evaluate their field — the gate above must not have turned the
    /// preamble off for everyone.
    #[test]
    fn a_lens_still_evaluates_its_field() {
        let body = units_body(
            UnitKey { head: 1, shade: true, maskmix: true, ..Default::default() },
            &lens_field_program(),
        );
        assert!(body.contains("computeField(gi, fc)"), "the lens lost its field:\n{body}");
    }

    /// One meaning for the interpolated coordinate. The vertex stage hands every arm the CELL's
    /// normalised position; an arm that wants an atlas coordinate derives it through `atlasUV`, so
    /// no two arms can disagree about what `in.uv` is.
    #[test]
    fn the_vertex_stage_emits_the_cell_coordinate() {
        let s = batch_shader(&lens_field_program());
        assert!(s.contains("out.uv = corner;"), "the vertex stage no longer emits the cell coordinate");
        assert!(
            !s.contains("out.uv = mix(it.src_min, it.src_max, corner)"),
            "the vertex stage went back to emitting an atlas coordinate"
        );
    }

    /// `atlasUV` clamps nothing. The blur adds its tap offset to that base and clamps once; clamping
    /// inside would put an edge tap half a texel past where a dedicated texture's clamp-to-edge does.
    #[test]
    fn the_atlas_mapping_does_not_clamp() {
        let s = batch_shader(&lens_field_program());
        let f = s.split("fn atlasUV").nth(1).expect("atlasUV").split('}').next().expect("body");
        assert!(!f.contains("clamp("), "atlasUV clamps, which double-clamps every blur tap:\n{f}");
    }
}
