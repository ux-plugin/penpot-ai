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
//! The one variant that can't be fully neutral is [`EffectPass::Custom`]: a hand-written WGSL pass is
//! tied to its compiled pipeline, so the IR carries only its uniform and the backend resolves the
//! shape's pipeline when it lowers the graph.

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
    /// Glass pass 1: rounded-box SDF → refraction field. 0 inputs (pure function of the uniform).
    GlassDisplacement { u: [f32; 20] },
    /// Glass pass 2: refraction + chromatic aberration. Inputs `[backdrop, displacement]`.
    GlassRefraction { u: [f32; 4] },
    /// Glass pass 4: frost / tint / specular composite. Inputs `[blurred, original, displacement]`.
    GlassComposite { u: [f32; 8] },
    /// A hand-written WGSL pass — the escape hatch. The IR carries only `u` (surface resolution +
    /// the shader's declared params); the backend supplies the compiled pipeline when it runs this.
    Custom { u: Vec<f32> },
}

/// A pass plus the texture reads it binds, in the order the pipeline expects.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphPass {
    pub pass: EffectPass,
    pub inputs: Vec<Src>,
}

impl GraphPass {
    fn new(pass: EffectPass, inputs: Vec<Src>) -> Self {
        Self { pass, inputs }
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

/// A single custom pass over the assembled backdrop (input 0). `u` is the backdrop resolution
/// followed by the shader's declared params; the backend pairs it with the shape's compiled pipeline.
#[must_use]
pub fn custom_graph(u: Vec<f32>) -> Vec<GraphPass> {
    vec![GraphPass::new(EffectPass::Custom { u }, vec![Src::Input(0)])]
}

/// Geometry of the glass shape, in **page space**, the way the backend reads it off the node. The
/// builder maps it into the reduced backdrop's device space itself.
#[derive(Debug, Clone, Copy)]
pub struct GlassGeometry {
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

/// Build the glass pass-graph over the assembled backdrop (input 0): displacement (pass 0) →
/// refraction (pass 1) → optional blur (pass 2) → composite (last).
///
/// All glass geometry (centre, half-extents, corner, device thresholds, blur sigma) is expressed in
/// the **reduced backdrop's** texel space — effective device scale `eff = zoom · k`, origin shifted
/// to the backdrop's top-left and scaled by `k` — so the SDF and refraction land pixel-correct at
/// whatever resolution the cap chose. `backdrop_size` is the reduced backdrop's `(w, h)` in texels,
/// `backdrop_origin` its top-left in **full-zoom** device pixels, `view` the page→device transform,
/// and `k ∈ (0, 1]` the resolution-cap factor. The composite's own SDF mask does the clip, so no
/// silhouette mask is needed. Ported verbatim from the sink so pixels are unchanged.
#[must_use]
pub fn glass_graph(
    g: &Glass,
    geom: GlassGeometry,
    backdrop_size: (u32, u32),
    backdrop_origin: (f64, f64),
    view: Affine,
    k: f64,
) -> Vec<GraphPass> {
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

    let disp_u: [f32; 20] = [
        bwf, bhf, gcx, gcy,
        // hx/hy/corner and the SDF `dist` all live in reduced-backdrop texels (scaled by `eff`), so
        // the bezel width — a page-space distance like the corner radius — must be scaled the same way.
        // Left raw, it mixes units with `dist` in `distFromBorder = -dist/bezel`, so the refraction band
        // (and the specular gaussian keyed off it) shifts as zoom changes `eff`.
        hx, hy, corner, g.surface_type as f32,
        g.bezel_width * s, g.thickness, g.refractive_index, g.specular_angle,
        g.splay, g.tilt_angle, g.edge_boost, g.zoom,
        s, 0.0, 0.0, 0.0,
    ];
    let refr_u: [f32; 4] = [bwf, bhf, g.chromatic_aberration, s];
    let comp_u: [f32; 8] = [bwf, bhf, g.frost, g.specular_opacity, g.specular_saturation, s, 0.0, 0.0];

    let mut passes = vec![
        GraphPass::new(EffectPass::GlassDisplacement { u: disp_u }, vec![]),
        GraphPass::new(EffectPass::GlassRefraction { u: refr_u }, vec![Src::Input(0), Src::Pass(0)]),
    ];
    // Glass blur (blur + frost softening) of the refracted image, when meaningful; otherwise the
    // composite reads the sharp refraction directly. One Blur pass = a full 2D Gaussian.
    let sigma = g.total_blur_sigma() * s;
    let blurred = if sigma > 0.5 {
        passes.push(GraphPass::new(EffectPass::Blur { sigma, linear: false }, vec![Src::Pass(1)]));
        Src::Pass(2)
    } else {
        Src::Pass(1)
    };
    passes.push(GraphPass::new(
        EffectPass::GlassComposite { u: comp_u },
        vec![blurred, Src::Input(0), Src::Pass(0)],
    ));
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
        // radius_to_sigma(r) * scale — at scale 2 the device sigma doubles.
        let a = background_blur_sigma(12.0, 1.0);
        let b = background_blur_sigma(12.0, 2.0);
        assert!((b - 2.0 * a).abs() < 1e-6);
    }

    #[test]
    fn glass_without_blur_is_three_passes_and_with_blur_is_four() {
        let geom = GlassGeometry { center: Point::new(50.0, 50.0), width: 80.0, height: 60.0, corner_radius: 10.0, is_circle: false };
        // frost 0 + blur 0 → total_blur_sigma 0 → no blur pass: displacement, refraction, composite.
        let sharp = glass_graph(&glass(), geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        assert_eq!(sharp.len(), 3);
        assert!(matches!(sharp[0].pass, EffectPass::GlassDisplacement { .. }));
        assert!(matches!(sharp[2].pass, EffectPass::GlassComposite { .. }));
        // A frosted glass adds the blur pass; the composite then reads Pass(2), not Pass(1).
        let mut frosted = glass();
        frosted.frost = 1.0; // total_blur_sigma = 8 · s > 0.5
        let g = glass_graph(&frosted, geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        assert_eq!(g.len(), 4);
        assert!(matches!(g[2].pass, EffectPass::Blur { .. }));
        assert_eq!(g[3].inputs[0], Src::Pass(2));
    }

    #[test]
    fn a_circle_clamps_the_corner_to_the_min_half_extent() {
        let geom = GlassGeometry { center: Point::new(0.0, 0.0), width: 80.0, height: 60.0, corner_radius: 999.0, is_circle: true };
        let g = glass_graph(&glass(), geom, (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let EffectPass::GlassDisplacement { u } = g[0].pass else { panic!("expected displacement") };
        // hx = 40, hy = 30 → corner = min(40,30) = 30, not the 999 radius.
        assert!((u[6] - 30.0).abs() < 1e-4);
    }
}
