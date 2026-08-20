//! Footprint classification and the pass **partition** — the "compile the schedule" step.
//!
//! An effect is a chain of full-screen passes (see [`crate::effect_graph`]). The one property that
//! decides how that chain lowers is *where each pass reads*: a pass that reads its input at its own
//! pixel (or reads no texture at all) can be **fused** into its neighbours — evaluated inline, in
//! registers, with no intermediate texture — while a pass that reads a *neighbourhood* (a blur) must
//! **materialise** its input and output, forming a barrier between the fused runs on either side.
//!
//! In a pure pull model that read reach is the *whole* description. There is nothing to say about
//! writes: every pixel writes only itself, and a scatter's outward "spread" is just its read reach seen
//! from the output pixel (a shadow that reaches `r` out is an output pixel that reads `r` in). So the
//! classifier below carries reads, not writes, and [`partition`] turns a graph into `[Fused | Barrier |
//! …]` — the glass unit chain falls out as `[Fused(warp) | Barrier(blur) | Barrier(scatter) |
//! Fused(shade, mask-mix)]` when frosted, a single all-fused segment when sharp; [`execution_groups`]
//! then folds each gather-headed barrier together with its pointwise tail into one materialised pass.

use crate::effect_graph::{EffectPass, GraphPass, Src};

/// The spatial reach at which a pass reads its inputs — the single axis the schedule turns on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Reach {
    /// Reads no input texture — pure uniform + fragment coordinate (e.g. an SDF field). Always fuses.
    Procedural,
    /// Reads its input(s) at its own output coordinate. Fuses.
    SamePixel,
    /// Reads within `radius` device pixels of its output coordinate. Forces a barrier.
    Neighborhood(f32),
    /// Arbitrary / unbounded reads — the conservative fallback for unclassified custom code. Barrier.
    Global,
}

impl Reach {
    /// Same-pixel and procedural passes fuse into their neighbours; neighborhood/global do not.
    #[must_use]
    pub fn fuses(self) -> bool {
        matches!(self, Reach::Procedural | Reach::SamePixel)
    }
}

/// What the scheduler needs to know about one pass: whether it gathers the backdrop, and how far it
/// reads. In a pull model this is the complete description — there is no write side to declare.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FootprintDescriptor {
    /// Reads the assembled backdrop (binds a [`Src::Input`]) — i.e. this pass is a gather.
    pub reads_dst: bool,
    /// The spatial reach at which it reads its inputs.
    pub reach: Reach,
}

/// The read reach of a pass, purely from its kind. This classifier is what the whole schedule turns on.
#[must_use]
pub fn pass_reach(pass: &EffectPass) -> Reach {
    match pass {
        EffectPass::Blur { sigma, .. } => Reach::Neighborhood(3.0 * sigma),
        // A unit's reach follows its kind, not the effect it serves: only the jittered sample
        // reads off its own pixel, and only when the jitter is actually on.
        EffectPass::Unit { op: crate::effect_graph::UnitKind::Scatter, u, .. } => {
            let frost = u.get(18).copied().unwrap_or(0.0);
            if frost > 0.01 {
                Reach::Neighborhood(frost * 6.0 * u.get(16).copied().unwrap_or(1.0))
            } else {
                Reach::SamePixel
            }
        }
        EffectPass::Unit { .. } => Reach::SamePixel,
        EffectPass::Custom { .. } => Reach::Global,
    }
}

/// The footprint of one graph pass: `reach` from the pass kind, `reads_dst` from whether it binds the
/// assembled backdrop input.
#[must_use]
pub fn footprint(gp: &GraphPass) -> FootprintDescriptor {
    FootprintDescriptor {
        reads_dst: gp.inputs.iter().any(|s| matches!(s, Src::Input(_))),
        reach: pass_reach(&gp.pass),
    }
}

/// One scheduled stage: either a run of same-pixel/procedural passes fused into a single invocation (no
/// intermediate textures), or a lone neighborhood/global pass that must materialise its input and
/// output — a barrier between the fused runs on either side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage {
    /// Pass indices (into the graph) fused into one invocation, evaluated in order in registers.
    Fused(Vec<usize>),
    /// A single barrier pass index — it reads its input in a neighbourhood, so it can't be inlined.
    Barrier(usize),
}

/// Partition a pass-graph into fused segments separated by barriers, in pass order: same-pixel /
/// procedural passes accumulate into the current segment; a neighborhood / global pass closes it and
/// stands alone as a barrier. This *is* the schedule-compilation step.
#[must_use]
pub fn partition(graph: &[GraphPass]) -> Vec<Stage> {
    let mut stages = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    for (i, gp) in graph.iter().enumerate() {
        if pass_reach(&gp.pass).fuses() {
            cur.push(i);
        } else {
            if !cur.is_empty() {
                stages.push(Stage::Fused(std::mem::take(&mut cur)));
            }
            stages.push(Stage::Barrier(i));
        }
    }
    if !cur.is_empty() {
        stages.push(Stage::Fused(cur));
    }
    stages
}

/// The number of barrier (materialised) stages — the pass boundaries fusion could not remove.
#[must_use]
pub fn barrier_count(stages: &[Stage]) -> usize {
    stages.iter().filter(|s| matches!(s, Stage::Barrier(_))).count()
}

/// Whether a barrier pass can *head* a fused run: it samples its input in a neighbourhood but its
/// output is a plain per-pixel value, so any same-pixel passes that follow can execute in its own
/// fragment — a gather head with a pointwise tail. True for the unit gathers ([`EffectPass::Scatter`]);
/// false for a blur (its own multi-pass separable/pyramid machinery) and for opaque custom code.
#[must_use]
pub fn heads_a_run(pass: &EffectPass) -> bool {
    matches!(pass, EffectPass::Unit { op: crate::effect_graph::UnitKind::Scatter, .. })
}

/// Group the graph's passes into **execution groups** — the sets that lower into ONE materialised
/// pass each. A [`Stage::Fused`] run is one group; a [`Stage::Barrier`] that [`heads_a_run`] absorbs
/// the immediately following fused run into its group (gather head + pointwise tail, one fragment);
/// every other barrier stands alone. This is the single grouping rule shared by the scale assigner
/// ([`crate::effect_graph`]) and the backend lowerer, so a pass's assigned scale is always the scale
/// of the target it actually renders into.
#[must_use]
pub fn execution_groups(graph: &[GraphPass]) -> Vec<Vec<usize>> {
    let stages = partition(graph);
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut i = 0;
    while i < stages.len() {
        match &stages[i] {
            Stage::Fused(idxs) => {
                groups.push(idxs.clone());
                i += 1;
            }
            Stage::Barrier(bi) => {
                let mut group = vec![*bi];
                if heads_a_run(&graph[*bi].pass) {
                    if let Some(Stage::Fused(tail)) = stages.get(i + 1) {
                        group.extend(tail.iter().copied());
                        i += 1;
                    }
                }
                groups.push(group);
                i += 1;
            }
        }
    }
    groups
}

/// Smallest render scale a pass may drop to before the upscale artifacts show — a floor under the
/// band-limit so a huge blur can't shrink its input to a handful of texels.
const SCALE_FLOOR: f32 = 0.1;

/// The render scale at which a `Neighborhood(radius)` pass's output is faithfully captured. The
/// theoretical Nyquist bound is `2/radius`, but that renders a Gaussian at a reduced sigma of
/// ~0.67px — under-filtered enough that residual aliasing survives, and under a drag the crop
/// origin shifts the resample phase every frame, so the residue *shimmers* (visible as freckles
/// beneath a lightly-frosted lens). `3.75/radius` keeps the reduced sigma at ~1.25px, which
/// genuinely buries the energy above the reduced Nyquist; small blurs (σ ≲ 1.25) stay at native.
/// This is both the coarsest scale the pass itself renders at *and* the coarsest scale any pass
/// feeding it needs to supply. `SamePixel`/`Global` passes impose no limit and return `1.0`.
#[must_use]
fn pass_band_limit(pass: &EffectPass) -> f32 {
    match pass_reach(pass) {
        Reach::Neighborhood(radius) if radius > 0.0 => (3.75 / radius).clamp(SCALE_FLOOR, 1.0),
        _ => 1.0,
    }
}

/// The **optimal-chain render scale** for every pass of a graph: `scale[i] ∈ (0, 1]`, the fraction of
/// device resolution pass `i` should render at (its target is `k×`, the reader upscales). This is the
/// forward-running-min "detail decreases along a chain" rule expressed as a backward dataflow: a pass
/// renders only as fine as the coarsest thing its consumers need, capped by its own band-limit and by
/// the surface's `acceptable_downscale` (the declared quality floor) and `cap` (the memory/zoom ceiling).
///
/// - A `Neighborhood` consumer (a blur) only needs its input at its own band-limit, so every pass that
///   feeds *only* a blur — the blur and its refraction upstream — rides that low scale for free.
/// - The final output (a pass nothing else reads) is pinned to `min(acceptable_downscale, cap)`, keeping crisp
///   results (sharp glass, a magnifier) at native unless the author declared otherwise.
/// - A sharp chain (all same-pixel) collapses to a single uniform `min(acceptable_downscale, cap)` — bit-identical
///   to today's whole-graph scale, so nothing regresses.
///
/// `cap` and `acceptable_downscale` are the surface-level factors ([`crate::model::CustomShader::acceptable_downscale`] and
/// the reach-driven `resolution_cap`); pass them clamped to `(0, 1]`.
#[must_use]
pub fn chain_scales(graph: &[GraphPass], acceptable_downscale: f32, cap: f32) -> Vec<f32> {
    let n = graph.len();
    let surface = acceptable_downscale.min(cap).clamp(SCALE_FLOOR, 1.0);
    let mut consumers: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (j, gp) in graph.iter().enumerate() {
        for s in &gp.inputs {
            if let Src::Pass(i) = *s {
                if i < n {
                    consumers[i].push(j);
                }
            }
        }
    }
    let mut scale = vec![1.0_f32; n];
    for i in (0..n).rev() {
        let needed = if consumers[i].is_empty() {
            1.0
        } else {
            consumers[i]
                .iter()
                .map(|&j| {
                    if matches!(pass_reach(&graph[j].pass), Reach::Neighborhood(_)) {
                        pass_band_limit(&graph[j].pass)
                    } else {
                        scale[j]
                    }
                })
                .fold(0.0_f32, f32::max)
        };
        let own = if consumers[i].is_empty() { 1.0 } else { pass_band_limit(&graph[i].pass) };
        scale[i] = surface.min(needed).min(own).clamp(SCALE_FLOOR, 1.0);
    }
    scale
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect_graph::{
        background_blur_graph, custom_graph, glass_graph, GlassGeometry,
    };
    use crate::model::Glass;
    use kurbo::{Affine, Point};

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

    fn geom() -> GlassGeometry {
        GlassGeometry {
            center: Point::new(50.0, 50.0),
            width: 80.0,
            height: 60.0,
            corner_radius: 10.0,
            is_circle: false,
        }
    }

    #[test]
    fn same_pixel_and_procedural_fuse_neighborhood_and_global_do_not() {
        assert!(Reach::SamePixel.fuses());
        assert!(Reach::Procedural.fuses());
        assert!(!Reach::Neighborhood(4.0).fuses());
        assert!(!Reach::Global.fuses());
    }

    #[test]
    fn blur_reach_is_three_sigma() {
        assert_eq!(pass_reach(&EffectPass::Blur { sigma: 5.0, linear: true }), Reach::Neighborhood(15.0));
    }

    #[test]
    fn custom_is_conservatively_global() {
        assert_eq!(pass_reach(&EffectPass::Custom { u: vec![1.0, 2.0], param_vec4s: 1 }), Reach::Global);
    }

    #[test]
    fn footprint_reads_dst_when_a_pass_binds_the_backdrop_input() {
        let g = background_blur_graph(4.0);
        assert!(footprint(&g[0]).reads_dst);
    }

    #[test]
    fn sharp_glass_fuses_to_one_segment() {
        let g = glass_graph(&glass(), geom(), (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let stages = partition(&g);
        assert_eq!(stages, vec![Stage::Fused(vec![0, 1, 2, 3])]);
        assert_eq!(barrier_count(&stages), 0);
        assert_eq!(execution_groups(&g), vec![vec![0, 1, 2, 3]]);
    }

    #[test]
    fn frosted_glass_materialises_refraction_and_the_scatter() {
        let mut frosted = glass();
        frosted.frost = 1.0;
        let g = glass_graph(&frosted, geom(), (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let stages = partition(&g);
        assert_eq!(
            stages,
            vec![Stage::Fused(vec![0]), Stage::Barrier(1), Stage::Barrier(2), Stage::Fused(vec![3, 4])]
        );
        assert_eq!(barrier_count(&stages), 2);
        assert_eq!(execution_groups(&g), vec![vec![0], vec![1], vec![2, 3, 4]]);
    }

    #[test]
    fn light_frost_without_a_blur_pass_still_bars_the_scatter() {
        let mut frosted = glass();
        frosted.frost = 0.03;
        let g = glass_graph(&frosted, geom(), (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let stages = partition(&g);
        assert_eq!(stages, vec![Stage::Fused(vec![0]), Stage::Barrier(1), Stage::Fused(vec![2, 3])]);
        assert_eq!(execution_groups(&g), vec![vec![0], vec![1, 2, 3]]);
    }

    #[test]
    fn lone_blur_is_a_single_barrier() {
        let stages = partition(&background_blur_graph(4.0));
        assert_eq!(stages, vec![Stage::Barrier(0)]);
    }

    #[test]
    fn undeclared_custom_is_a_barrier() {
        let stages = partition(&custom_graph(vec![256.0, 256.0], 1));
        assert_eq!(stages, vec![Stage::Barrier(0)]);
    }

    #[test]
    fn sharp_chain_is_uniform_surface_scale() {
        let g = glass_graph(&glass(), geom(), (100, 100), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let s = chain_scales(&g, 0.6, 0.8);
        assert_eq!(s.len(), 4);
        for k in &s {
            assert!((k - 0.6).abs() < 1e-6, "sharp chain must be uniform min(0.6,0.8)=0.6, got {k}");
        }
    }

    #[test]
    fn single_custom_uses_its_declared_acceptable_downscale() {
        let s = chain_scales(&custom_graph(vec![256.0, 256.0], 1), 0.3, 1.0);
        assert_eq!(s, vec![0.3]);
        let s2 = chain_scales(&custom_graph(vec![256.0, 256.0], 1), 0.8, 0.25);
        assert_eq!(s2, vec![0.25]);
    }

    #[test]
    fn passes_feeding_a_blur_ride_the_blur_band_limit() {
        let mut frosted = glass();
        frosted.frost = 1.0;
        let g = glass_graph(&frosted, geom(), (400, 400), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let s = chain_scales(&g, 1.0, 1.0);
        assert_eq!(s.len(), 5);
        assert!(s[0] < 1.0, "the warp feeding a wide blur should ride cheap, got {}", s[0]);
        assert!(s[1] < 1.0, "the blur itself should render at its band-limit, got {}", s[1]);
        assert!(s[0] >= SCALE_FLOOR && s[1] >= SCALE_FLOOR);
    }

    #[test]
    fn acceptable_downscale_floor_clamps_every_pass() {
        let mut frosted = glass();
        frosted.frost = 1.0;
        let g = glass_graph(&frosted, geom(), (400, 400), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let s = chain_scales(&g, 0.5, 1.0);
        for k in &s {
            assert!(*k <= 0.5 + 1e-6, "acceptable_downscale=0.5 must cap every pass, got {k}");
        }
    }
}
