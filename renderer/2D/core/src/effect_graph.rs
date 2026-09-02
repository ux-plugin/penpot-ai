//! Backend-neutral **effect-graph description** (the orchestration half of GPU effects).
//!
//! An effect is a *sequence of full-screen passes over textures*: each reads some inputs plus a
//! uniform and writes one texture, later passes chaining off earlier ones. Background blur and glass
//! differ only in *which* passes and *what* uniforms — the data, not the control flow. That data is
//! pure arithmetic (rounded-box SDF geometry → a refraction uniform, a radius → a device sigma) with
//! no GPU in it, so the *description* lives here and every backend shares it; only *executing* a pass
//! (compiling a pipeline, encoding a draw) is backend wgpu.
//!
//! The backend consumes a `Vec<`[`GraphPass`]`>` and runs each [`EffectPass`] on its own pipelines.

use kurbo::{Affine, Point};

use crate::blur::radius_to_sigma;
use crate::model::Glass;

/// Where a pass reads a texture from: a graph-level input, or an earlier pass's output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Src {
    /// Index into the `inputs` the backend runs the graph with (e.g. the assembled backdrop).
    Input(usize),
    /// Index into the outputs produced so far (0 = the first pass's result).
    Pass(usize),
}

/// One effect pass, backend-neutral: the pipeline it selects and the uniform it carries. Adding a
/// kind here is the only change needed to teach every backend a new effect (except `Custom`, whose
/// pipeline the backend resolves).
#[derive(Debug, Clone, PartialEq)]
pub enum EffectPass {
    /// A full 2D Gaussian of `sigma` device pixels over its 1 input. `linear` blurs in linear light
    /// (sRGB-decode taps, re-encode the result) for a faithful, brighter mix — used by the background
    /// blur; glass keeps `false` so its frost matches the gamma-space convention.
    Blur { sigma: f32, linear: bool },
    /// One **unit** over the running value, parameterised by a field rather than by any particular
    /// effect. `field` is the [`crate::field::FieldProgram`] whose named outputs the unit reads
    /// (`displacement`, `mask`, `specular`, …) and `u` is the uniform its [`crate::field::Slot`]s
    /// index into. Two units of the same kind differ only in those two, which is what lets a lens,
    /// a bevel and a noise warp all lower to the same pass kind.
    ///
    /// The uniform is per-pass rather than shared because [`apply_chain_scales`] rewrites it into
    /// each pass's own texel space; the *program* is shared, because structure is scale-free.
    Unit {
        op: UnitKind,
        field: std::rc::Rc<crate::field::FieldProgram>,
        u: Vec<f32>,
        /// How far this unit reads off its own pixel, in the pass's own device pixels. Carried here
        /// rather than re-derived from `u`, because only the effect that built the uniform knows
        /// which slot holds a displacement magnitude — the same index means something different in
        /// every program.
        reach: f32,
    },
}

/// What a [`EffectPass::Unit`] does with the value it is given. Each is a generic operation on a
/// colour and a field — none of them knows what effect it is serving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    /// Sample the input displaced by the field's `displacement` output, with a chromatic split.
    Warp,
    /// Sample the input jittered by noise, scaled by the field's scatter amount.
    Scatter,
    /// Add a lit term, weighted by the field's `specular` output.
    Shade,
    /// Lerp against a second input by the field's `mask` output.
    MaskMix,
    /// Multiply by the input's own alpha at the **undisplaced** pixel, confining a displaced result
    /// to the silhouette it started from. The counterpart to [`UnitKind::Warp`]: any displacement
    /// that must not bleed past its original coverage ends with this.
    ClipToSource,
    /// Erase by a second input's alpha (`DestOut`) — what survives where the other input is not.
    EraseBy,
    /// Multiply a coverage silhouette by a straight colour (colour × coverage — the in-register
    /// form of the `COLOUR_OVER` composite). Colouring in a shader rather than at raster time is
    /// what lets one rasterised silhouette serve shadows of different colours. Distinct from
    /// fine's TINT bit, which is a content-recolouring wash.
    Colour,
}

/// A pass plus the texture reads it binds, in the order the pipeline expects.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphPass {
    pub pass: EffectPass,
    pub inputs: Vec<Src>,
    /// The device-resolution fraction `k ∈ (0, 1]` this pass renders at — its target is `k×` the full
    /// size and the reader upscales. `1.0` = native. The chain solver assigns it from the detail
    /// available at this point (a blur upstream lowers it for free); the backend allocates this pass's
    /// target at `scale` and downscale-resamples only where consecutive passes differ. Defaults to
    /// `1.0` so a graph built without the solver is bit-for-bit the uniform-native render.
    pub scale: f32,
}

impl GraphPass {
    /// A pass at native scale. Public because a chain is also built OUTSIDE this module — a body's
    /// custom-shader chain is assembled where the shape's ops are in hand.
    #[must_use]
    pub fn new(pass: EffectPass, inputs: Vec<Src>) -> Self {
        Self { pass, inputs, scale: 1.0 }
    }
}

/// Target dimension of a pass rendering at `scale` of a `d`-texel surface — the one formula the
/// builder (uniform resolution) and the executor (texture allocation) must share, or a pass's
/// declared resolution drifts a texel from its actual target.
#[must_use]
pub fn pass_dim(d: u32, scale: f32) -> u32 {
    ((f64::from(d) * f64::from(scale)).round() as u32).max(1)
}

/// Assign the optimal-chain render scales ([`crate::footprint::chain_scales`]) to a built graph and
/// rewrite each scaled pass into its own texel space: the texel-linear field entries (resolution,
/// centre, half-extents, corner, bezel, scale factor) multiply by the pass scale, and a blur's sigma
/// shrinks with its target. Scales are relative to the surface the graph was built for, so a graph
/// whose passes all stay at `1.0` is bit-for-bit the uniform render.
///
/// Passes that lower into ONE materialised pass ([`crate::footprint::execution_groups`]) share the
/// group's output scale — a fused run has a single render target, so its members cannot render at
/// different resolutions; the group takes its last pass's solved scale (its actual output).
fn apply_chain_scales(passes: &mut [GraphPass], w: u32, h: u32) {
    let mut scales = crate::footprint::chain_scales(passes, 1.0, 1.0);
    for group in crate::footprint::execution_groups(passes) {
        let Some(&last) = group.last() else { continue };
        for &i in &group {
            scales[i] = scales[last];
        }
    }
    for (gp, sc) in passes.iter_mut().zip(scales) {
        gp.scale = sc;
        if sc >= 0.999 {
            continue;
        }
        match &mut gp.pass {
            EffectPass::Blur { sigma, .. } => *sigma *= sc,
            EffectPass::Unit { u, reach, .. } => {
                u[0] = pass_dim(w, sc) as f32;
                u[1] = pass_dim(h, sc) as f32;
                for i in [2, 3, 4, 5, 6, 8, 16] {
                    u[i] *= sc;
                }
                // The reach is in this pass's own pixels, so it shrinks with the pass.
                *reach *= sc;
            }
        }
    }
}

/// The background-blur graph: one 2D Gaussian over the assembled backdrop (input 0). Its result is
/// what the backend stamps through the shape's silhouette mask.
#[must_use]
pub fn background_blur_graph(sigma: f32) -> Vec<GraphPass> {
    vec![GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![Src::Input(0)])]
}

/// The device-space Gaussian sigma for a background blur: the shape's page-space `radius` mapped
/// through the *effective* device scale (`zoom · k`). Using the capped scale is what makes the
/// reduced-resolution backdrop's blur reach fit one tile (`3σ_device ≤ TILE_SIZE` by construction of
/// `k`). `scale` is the effective device scale the backend computes from its view and cap factor.
#[must_use]
pub fn background_blur_sigma(radius: f32, scale: f32) -> f32 {
    radius_to_sigma(radius) * scale
}

/// A **drop shadow** from an already-rasterised coverage silhouette: tint it, then blur it. The
/// tint is pointwise so it fuses into the blur's own pass rather than costing one.
///
/// `colour` is straight (non-premultiplied) RGBA. `sigma` of zero means a hard shadow and emits no
/// blur at all.
#[must_use]
#[cfg(test)]
pub fn colour_graph(w: f32, h: f32, colour: [f32; 4]) -> Vec<GraphPass> {
    vec![GraphPass::new(colour_unit(w, h, colour), vec![Src::Input(0)])]
}


#[must_use]
#[cfg(test)]
pub fn drop_shadow_graph(w: f32, h: f32, colour: [f32; 4], sigma: f32) -> Vec<GraphPass> {
    let mut passes = colour_graph(w, h, colour);
    if sigma > 0.5 {
        passes.push(GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![Src::Pass(0)]));
    }
    passes
}

/// An **inner shadow** band: the shape's own silhouette (input 0) with its offset, blurred copy
/// (input 1) cut out of it, leaving colour only on the offset side.
///
/// Both inputs arrive as coverage; the tint colours the band before the punch is removed, so the
/// erase sees the same alpha either way.
#[must_use]
#[cfg(test)]
pub fn inner_shadow_graph(w: f32, h: f32, colour: [f32; 4], sigma: f32) -> Vec<GraphPass> {
    let mut passes = Vec::new();
    let punch = if sigma > 0.5 {
        passes.push(GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![Src::Input(1)]));
        Src::Pass(0)
    } else {
        Src::Input(1)
    };
    let band = passes.len();
    passes.push(GraphPass::new(colour_unit(w, h, colour), vec![Src::Input(0)]));
    passes.push(GraphPass::new(
        unit_pass(UnitKind::EraseBy, w, h, colour),
        vec![Src::Pass(band), punch],
    ));
    passes
}

#[cfg(test)]
pub(crate) fn colour_unit(w: f32, h: f32, colour: [f32; 4]) -> EffectPass {
    unit_pass(UnitKind::Colour, w, h, colour)
}

/// A shadow unit's uniform: resolution in slot 0, the straight colour in vec4 slot 3
/// (`fieldU(gi, 3u)` = u[12..16] — none of which the scale solver multiplies, because a colour is
/// not a length). Shadows measure no field, so the program is empty and `computeField` degenerates to
/// full coverage.
#[cfg(test)]
pub(crate) fn unit_pass(op: UnitKind, w: f32, h: f32, colour: [f32; 4]) -> EffectPass {
    let mut u = vec![0.0_f32; 24];
    u[0] = w;
    u[1] = h;
    u[12..16].copy_from_slice(&colour);
    u[16] = 1.0;
    EffectPass::Unit {
        op,
        field: std::rc::Rc::new(crate::field::FieldProgram { nodes: Vec::new(), outputs: Vec::new() }),
        u,
        reach: 0.0,
    }
}

/// The **radial** falloff field: specular and mask fade linearly from 1 at the circle's centre
/// (`u[0].zw`) to 0 at its radius (`u[1].x`) — what a background field-tint's gradient measures.
/// A circle distance plus the ordinary inward [`crate::field::FieldOp::Ramp`]: `-(d - R)/r` with
/// `R = max(r, 1)` is `clamp(1 - length/r, 0, 1)` for any real radius, and the sub-pixel clamp in
/// the source keeps a degenerate radius from dividing by zero.
#[must_use]
pub fn radial_field_program() -> crate::field::FieldProgram {
    use crate::field::{FieldOp, FieldRef, FieldSource, Slot, Slot2};
    crate::field::FieldProgram {
        nodes: vec![
            FieldOp::Distance(FieldSource::Circle {
                centre: Slot2::new(0, 2),
                radius: Slot::new(1, 0),
            }),
            FieldOp::Ramp { d: FieldRef::Node(0), edge: Slot::new(1, 0), clamp_edge_to_extent: false },
        ],
        outputs: vec![("specular", FieldRef::Node(1)), ("mask", FieldRef::Node(1))],
    }
}

/// The **texture** effect's field: fractal noise, read as a centred displacement. It measures no
/// distance and so declares no source — the operators are the whole program.
#[must_use]
pub fn texture_field_program() -> crate::field::FieldProgram {
    use crate::field::{FieldOp, FieldRef, Slot};
    crate::field::FieldProgram {
        nodes: vec![
            FieldOp::Noise { div: Slot::new(0, 3) },
            FieldOp::Displacement { source: FieldRef::Node(0), gain: Slot::new(0, 2) },
        ],
        outputs: vec![("displacement", FieldRef::Node(1))],
    }
}

/// The **texture** effect as units: warp the body by a noise displacement, then optionally confine
/// the result to the coverage it started from. The two fuse into one materialised pass — the warp is
/// a sampling head and the clip is pointwise — so this costs exactly what the hand-written shader it
/// replaces did.
///
/// `magnitude` is the maximum per-axis shift in device pixels and doubles as the pass's reach;
/// `grain_div` divides the sample position, so a larger value is a coarser grain.
#[must_use]
pub fn texture_graph(w: f32, h: f32, magnitude: f32, grain_div: f32, clip_to_shape: bool) -> Vec<GraphPass> {
    let program = std::rc::Rc::new(texture_field_program());
    let mut u = vec![0.0_f32; 24];
    u[0] = w;
    u[1] = h;
    u[2] = magnitude;
    u[3] = grain_div;
    // Slot 21, not one of the slots the scale solver multiplies — a flag is not a length.
    u[21] = f32::from(u8::from(clip_to_shape));
    u[16] = 1.0;
    let unit = |op: UnitKind, reach: f32| EffectPass::Unit {
        op,
        field: program.clone(),
        u: u.clone(),
        reach,
    };
    vec![
        GraphPass::new(unit(UnitKind::Warp, magnitude), vec![Src::Input(0)]),
        GraphPass::new(unit(UnitKind::ClipToSource, 0.0), vec![Src::Pass(0)]),
    ]
}

/// Geometry of the glass shape, in **page space**, the way the backend reads it off the node. The
/// builder maps it into the reduced backdrop's device space itself.
#[derive(Debug, Clone, Copy)]
pub struct LensGeometry {
    /// Shape centre in page space.
    pub center: Point,
    /// Shape width/height in page space.
    pub width: f64,
    pub height: f64,
    /// Corner radius in page space (ignored when `is_circle`).
    pub corner_radius: f64,
    /// A circle clamps the corner to the min half-extent (a full round).
    pub is_circle: bool,
}

/// Build the glass pass-graph over the assembled backdrop (input 0) as a chain of generic units:
/// warp → optional blur → scatter → shade → mask-mix. The footprint partition decides what
/// materialises: sharp glass fuses the whole chain into one pass, frost bars the scatter (which then
/// absorbs its pointwise tail), a blur always stands alone.
///
/// All glass geometry (centre, half-extents, corner, device thresholds, blur sigma) is expressed in
/// the **reduced backdrop's** texel space — effective device scale `eff = zoom · k`, origin shifted
/// to the backdrop's top-left and scaled by `k` — so the SDF and refraction land pixel-correct at
/// whatever resolution the cap chose. `backdrop_size` is the reduced backdrop's `(w, h)` in texels,
/// `backdrop_origin` its top-left in **full-zoom** device pixels, `view` the page→device transform,
/// and `k ∈ (0, 1]` the resolution-cap factor. The composite's own SDF mask does the clip, so no
/// silhouette mask is needed. Ported verbatim from the sink so pixels are unchanged.
/// The device-space lens FIELD uniform (`6×vec4`, first 17 slots) for one glass, in the reduced
/// backdrop's texel space — the pure page→device projection of the rounded-box geometry (centre via
/// `view`, half-extents × `eff = zoom·k`, corner, bezel×s, thresholds), with slot 16 = the device
/// scale `s`. This is the ONLY non-trivial "baking" a unit needs; the per-unit trailing slots
/// (chromatic aberration 17, frost 18, specular 19/20) are added by the caller. `bake`/the scheduler
/// calls THIS to fill a lens unit's uniform, instead of building the whole pass chain to extract it.
/// The page-space lens geometry of a node — its glass params + the rounded box the field measures
/// against (centre, extents, corner in page units, scaled by the node's device scale for the corner).
/// Pure over `(node, modifier)`; the scheduler calls it to fill a glass unit's uniform. `None` unless
/// the node carries glass.
#[must_use]
pub fn lens_geometry(node: &crate::model::Node, modifier: Affine) -> Option<(Glass, LensGeometry)> {
    let g = node.glass?;
    let page = crate::schedule::page_bounds(node, modifier);
    let [a, b, c, d, _, _] = (modifier * node.effective_transform()).as_coeffs();
    let scale = ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0;
    let geom = LensGeometry {
        center: page.center(),
        width: page.width(),
        height: page.height(),
        corner_radius: node.corners.map_or(0.0, |r| r.top_left) * scale,
        is_circle: node.kind == crate::model::ShapeKind::Circle,
    };
    Some((g, geom))
}

#[must_use]
pub fn lens_device_field(
    g: &Glass,
    geom: LensGeometry,
    backdrop_size: (u32, u32),
    backdrop_origin: (f64, f64),
    view: Affine,
    k: f64,
) -> [f32; 24] {
    let (bw, bh) = backdrop_size;
    let (bdx, bdy) = backdrop_origin;
    let zoom = {
        let c = view.as_coeffs();
        (c[0] * c[0] + c[1] * c[1]).sqrt()
    };
    let eff = zoom * k;
    let dev_center = view * geom.center;
    let gcx = ((dev_center.x - bdx) * k) as f32;
    let gcy = ((dev_center.y - bdy) * k) as f32;
    let hx = (geom.width * 0.5 * eff) as f32;
    let hy = (geom.height * 0.5 * eff) as f32;
    let corner = if geom.is_circle { hx.min(hy) } else { (geom.corner_radius * eff) as f32 };
    let s = eff as f32;
    let (bwf, bhf) = (bw as f32, bh as f32);
    [
        bwf, bhf, gcx, gcy,
        hx, hy, corner, g.surface_type as f32,
        g.bezel_width * s, g.thickness, g.refractive_index, g.specular_angle,
        g.splay, g.tilt_angle, g.edge_boost, g.zoom,
        s, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
    ]
}

#[must_use]
pub fn lens_graph(
    g: &Glass,
    geom: LensGeometry,
    backdrop_size: (u32, u32),
    backdrop_origin: (f64, f64),
    view: Affine,
    k: f64,
) -> Vec<GraphPass> {
    let base_arr = lens_device_field(g, geom, backdrop_size, backdrop_origin, view, k);
    let s = base_arr[16];
    // One field program, shared by every unit of this lens; only the numbers differ per pass,
    // because the chain solver rewrites each pass into its own texel space.
    let program = std::rc::Rc::new(crate::vello::units::lens_field_program());
    let unit = |op: UnitKind, u: Vec<f32>, reach: f32| EffectPass::Unit {
        op,
        field: program.clone(),
        u,
        reach,
    };
    let base = base_arr.to_vec();
    let mut warp_u = base.clone();
    warp_u[17] = g.chromatic_aberration;
    let mut scatter_u = base.clone();
    scatter_u[18] = g.frost;
    let mut shade_u = base.clone();
    shade_u[19] = g.specular_opacity;
    shade_u[20] = g.specular_saturation;

    let mut passes = vec![GraphPass::new(unit(UnitKind::Warp, warp_u, 0.0), vec![Src::Input(0)])];
    let sigma = g.total_blur_sigma() * s;
    let blurred = if sigma > 0.5 {
        passes.push(GraphPass::new(EffectPass::Blur { sigma, linear: false }, vec![Src::Pass(0)]));
        Src::Pass(1)
    } else {
        Src::Pass(0)
    };
    passes.push(GraphPass::new(unit(UnitKind::Scatter, scatter_u, if g.frost > 0.01 { g.frost * 6.0 * s } else { 0.0 }), vec![blurred]));
    let prev = passes.len() - 1;
    passes.push(GraphPass::new(unit(UnitKind::Shade, shade_u, 0.0), vec![Src::Pass(prev)]));
    passes.push(GraphPass::new(
        unit(UnitKind::MaskMix, base, 0.0),
        vec![Src::Pass(prev + 1), Src::Input(0)],
    ));
    passes
}

/// [`lens_graph`] with the optimal-chain render scales applied — the variant the sinks execute.
/// The pure builder stays scale-free so footprint analysis and tests see the un-mutated pipeline.
#[must_use]
pub fn lens_graph_scaled(
    g: &Glass,
    geom: LensGeometry,
    backdrop_size: (u32, u32),
    backdrop_origin: (f64, f64),
    view: Affine,
    k: f64,
) -> Vec<GraphPass> {
    let mut passes = lens_graph(g, geom, backdrop_size, backdrop_origin, view, k);
    apply_chain_scales(&mut passes, backdrop_size.0, backdrop_size.1);
    passes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glass() -> Glass {
        Glass {
            surface_type: 1,
            bezel_width: 10.0,
            thickness: 1.0,
            refractive_index: 1.5,
            specular_angle: 0.0,
            specular_opacity: 0.5,
            specular_saturation: 1.0,
            chromatic_aberration: 0.2,
            splay: 0.0,
            tilt_angle: 0.0,
            edge_boost: 0.0,
            zoom: 1.0,
            blur: 0.0,
            frost: 0.0,
            acceptable_downscale: 1.0,
            tile_mode: crate::model::TileMode::Decal,
        }
    }

    #[test]
    fn background_blur_graph_is_one_pass_over_the_backdrop() {
        let g = background_blur_graph(4.0);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0], GraphPass::new(EffectPass::Blur { sigma: 4.0, linear: true }, vec![Src::Input(0)]));
    }

    #[test]
    fn sigma_scales_the_page_radius_by_the_effective_device_scale() {
        let a = background_blur_sigma(12.0, 1.0);
        let b = background_blur_sigma(12.0, 2.0);
        assert!((b - 2.0 * a).abs() < 1e-6);
    }

    #[test]
    fn glass_is_a_unit_chain_with_an_optional_blur() {
        let geom = LensGeometry { center: Point::new(50.0, 50.0), width: 80.0, height: 60.0, corner_radius: 10.0, is_circle: false };
        let sharp = lens_graph(&glass(), geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        assert_eq!(sharp.len(), 4);
        let kinds: Vec<UnitKind> = sharp
            .iter()
            .filter_map(|p| match p.pass {
                EffectPass::Unit { op, .. } => Some(op),
                _ => None,
            })
            .collect();
        assert_eq!(kinds, vec![UnitKind::Warp, UnitKind::Scatter, UnitKind::Shade, UnitKind::MaskMix]);
        // Every unit of the lens shares ONE field program — the structure is scale-free, so only
        // the numbers differ per pass.
        let progs: Vec<*const crate::field::FieldProgram> = sharp
            .iter()
            .filter_map(|p| match &p.pass {
                EffectPass::Unit { field, .. } => Some(std::rc::Rc::as_ptr(field)),
                _ => None,
            })
            .collect();
        assert!(progs.windows(2).all(|w| w[0] == w[1]), "one field program per lens");
        assert_eq!(sharp[3].inputs, vec![Src::Pass(2), Src::Input(0)]);
        let mut frosted = glass();
        frosted.frost = 1.0;
        let g = lens_graph(&frosted, geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        assert_eq!(g.len(), 5);
        assert!(matches!(g[1].pass, EffectPass::Blur { .. }));
        assert_eq!(g[2].inputs[0], Src::Pass(1));
    }

    #[test]
    fn a_circle_clamps_the_corner_to_the_min_half_extent() {
        let geom = LensGeometry { center: Point::new(0.0, 0.0), width: 80.0, height: 60.0, corner_radius: 999.0, is_circle: true };
        let g = lens_graph(&glass(), geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let EffectPass::Unit { ref u, op: UnitKind::Warp, .. } = g[0].pass else { panic!("expected warp") };
        assert!((u[6] - 30.0).abs() < 1e-4);
    }

    /// The whole point of making the clip a unit rather than a flag on the warp: it is pointwise, so
    /// it rides in the warp's own pass. Two units, one draw — the same cost as the shader it replaces.
    #[test]
    fn the_texture_effect_is_one_execution_group() {
        let g = texture_graph(256.0, 256.0, 30.0, 20.0, true);
        assert_eq!(g.len(), 2);
        let groups = crate::footprint::execution_groups(&g);
        assert_eq!(groups, vec![vec![0, 1]]);
    }

    /// A displacement magnitude is a length and must shrink with the pass; the clip flag is a boolean
    /// and must not. They are deliberately in different halves of the uniform for exactly this reason.
    #[test]
    fn the_scale_solver_moves_the_magnitude_and_leaves_the_flag() {
        let mut g = texture_graph(256.0, 256.0, 30.0, 20.0, true);
        apply_chain_scales(&mut g, 256, 256);
        for gp in &g {
            let EffectPass::Unit { u, .. } = &gp.pass else { panic!("units") };
            assert!((u[21] - 1.0).abs() < 1e-6, "the clip flag was scaled");
            assert!((u[2] / u[16] - 30.0).abs() < 1e-3, "magnitude and scale disagree");
        }
    }

    /// The texture field measures no distance, so it declares no source — and still compiles.
    #[test]
    fn the_texture_field_is_shapeless_and_declares_a_displacement() {
        let p = texture_field_program();
        // No source: a shapeless program emits no localPos prologue.
        assert!(!p.wgsl_prologue().contains("localPos"));
        assert!(p.declares("displacement"));
        assert!(!p.declares("refracted"), "a texture warp is not a lens");
        assert!(p.wgsl().contains("fractalNoise"));
    }
}
