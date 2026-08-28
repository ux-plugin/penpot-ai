//! The GPU production sink — executes a `crate::schedule::Schedule` on the Vello backend.
//!
//! render-core builds the neutral schedule (which surface each shape paints into, how surfaces
//! compose, in z-order). This sink is the backend half: it maps each logical `SurfaceRef` to a GPU
//! texture, runs each step, and presents the result on the swapchain.
//!
//! - `Paint` → render one node's body (via the `PAINT_ONLY`-scoped scene render) into the target
//!   surface; the first write to a surface clears, later writes `render_load` (so a tile's output
//!   accumulates many shapes + composited effect surfaces in z-order).
//! - `Composite` → a `SrcOver` blit ([`crate::vello::blend`]) of one surface into another (or the
//!   swapchain). The GPU clips the blit quad to the target, so an effect surface that overlaps
//!   several tiles composites the right slice into each.
//!
//! Each step submits on its own encoder — the same ordering discipline as the tile store's
//! submit-per-tile fix, and required here because a later `Paint` into a tile must observe an
//! earlier `Composite` into it.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use crate::atlas::{pack_grid, shelf_pack};
use crate::model::TileMode;
use crate::peniko::color::palette::css::TRANSPARENT;
use crate::peniko::Color;
use crate::effect::{Compose, Source};
use crate::schedule::{
    first_write_paints, GatherPlan, LayerPaint, PaintOp, Schedule, Step, SurfaceRef, SurfaceRole,
};
#[cfg(feature = "tiled-scheduler")]
use crate::tile_cache::TileCache;
use crate::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use crate::vello::rasterize::RasterBackend;
use vello_common::kurbo::{Affine, Rect, Shape};
use vello_example_scenes::RenderingContext;

use crate::vello::blend::{BlendComposite, Blit, Compositor, MaskedBlit};
use crate::vello::units::UnitPipeline;
use crate::effect_graph::{self, LensGeometry};

use crate::vello::graph::{build_custom_pipeline, lower_graph, new_target_with_usage, run_graph, run_graph_into, Pass};

/// Every sink surface is composited with `SrcOver`, so a first write clears to full transparency —
/// the neutral `base_color` the backend rasterizes against.
const CLEAR: Color = TRANSPARENT;

/// The **`acceptable_downscale`** of a solid-coverage blur (a shadow silhouette or a layer-blurred body)
/// of the given DEVICE sigma — the *downscale* input, NOT the final scale. A Gaussian is low-pass, so it
/// can render at its band limit `2/3σ` (mirroring `builder::blur_policy_downscale`) and upscale on the
/// composite; floored at 0.5 so the bilinear upscale never over-softens, `1.0` for a near-sharp blur.
/// Safe for solid coverage (no sharp detail to alias — unlike a gather's backdrop, where the policy is
/// off). This is only the *downscale*; the caller still combines it with the memory *limit*
/// (`tiling::resolution_cap`) via `min` to get the render scale `k`, exactly like the gather path.
/// The device-pixel box a page-space effect rect occupies, snapped outward to whole pixels and
/// clamped to the viewport. `None` when it lands fully off-screen (nothing to render).
///
/// This is what lets a whole-viewport effect pass be **extent-cropped**: instead of rasterizing and
/// blurring a shape's silhouette across the entire viewport (which a ~500px shape on a 4K screen does
/// at ~20× the necessary pixels), the pass runs in a surface the size of this box and composites back
/// at its origin. Mirrors the tiled path's `device_rect` + the gather path's scoped bbox.
fn wv_device_box(page: crate::kurbo::Rect, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    use crate::kurbo::Point;
    let pts = [
        full_view * Point::new(page.x0, page.y0),
        full_view * Point::new(page.x1, page.y0),
        full_view * Point::new(page.x0, page.y1),
        full_view * Point::new(page.x1, page.y1),
    ];
    let bx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min).floor().clamp(0.0, f64::from(width)) as u32;
    let by = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min).floor().clamp(0.0, f64::from(height)) as u32;
    let ex = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max).ceil().clamp(0.0, f64::from(width)) as u32;
    let ey = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max).ceil().clamp(0.0, f64::from(height)) as u32;
    let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
    (bw > 0 && bh > 0).then_some((bx, by, bw, bh))
}


/// The straight RGBA this cell's chain tints with, read off the chain itself.
///
/// It used to be a second lookup on the node (`model.get(id).shadows.filter(inset).nth(idx)`), which
/// is how the batch and the per-shape path could disagree about a colour: two routes to one value.
/// The chain already carries it, because the chain is what applies it.
fn wv_cell_tint(c: &Cell) -> Option<[f32; 4]> {
    c.tint
}

/// The straight RGBA a lowered chain tints with, read off the graph before it is dropped from the
/// cell. Kept as its own function so [`Sink::wv_effect_cells`] extracts the value exactly as the
/// on-demand `wv_cell_tint` used to, now that the cell carries the tint rather than the graph.
fn graph_tint(graph: &[crate::effect_graph::GraphPass]) -> Option<[f32; 4]> {
    graph.iter().find_map(|p| match &p.pass {
        crate::effect_graph::EffectPass::Unit { op: crate::effect_graph::UnitKind::Tint, u, .. } => {
            Some([u[12], u[13], u[14], u[15]])
        }
        _ => None,
    })
}

/// Lower ONE effect to the chain a cell of `kind` runs — the whole reason a cell can carry its
/// effect at all.
///
/// This asks the effect what its ops are. The version this replaces asked the CELL KIND
/// (`0 → drop_shadow_graph`, `2 → tint_graph`, else `background_blur_graph`), which meant the chain
/// was a reconstruction: faithful for the three shapes it enumerated and structurally blind to
/// everything else, so a body carrying a custom shader lowered to a bare blur and the batch admitted
/// it — stamping the shape with the user's shader silently missing.
///
/// `sigma` is the device sigma already scaled by the cell's `k`. Order is the builders' order, not
/// the ops' order: a shadow tints before it blurs (the two commute — a blur is linear and a tint is a
/// constant multiply — and the builders' order is the one the per-shape path renders).
fn wv_cell_graph(e: &crate::effect::Effect, kind: u8, kw: u32, kh: u32, sigma: f32) -> Vec<crate::effect_graph::GraphPass> {
    use crate::effect::Op;
    use crate::effect_graph::{unit_pass, EffectPass, GraphPass, Src, UnitKind};
    let (kwf, khf) = (kw as f32, kh as f32);
    let tint = e.ops.iter().find_map(|op| match op {
        Op::Tint(c) => Some(c.components),
        _ => None,
    });
    // A coverage silhouette coloured by a `Tint` unit — the shadow's colour over its own alpha.
    let coloured = |col: [f32; 4]| GraphPass::new(unit_pass(UnitKind::Tint, kwf, khf, col), vec![Src::Input(0)]);
    match kind {
        // A drop shadow is its colour over its coverage, then blurred.
        0 => tint
            .map(|col| {
                let mut g = vec![coloured(col)];
                if sigma > 0.5 {
                    g.push(GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![Src::Pass(0)]));
                }
                g
            })
            .unwrap_or_default(),
        // The inner shadow's FLOOD is never blurred — only its punch (kind 3) is — so the flood
        // carries the colour and nothing else. The erase that pairs them is the combine stage.
        2 => tint.map(|col| vec![coloured(col)]).unwrap_or_default(),
        // The punch: the same silhouette, blurred by the erase's own radius.
        3 => {
            if sigma > 0.0 {
                vec![GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![Src::Input(0)])]
            } else {
                Vec::new()
            }
        }
        // A body runs its shaders in authored order and then its blur — the chain
        // `wv_composite_body` executes, now visible before it executes. The pipeline is resolved at
        // execution; lowering carries `None` and the pass survives it.
        _ => {
            let mut passes: Vec<GraphPass> = Vec::new();
            for op in &e.ops {
                if let Op::Shader(c) = op {
                    let mut u = vec![kwf, khf];
                    u.extend_from_slice(&c.params);
                    let src = passes.len().checked_sub(1).map_or(Src::Input(0), Src::Pass);
                    passes.push(GraphPass::new(
                        EffectPass::Custom { u, param_vec4s: c.param_vec4s, reach: c.reach, reads_backdrop: c.reads_backdrop },
                        vec![src],
                    ));
                }
            }
            if sigma > 0.0 {
                let src = passes.len().checked_sub(1).map_or(Src::Input(0), Src::Pass);
                passes.push(GraphPass::new(EffectPass::Blur { sigma, linear: true }, vec![src]));
            }
            passes
        }
    }
}

/// Whether the instanced stages can express `graph`. The implemented stage set today is exactly
/// `{Blur}` at native scale, one node deep, inside the separable cap — everything else keeps the
/// per-shape path. Growing the batch vocabulary means widening THIS match (plus one stage
/// implementation), not touching the planner.
/// What the instanced stage set can express for one **lowered** chain, plus the parameters those
/// stages need. `None` keeps the shape on its own pass chain.
///
/// One predicate for both stage families, because the question is the same one: can the instanced
/// stages run this chain? What separates the two answers is the chain's head — a sampling unit needs
/// the lens stages, a pointwise-only chain is a stamp. Splitting that decision across two functions
/// is what let a chain belong to neither.
#[derive(Debug, Clone, PartialEq)]
enum BatchShape {
    /// Coverage through an optional blur and then a pointwise tail: drop shadows, inner-shadow
    /// floods and punches, plain bodies. `ops` is that tail verbatim — the batch binds its uniform
    /// per cell, so the tail is not restricted to units this enum knows the names of.
    Stamp { sigma: f32, linear: bool, ops: Vec<crate::vello::units::UnitOp> },
    /// A sampling head, an optional blur, and a pointwise tail — the lens stages.
    Lens { head: crate::vello::units::UnitOp, tail: Vec<crate::vello::units::UnitOp>, sigma: f32 },
}

/// One soft shadow's inline marker set for the MAIN-loop shadow plan ([`Sink::wv_shadow_plan`]), in the
/// order `fine` runs it. `slot` is the shadow's index among the node's shadows filtered to its `inset`
/// flag — the argument [`RasterBackend::build_shadow_silhouette`] takes to pick which offset silhouette to
/// rasterise. A shape's whole `Vec<Shadow>` becomes a `Vec<ShadowMarker>`: drops (under the body) then
/// inners (over it), each an independent block of rounds keyed by its H marker's round.
#[derive(Clone)]
enum ShadowMarker {
    /// A SHARP (σ<0.5) drop: ONE marker composites the shape's offset silhouette (unblurred coverage,
    /// `SPREAD|SCRATCH_COV` reading the rasterised silhouette scratch's alpha) under the body. PRE-body.
    SharpDrop { desc: [f32; 26], slot: usize },
    /// A SHARP (σ<0.5) inner: ONE band marker (POST-body). No blur — the punch is the raw offset inset
    /// silhouette, so the band (`SPREAD|ERASE`, `flood=area[i]` minus that silhouette) reads it directly.
    SharpInner { band: [f32; 26], slot: usize },
    /// A SOFT (σ≥0.5) drop: H blurs the offset silhouette scratch → draft, V blurs it vertically and
    /// SPREAD-composites the shadow colour under the body. Two markers, both PRE-body.
    SoftDrop { h: [f32; 26], v: [f32; 26], slot: usize },
    /// A SOFT (σ≥0.5) inner: H, then V materialises the 2D-blurred punch to a scratch (both PRE-body,
    /// neither composites); the band lays the flood-minus-punch over the body (POST-body).
    SoftInner { h: [f32; 26], v: [f32; 26], band: [f32; 26], slot: usize },
}

/// The fine dispatch role of one scheduled shadow marker — a round-keyed, gid-free view of a
/// [`ShadowMarker`] so the driver's window plan and dispatch resolve scratches by round alone.
#[derive(Clone, Copy, PartialEq)]
enum ShadowRole {
    /// A SHARP drop: composite the rasterised offset silhouette (keyed by this round) UNDER the body,
    /// no blur — `SPREAD|SCRATCH_COV` lays the shadow colour at the silhouette's alpha.
    SharpDrop,
    /// Blur H of an offset silhouette scratch → draft (drops AND inners share this — the inner just
    /// reads its INSET silhouette). The silhouette is keyed by this marker's round.
    BlurH,
    /// Blur V + SPREAD composite of a drop, under the body.
    DropV,
    /// Blur V of an inner → materialise the 2D punch to a scratch keyed by `punch_key`.
    InnerV,
    /// The inner band: flood-minus-punch (punch keyed by `punch_key`) over the body.
    InnerBand,
    /// A SHARP inner band: reads the raw offset inset silhouette (`stack_sil` at THIS round, no blur) as
    /// the punch and lays flood-minus-punch over the body — the crisp analogue of `InnerBand`.
    SharpInnerBand,
}

/// One scheduled shadow marker with its absolute round, descriptor, dispatch role, and the keys the
/// dispatch needs — the silhouette `slot`/`inset` for a `BlurH`, the `punch_key` shared by an inner's
/// `InnerV` and `InnerBand` (its H round). Produced by [`schedule_shadows`] once the block start is known.
#[derive(Clone, Copy)]
struct ShadowMk {
    round: u32,
    desc: [f32; 26],
    role: ShadowRole,
    slot: usize,
    inset: bool,
    punch_key: u32,
}

/// The edge-driven dispatch plan for a shadow shape (`WV_DAG_EXEC`) — DAG node references the executor
/// binds by EDGE instead of by role/`punch_key`/round. Produced by [`Sink::wv_dag_shadow`], keyed off
/// the SAME rounds `shadow_sched` assigns (so the descriptors `stack_markers` deliver stay aligned).
struct DagShadow {
    /// Each silhouette `Rasterize` node bound by a pass (a drop/punch silhouette, NOT the inner flood) +
    /// its slot + whether it is an inner punch (`inset`) — rasterised into `node_scratch[node]`.
    sils: Vec<(usize, usize, bool)>,
    /// Each dispatched pass: its round (from `shadow_sched`) and the DAG node it runs. The dispatch reads
    /// the node's op + input edges to bind scratches — no role, no `punch_key`.
    passes: Vec<(u32, usize)>,
}

/// Rounds the pre-body half of a shadow plan spans: two (H, V) per soft shadow, one per sharp drop, none
/// for a sharp inner (its lone band is POST-body).
fn shadow_pre_rounds(plan: &[ShadowMarker]) -> u32 {
    plan.iter()
        .map(|m| match m {
            ShadowMarker::SharpDrop { .. } => 1,
            ShadowMarker::SharpInner { .. } => 0,
            ShadowMarker::SoftDrop { .. } | ShadowMarker::SoftInner { .. } => 2,
        })
        .sum()
}

/// Inner shadows in the plan (soft OR sharp) — the number of POST-body band rounds.
fn shadow_num_inners(plan: &[ShadowMarker]) -> u32 {
    plan.iter().filter(|m| matches!(m, ShadowMarker::SoftInner { .. } | ShadowMarker::SharpInner { .. })).count() as u32
}

/// Total rounds a shadow plan's block spans: the pre-body H/V pairs, then one round per inner band
/// (the first band shares the body round, matching the single-inner layout), or a lone body round.
fn shadow_span(plan: &[ShadowMarker]) -> u32 {
    let pre = shadow_pre_rounds(plan);
    let ni = shadow_num_inners(plan);
    if ni > 0 { pre + ni } else { pre + 1 }
}

/// Assign absolute rounds to every marker of a shadow `plan` whose block starts at `base`: each soft
/// shadow's H then V fill the pre-body rounds in z-order; the body composites at `base + pre_rounds`; the
/// inner bands follow one per round from there (the first sharing the body round). An inner's `InnerV` and
/// `InnerBand` share a `punch_key` = the inner's H round, so the punch scratch survives across the body.
fn schedule_shadows(plan: &[ShadowMarker], base: u32) -> Vec<ShadowMk> {
    let mut mks = Vec::new();
    let mut cursor = base;
    // Post-body bands: `Some(hk)` = a SOFT inner reading its materialised punch at H round `hk`; `None` = a
    // SHARP inner reading its raw offset silhouette at its OWN band round.
    let mut inners: Vec<(Option<u32>, [f32; 26], usize)> = Vec::new();
    for m in plan {
        match m {
            ShadowMarker::SharpDrop { desc, slot } => {
                mks.push(ShadowMk { round: cursor, desc: *desc, role: ShadowRole::SharpDrop, slot: *slot, inset: false, punch_key: 0 });
                cursor += 1;
            }
            ShadowMarker::SharpInner { band, slot } => {
                inners.push((None, *band, *slot)); // no pre-body round; the band reads its own silhouette
            }
            ShadowMarker::SoftDrop { h, v, slot } => {
                mks.push(ShadowMk { round: cursor, desc: *h, role: ShadowRole::BlurH, slot: *slot, inset: false, punch_key: 0 });
                mks.push(ShadowMk { round: cursor + 1, desc: *v, role: ShadowRole::DropV, slot: *slot, inset: false, punch_key: 0 });
                cursor += 2;
            }
            ShadowMarker::SoftInner { h, v, band, slot } => {
                let hk = cursor;
                mks.push(ShadowMk { round: cursor, desc: *h, role: ShadowRole::BlurH, slot: *slot, inset: true, punch_key: hk });
                mks.push(ShadowMk { round: cursor + 1, desc: *v, role: ShadowRole::InnerV, slot: *slot, inset: true, punch_key: hk });
                inners.push((Some(hk), *band, *slot));
                cursor += 2;
            }
        }
    }
    let mut band_round = cursor; // = base + pre_rounds (the body round)
    for (src, band, slot) in inners {
        // A soft band reads its blurred punch (`InnerBand`, punch_key = its H round); a sharp band reads the
        // raw offset silhouette rasterised at its OWN round (`SharpInnerBand`, so `sil_jobs` rasterises here).
        let (role, punch_key) = match src {
            Some(hk) => (ShadowRole::InnerBand, hk),
            None => (ShadowRole::SharpInnerBand, band_round),
        };
        mks.push(ShadowMk { round: band_round, desc: band, role, slot, inset: true, punch_key });
        band_round += 1;
    }
    mks
}

/// Trace a DAG node's input chain back to the coverage `Rasterize` it rests on, or `None` if it rests on
/// the backdrop (a `Reload`, or no input). This is what tells the edge-driven executor where a pass's
/// `base_in` comes from: `Some(r)` → the silhouette `node_scratch[r]` (a shadow); `None` → the
/// accumulator backdrop (a background blur, a lens/frost link).
fn dag_base_rasterize(dag: &crate::vello::frame_dag::FrameDag, mut node: usize) -> Option<usize> {
    use crate::vello::units::UnitOp;
    loop {
        match dag.nodes[node].op {
            UnitOp::Rasterize => return Some(node),
            UnitOp::Reload => return None,
            _ => node = *dag.nodes[node].inputs.first()?,
        }
    }
}

/// Whether a `Units` pass leads with a sampling head, which is what sends a chain to the lens
/// stages rather than the stamp stages.
fn units_head(p: &Pass) -> Option<&crate::vello::units::UnitOp> {
    use crate::vello::units::UnitOp;
    match p.units.first() {
        Some(op @ (UnitOp::Warp(_) | UnitOp::Scatter(_))) => Some(op),
        _ => None,
    }
}

fn batch_admit(passes: &[Pass]) -> Option<BatchShape> {
    use crate::vello::units::UnitOp;
    use crate::vello::graph::BLUR_MAX_SIGMA;

    // A lens: sampling head, optionally a blur, then the pointwise tail. The head's and the blur's
    // scales must agree — the batch packs one cell that serves both resolutions.
    if let Some(head) = passes.first().and_then(units_head) {
        return match passes {
            [one] => (one.scale >= 0.999)
                .then(|| BatchShape::Lens { head: head.clone(), tail: one.units[1..].to_vec(), sigma: 0.0 }),
            [w, b, t] => {
                // The middle pass must be a single unblurred-in-gamma-space `Blur` barrier, and the
                // tail a fused units run (not a lone barrier).
                let [UnitOp::Blur { sigma, linear: false }] = b.units.as_slice() else { return None };
                if t.units.len() == 1 && t.units[0].is_barrier() {
                    return None;
                }
                if *sigma > BLUR_MAX_SIGMA || t.scale < 0.999 || (w.scale - b.scale).abs() > 1e-6 {
                    return None;
                }
                Some(BatchShape::Lens { head: head.clone(), tail: t.units.clone(), sigma: *sigma })
            }
            _ => None,
        };
    }

    // Otherwise a stamp: at most one blur, and a pointwise tail. The tail is not filtered by NAME.
    // A unit declines for one of two structural reasons only — it samples (a head belongs to a lens,
    // not a stamp), or it reads a field the batch module did not compile.
    let (mut sigma, mut linear, mut blurs) = (0.0_f32, false, 0usize);
    let mut tail: Vec<UnitOp> = Vec::new();
    for p in passes {
        if p.scale < 0.999 {
            return None;
        }
        match p.units.as_slice() {
            [UnitOp::Blur { sigma: s, linear: l }] => {
                blurs += 1;
                if blurs > 1 || *s > BLUR_MAX_SIGMA {
                    return None;
                }
                sigma = *s;
                linear = *l;
            }
            // A custom barrier is not a stamp arm.
            [UnitOp::Custom { .. }] => return None,
            ops => {
                for op in ops {
                    match op {
                        // A sampling head this far into the chain is a lens that did not lead with
                        // one; the stamp arms have no head to run it as.
                        UnitOp::Warp(_) | UnitOp::Scatter(_) => return None,
                        // Both measure a field. The batch compiles ONE field program, so a chain
                        // measuring its own cannot be evaluated by these arms until the program
                        // travels per cell the way the uniform does.
                        UnitOp::Shade(_) | UnitOp::MaskMix(_) => return None,
                        // A barrier inside a fused run cannot occur (fuse cuts at one), but a stamp
                        // arm could not run it regardless.
                        UnitOp::Blur { .. } | UnitOp::Custom { .. } => return None,
                        _ => tail.push(op.clone()),
                    }
                }
            }
        }
    }
    Some(BatchShape::Stamp { sigma, linear, ops: tail })
}

/// Rasterize a batch of shape silhouettes into `target` as a stencil for effect masking. Each item
/// is `(shape_id, transform)`, where the transform places that shape's silhouette in the target's
/// space — an atlas slot, a scaled cell, or a whole surface. This is the skeleton (new scene, one
/// `build_mask` per item, one flush) shared by the batch mask atlas, the per-packing-cell masks, the
/// single-cell gather mask, and the per-shape composite tail, so they cannot drift in how a
/// silhouette scene is built and flushed. What differs per site — the transform and which shapes are
/// selected — is the iterator the caller passes; the guard deciding WHETHER to run stays at the call
/// site (an empty iterator still validly clears the target).
fn rasterize_masks<B: RasterBackend>(
    backend: &mut B,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    enc: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    width: u32,
    height: u32,
    clear: Color,
    masks: impl IntoIterator<Item = (u128, Affine)>,
) {
    let mut scene = backend.new_scene(width as u16, height as u16);
    for (id, transform) in masks {
        backend.build_mask(&mut scene, transform, id);
    }
    backend.rasterize(&scene, device, queue, enc, target, width, height, clear);
}

/// A marker's reach clamped to the FRAME.
///
/// The accumulator is taller than the frame whenever a source strip sits below it, and the marker
/// is drawn into that taller scene — so an unclamped reach bins the marker into strip tiles. Those
/// tiles' command lists are then split into rounds, which defers the `Copy` layers that isolate the
/// sources to the last window, long after the effects have already read them. Effects only ever
/// composite into the frame, so cutting the reach at the frame's edge loses nothing.
fn wv_clamp_reach(r: [f32; 4], width: u32, height: u32) -> [f32; 4] {
    [r[0].max(0.0), r[1].max(0.0), r[2].min(width as f32), r[3].min(height as f32)]
}

/// Group whole-viewport effect markers into rounds: an effect's round is one more than the deepest
/// round among earlier (z-below) effects whose reach can share a 16px tile with its own. The
/// per-tile marker contract (`fine.wgsl`) requires marker rounds strictly increasing along any one
/// tile's PTCL — which this guarantees, because two markers on the same tile always have
/// tile-overlapping reaches. Reach-disjoint effects share a round, so the number of windowed fine
/// passes scales with the max effect stack DEPTH, not the effect count. Rects snap OUT to the tile
/// grid before the overlap test (coarse bins markers per whole tile, so two reaches meeting inside
/// one tile do conflict); a fully off-screen reach never conflicts (its marker is not emitted).
fn wv_rounds(reaches: &[[f32; 4]], width: u32, height: u32) -> Vec<u32> {
    const TILE: f32 = 16.0;
    let snapped: Vec<[f32; 4]> = reaches
        .iter()
        .map(|r| {
            let c = [r[0].max(0.0), r[1].max(0.0), r[2].min(width as f32), r[3].min(height as f32)];
            [
                (c[0] / TILE).floor() * TILE,
                (c[1] / TILE).floor() * TILE,
                (c[2] / TILE).ceil() * TILE,
                (c[3] / TILE).ceil() * TILE,
            ]
        })
        .collect();
    let live = |r: &[f32; 4]| r[2] > r[0] && r[3] > r[1];
    let mut rounds: Vec<u32> = Vec::with_capacity(reaches.len());
    for j in 0..snapped.len() {
        let mut round = 1u32;
        if live(&snapped[j]) {
            for i in 0..j {
                if live(&snapped[i])
                    && snapped[i][0] < snapped[j][2]
                    && snapped[j][0] < snapped[i][2]
                    && snapped[i][1] < snapped[j][3]
                    && snapped[j][1] < snapped[i][3]
                {
                    round = round.max(rounds[i] + 1);
                }
            }
        }
        rounds.push(round);
    }
    rounds
}

fn blur_acceptable_downscale(device_sigma: f32) -> f32 {
    if device_sigma <= f32::EPSILON {
        return 1.0;
    }
    (2.0 / device_sigma).clamp(0.5, 1.0)
}

/// Distinct custom-shader render pipelines kept before the cache is dropped. Keyed by WGSL source
/// hash, so live-editing a shader (a new source every keystroke) would otherwise grow this without
/// bound. A pipeline recompiles cheaply on the next use, so clearing when full is a fine cap.
const MAX_CUSTOM_PIPELINES: usize = 64;

struct Surface {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// A texture's recyclability identity: two textures are interchangeable iff their size, format, and
/// usage all match. Derived straight from the texture, so nothing threads it through `Surface`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct PoolKey {
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    usage: u32,
}

impl PoolKey {
    fn of(t: &wgpu::Texture) -> Self {
        Self { w: t.width(), h: t.height(), format: t.format(), usage: t.usage().bits() }
    }

    /// Approximate GPU footprint of one texture with this key, for the pool budget.
    fn approx_bytes(&self) -> u64 {
        let bpp = match self.format {
            wgpu::TextureFormat::Rgba16Float => 8,
            wgpu::TextureFormat::R32Uint | wgpu::TextureFormat::R32Float => 4,
            _ => 4,
        };
        u64::from(self.w) * u64::from(self.h) * bpp
    }
}

/// The device-space geometry shared by every whole-viewport cell, whatever its effect: the device
/// box it covers, the render scale `k` it is rasterized at, the device blur sigma, and whether the
/// stamp Catmull-Rom-upscales it (`k < 1`). One bundle so the geometry helpers, the mask transform
/// and the packer can operate on a cell without knowing whether it is a spread or a gather. The box
/// is `f32` (integer-valued device pixels) so the reduced-render and atlas math stay one numeric type
/// across both cell kinds — the shared vocabulary the single planner is built on.
#[derive(Clone, Copy)]
struct CellGeom {
    /// Device box `(x, y, w, h)` in device pixels.
    dev: (f32, f32, f32, f32),
    /// Render scale: the cell is rasterized at `dev` size × `k`, and the stamp upscales when `k < 1`.
    k: f32,
    /// Device blur sigma of the cell's governing blur (`0` = none).
    sigma: f32,
    /// `k < 1` → the composite Catmull-Rom-upscales the reduced cell instead of a plain copy.
    sharp: bool,
}

impl CellGeom {
    fn bx(&self) -> f32 { self.dev.0 }
    fn by(&self) -> f32 { self.dev.1 }
    fn bw(&self) -> f32 { self.dev.2 }
    fn bh(&self) -> f32 { self.dev.3 }
}

/// Linchpin A/B gate for effects-in-fine gathers (default OFF): `WV_GLASS_FINE=1` routes a SHARP
/// glass gather through `fine` — a WARP inline effect that samples the materialized backdrop
/// (`base_in`) at the lens field's displacement in a reload round — instead of the batched lens
/// stages. The batched path stays the oracle; this proves a barrier can ride `fine` at all.
fn wv_glass_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_GLASS_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Route the effect descriptors through the whole-frame DAG (`frame_dag` + `bake`) instead of the
/// per-effect planners — the emitter-swap A/B toggle. OFF by default; `WV_DAG=1` sources a descriptor
/// from the scheduler's baked units where the DAG's arm structure matches current fine (sharp glass so
/// far), falling back to the planner otherwise. Native-only.
fn wv_dag() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_DAG").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// The DAG-EDGE EXECUTOR toggle (`WV_DAG_EXEC=1`) — the round loop derives its per-window dispatch from
/// the whole-frame DAG's nodes + input edges instead of the hand-assigned `WindowRole` map. The endgame
/// of the one-planner-one-executor collapse: the executor decides NOTHING (no role tags), it walks the
/// scheduled nodes, allocates a scratch per materialised node, and binds each node's inputs by following
/// its edges. Brought up in stages behind this flag, one fixture at a time; when every fixture passes the
/// old `WindowRole`/`schedule_shadows` machine is deleted. Native-only, OFF by default. Implies wv_dag().
fn wv_dag_exec() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_DAG_EXEC").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Sibling of [`wv_glass_fine`] for a background BLUR: routes it through fine as a BLUR arm (a
/// separable Gaussian over `base_in` + a draft) instead of the dedicated `blur_px` pipeline. DEFAULT
/// ON as of the effects-in-fine collapse (D); `WV_BLUR_FINE=0` forces the batched `blur_px` oracle.
fn wv_blur_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_BLUR_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// A FROSTED glass lens (`total_blur_sigma > 0.5`) routed through fine as a chained gather —
/// warp → blur H/V → scatter → shade+maskmix, materialising intermediates across a reserved 5-round
/// block. Default OFF (`WV_FROST_FINE=1`) while it matures; sharp glass rides `WV_GLASS_FINE` alone.
fn wv_frost_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_FROST_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Sibling for a path/text drop + inner SHADOW: blurs the offset silhouette through the fine draft blur
/// (a mini phased session in the shadow pre-pass) instead of the `run_chain` Gaussian. DEFAULT ON as of
/// the effects-in-fine collapse (D); `WV_SHADOW_FINE=0` forces the batched/graph shadow oracle.
fn wv_shadow_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_SHADOW_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// A HARD (σ<0.5) drop shadow rides fine as a single `SPREAD|SCRATCH_COV` marker over the rasterised
/// offset silhouette ([`Sink::wv_shadow_plan`]'s [`ShadowMarker::SharpDrop`]) instead of the pre-pass
/// blit — any number of sharp drops, mixable with soft shadows, Path or Text. Default ON;
/// `WV_SPREAD_FINE=0` forces the pre-pass (the A/B oracle) for a shape carrying a sharp drop.
fn wv_spread_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_SPREAD_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// A SOFT (σ≥0.5) drop shadow on a pure drop+body PATH stack blurs in the MAIN round loop (a rasterised
/// silhouette scratch → BLUR H/V → SPREAD composite under the body) instead of the `wv_shadow_fine`
/// PRE-PASS mini-session. Default ON; `WV_DROPBLUR_FINE=0` forces the pre-pass (the A/B oracle).
fn wv_dropblur_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_DROPBLUR_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// A SOFT (σ≥0.5) INNER shadow on a pure inner+body PATH stack builds its band in the MAIN round loop
/// (blur the offset silhouette to a punch, then a flood-minus-punch band OVER the body) instead of the
/// pre-pass. Default ON; `WV_INNERBLUR_FINE=0` forces the pre-pass (the A/B oracle).
fn wv_innerblur_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_INNERBLUR_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Routes an FX_STACK node's BACKDROP effect (its glass/blur, which reads the accumulator mid-stack)
/// through `fine` as a marker instead of the imperative `wv_stamp_gather` → `run_chain`. The stack
/// FRACTURES across two rounds: its z-below layers (drops) composite at round R, the glass marker
/// reloads that materialised backdrop at R+1, and the body/inner composite after it. Default ON as of
/// the effects-in-fine collapse; `WV_STACK_GATHER_FINE=0` forces the whole stack back onto `run_chain`.
fn wv_stack_gather_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_STACK_GATHER_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Sibling of [`wv_stack_gather_fine`] for a FROSTED-backdrop stack: routes the 5-link frost chain
/// through fine over a 7-round block (drops, warp, blur H/V, scatter, tail, then the BODY one round past
/// the tail — an imperative body sharing the tail round is overwritten by the tail's masked composite).
/// Default ON as of the effects-in-fine collapse; `WV_STACK_FROST_FINE=0` forces the frosted stack back
/// onto `run_chain` (the A/B oracle).
fn wv_stack_frost_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_STACK_FROST_FINE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// A sharp glass lens on a non-box shape (a path) follows its real OUTLINE, not a rounded box: its
/// distance comes from a baked signed-distance field of the outline ([`crate::field::FieldSource::Sampled`],
/// program 4) rather than the analytic `sdfRoundedBox`. Default ON; `WV_GLASS_SHAPE=0` forces the
/// analytic box (the pre-SDF behaviour) for the A/B oracle.
fn wv_glass_shape_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_GLASS_SHAPE").map_or(true, |v| v != "0");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Effect-node kinds the whole-viewport driver dispatches on. `FX_GATHER` is a pure gather (its body
/// stays in the shared walk); `FX_STACK` carries a non-box shadow, a layer blur or a spread shader, so
/// its body is excluded from the walk and its whole ordered stack runs at the boundary.
const FX_GATHER: u8 = 0;
const FX_STACK: u8 = 1;

/// Vello's fine-rasterization tile, in device pixels. Regions that must not influence one another
/// have to be tile-disjoint, because `fine` resolves a whole tile at a time.
const TILE_PX: u32 = 16;

/// One whole-viewport effect surface, resolved to geometry — the SINGLE cell type both the spread
/// planner ([`Sink::wv_effect_cells`] → [`wv_batch_plan`]) and the gather planner
/// ([`Sink::wv_lens_plan`]) emit, and both executors ([`Sink::wv_paint_stack`] and
/// [`Sink::wv_lens_round`]) consume. It carries the union of what a spread stamp and a batched gather
/// need; a given cell fills only its kind's fields (a spread leaves the gather rects empty and vice
/// versa). The fields group as: identity + schedule, shared geometry + chain, then the
/// per-kind placement and compositing metadata.
#[derive(Clone)]
struct Cell {
    /// `(node, kind, index)`. Kind is `0` drop silhouette, `1` body, `2` inner flood, `3` inner
    /// punch for a spread (the index disambiguates siblings).
    key: (u128, u8, usize),
    /// Device box, render scale `k`, device sigma. (`geom.sharp` is always `false` for a spread: a
    /// stamp never Catmull-Rom-upscales.)
    geom: CellGeom,
    /// This cell's effect, LOWERED once to runnable [`Pass`]es — the shared units-IR chain the
    /// per-shape executor (`wv_effect_blit`) consumes.
    passes: std::rc::Rc<Vec<Pass>>,
    /// The straight RGBA tint a spread chain applies, pre-extracted when the cell is built.
    tint: Option<[f32; 4]>,
    /// Reduced surface size (its atlas slot is assigned by an external [`crate::atlas::Packing`]
    /// keyed on `key`).
    kw: u32,
    kh: u32,
    /// How this cell's source pixels are obtained (see [`CellSource`]).
    source: CellSource,
}

/// The one irreducible spread axis: how a cell's source pixels are obtained. This is NOT derivable
/// from the effect chain, which is why it is a field.
#[derive(Clone)]
enum CellSource {
    /// Spread: rasterise the shape's silhouette into the cell and run the chain over it. `offset` is
    /// the device translation the chain applies (a filter graph's `Offset`); `(0, 0)` for most.
    Silhouette { offset: (f32, f32) },
}

/// Per-key free list buckets are capped so a burst of one-off sizes can't grow the pool without bound.
const MAX_POOL_PER_KEY: usize = 32;

/// Total bytes the pool may hold across ALL keys. The per-key cap alone cannot bound the pool:
/// continuous zoom re-sizes every effect surface every frame, minting an unbounded stream of new
/// keys — at 4K with hundreds of effect nodes that leaked VRAM without bound (the user-visible
/// "memory keeps growing"), ending in a lost device (native crash; garbled tiles in the browser,
/// which clamps instead of faulting). Crossing the budget evicts whole buckets until back under.
const MAX_POOL_BYTES: u64 = 512 * 1024 * 1024;

/// A free-list of reusable GPU textures keyed by [`PoolKey`]. Fed at frame boundaries (drained before
/// this frame renders), on tile eviction/replacement, AND — for the whole-viewport effect path — at
/// each effect-node boundary MID-frame (see [`Sink::recycle_node_transient`]), so a node's scratch is
/// reused by the next node instead of every node's intermediates staying resident until the one submit.
/// Handing a texture back out as a fresh render target needs no extra synchronisation: a target is
/// always fully overwritten (its render pass clears or the effect graph writes every texel), and wgpu's
/// automatic hazard tracking serialises the write-after-read against any still-pending prior use —
/// in-encoder for the collapsed path, cross-submit on the same queue for the per-segment path.
#[derive(Default)]
pub(crate) struct TexturePool {
    free: HashMap<PoolKey, Vec<wgpu::Texture>>,
    /// Approximate bytes currently held in `free` (see [`PoolKey::approx_bytes`]).
    held_bytes: u64,
}

impl TexturePool {
    /// A texture matching `key`, reused from the free list or freshly created. A real allocation is
    /// timed into the `tex` profiler bucket, so `texn` counts only genuine `create_texture` calls —
    /// the metric the pool is meant to drive down.
    pub(crate) fn acquire(&mut self, device: &wgpu::Device, key: PoolKey, label: &str) -> wgpu::Texture {
        if let Some(t) = self.free.get_mut(&key).and_then(Vec::pop) {
            self.held_bytes = self.held_bytes.saturating_sub(key.approx_bytes());
            crate::vello::prof::add_pool_hit();
            return t;
        }
        crate::vello::prof::add_pool_miss();
        let _tt = crate::vello::prof::now();
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: key.w, height: key.h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: key.format,
            usage: wgpu::TextureUsages::from_bits_truncate(key.usage),
            view_formats: &[],
        });
        crate::vello::prof::add_tex(crate::vello::prof::now() - _tt);
        tex
    }

    /// Pooled drop-in for [`crate::vello::graph::new_target_with_usage`]: a `RENDER_ATTACHMENT |
    /// TEXTURE_BINDING | extra` target of `w×h`, reused from the free list when a matching one was
    /// released last frame. Used for the whole-viewport scratch and the effect-graph pass surfaces so
    /// they stop paying `create_texture` every frame.
    pub(crate) fn acquire_target(
        &mut self,
        device: &wgpu::Device,
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
        extra: wgpu::TextureUsages,
        label: &str,
    ) -> wgpu::Texture {
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | extra;
        self.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, label)
    }

    /// Return a texture for reuse. Its key is read back off the texture, so any texture created through
    /// [`Self::acquire`] round-trips to the right bucket. Over the per-key cap it is simply dropped.
    pub(crate) fn release(&mut self, texture: wgpu::Texture) {
        let key = PoolKey::of(&texture);
        let bytes = key.approx_bytes();
        let bucket = self.free.entry(key).or_default();
        if bucket.len() < MAX_POOL_PER_KEY {
            bucket.push(texture);
            self.held_bytes += bytes;
        }
        if self.held_bytes > MAX_POOL_BYTES {
            self.evict_to_budget();
        }
    }

    /// Drop whole buckets (smallest textures first, so frequently-reused big viewport surfaces
    /// survive) until the pool is back under [`MAX_POOL_BYTES`].
    fn evict_to_budget(&mut self) {
        let mut keys: Vec<PoolKey> = self.free.keys().copied().collect();
        keys.sort_by_key(PoolKey::approx_bytes);
        for key in keys {
            if self.held_bytes <= MAX_POOL_BYTES {
                break;
            }
            if let Some(bucket) = self.free.remove(&key) {
                self.held_bytes =
                    self.held_bytes.saturating_sub(key.approx_bytes() * bucket.len() as u64);
            }
        }
    }
}


static ENCODER_PASSES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Count render/compute passes recorded into caller-owned encoders. On Metal, EVERY pass inside a
/// wgpu command encoder opens its own hal command buffer (plus a wgpu-internal "Pre Pass" twin),
/// and none of them retire until that encoder is submitted — against a hard device budget of 4096
/// outstanding buffers. A whole-viewport frame that folds thousands of effect passes into one
/// encoder loses the device mid-encode, so the frame loop reads this counter and flushes the
/// encoder (submit + fresh encoder) before the pile-up reaches the cap.
/// Which part of the frame a render pass belongs to. "The pass count must drop" is the gate on the
/// coalescing work, and a single total cannot say whether a drop came from the lever being pulled or
/// from somewhere else moving underneath it.
pub(crate) mod pass_kind {
    /// A windowed `fine` segment plus its clear — the front-end's own passes.
    pub const FINE: usize = 0;
    /// One instanced batch stage.
    pub const BATCH: usize = 1;
    /// One step of a per-shape effect chain. This is the population coalescing exists to collapse.
    pub const GRAPH: usize = 2;
    /// A lens stage or a per-shape lens pass.
    pub const UNITS: usize = 3;
    /// A separable blur half issued outside a chain — the per-shape body's layer blur.
    pub const BLUR: usize = 4;
    /// A composite of a finished per-shape result onto the accumulator.
    pub const COMPOSITE: usize = 5;
    /// A blit or a clear.
    pub const BLIT: usize = 6;
    pub const N: usize = 7;
}

static PASS_BUCKETS: [std::sync::atomic::AtomicU32; pass_kind::N] =
    [const { std::sync::atomic::AtomicU32::new(0) }; pass_kind::N];

pub(crate) fn note_passes_of(kind: usize, n: u32) {
    PASS_BUCKETS[kind].fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    ENCODER_PASSES.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
}

/// The per-kind totals, for a harness to diff around a frame the way it diffs the grand total.
#[must_use]
pub fn wv_pass_buckets() -> [u32; pass_kind::N] {
    std::array::from_fn(|i| PASS_BUCKETS[i].load(std::sync::atomic::Ordering::Relaxed))
}

pub(crate) fn note_passes(n: u32) {
    ENCODER_PASSES.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
}

/// Monotonic total of [`note_passes`] increments; callers diff snapshots to measure pressure.
#[unsafe(no_mangle)]
pub extern "C" fn wv_passes_recorded() -> u32 {
    ENCODER_PASSES.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn passes_recorded() -> u32 {
    ENCODER_PASSES.load(std::sync::atomic::Ordering::Relaxed)
}

/// Flush the whole-viewport frame encoder once this many passes piled up since the last flush.
/// Each pass costs ~2 outstanding Metal command buffers, so 768 keeps a comfortable margin under
/// the 4096 device budget even with the front-end's own uncounted dispatches.
const WV_PASS_FLUSH_BUDGET: u32 = 768;

/// The scheduler's GPU production sink. Owns the per-frame surface map and the SrcOver compositor.
pub struct Sink {
    compositor: Compositor,
    unit_pipeline: UnitPipeline,
    /// Instanced batch pipelines (blur H/V + per-round composite), built on first batched frame.
    /// Physical surface per logical ref, this frame. Slice-1 allocates fresh each frame (no
    /// cross-frame reuse yet — that folds in with the tile cache later).
    surfaces: HashMap<SurfaceRef, Surface>,
    /// Surfaces written at least once this frame — first write clears, rest load.
    written: HashSet<SurfaceRef>,
    /// Device-space origin of each `Backdrop` surface (its top-left in **full-zoom** device pixels),
    /// so a `PaintGather` can map the shape's device rect into the backdrop's local texel space.
    backdrop_origin: HashMap<SurfaceRef, (f64, f64)>,
    /// Resolution-cap factor `k ∈ (0, 1]` each `Backdrop` was rendered at (device-px per full-zoom
    /// device-px). `1.0` = drawn at native zoom; `< 1.0` = the effect's reach would have exceeded the
    /// one-tile ring, so it was drawn smaller and is upscaled by `1/k` at the stamp. `PaintGather`
    /// reads it to scale the sigma / lens geometry and the stamp's source rect to match.
    backdrop_scale: HashMap<SurfaceRef, f64>,
    /// Custom-shader render pipelines, cached by WGSL-source hash so an unchanged shader compiles
    /// once, not per frame. Persists across frames (unlike the per-frame surface maps).
    custom_pipelines: HashMap<u64, Rc<wgpu::RenderPipeline>>,

    /// The cross-frame **tile cache**: each *processed* tile keyed by `TileKey`, so a pan re-renders
    /// only the newly-exposed tiles and blits the rest from here. The invalidation + eviction policy
    /// (scale change → drop all, dirty rect → drop covered, LRU beyond budget) is backend-neutral and
    /// lives in [`TileCache`]; this sink only owns the `Surface` values it stores.
    #[cfg(feature = "tiled-scheduler")]
    tile_cache: TileCache<Surface>,

    /// The usage every texture this frame's backend rasterizes into must carry (see
    /// [`RasterBackend::rasterize_target_usage`]). Captured at the top of [`Self::execute`] so the
    /// non-generic allocation helpers (`ensure_surface`, the atlas + scratch textures) can OR it in
    /// without threading the backend through. Hybrid renders as an attachment; classic adds storage.
    raster_usage: wgpu::TextureUsages,

    /// Recycled render-target textures, so a dirty frame reuses last frame's surfaces instead of
    /// `create_texture` per tile/effect/scratch. Fed at frame boundaries + on tile eviction/replace.
    pool: TexturePool,
    /// Textures allocated for this frame that live outside the surface map (the body/spread atlases and
    /// the accumulate scratch): held here until the next frame drains them into [`Self::pool`], so
    /// their in-flight GPU work has flushed before they are reused.
    frame_transient: Vec<wgpu::Texture>,
    /// Effect-graph scratch VIEWS that must outlive the frame's single submit (their textures ride in
    /// `frame_transient`). Only used by the folded whole-viewport gather path, where `run_graph_into`
    /// records into the frame encoder instead of self-submitting. Dropped (cleared) each frame.
    frame_transient_views: Vec<wgpu::TextureView>,

    /// Drop-shadow silhouettes blurred through FINE this frame (`WV_SHADOW_FINE`), keyed by the cell's
    /// `(node, kind, index)`. The fine blur is a mini phased session and the backend holds a single
    /// session, so it cannot nest inside the frame's main phased render — the shadow pre-pass fills this
    /// BEFORE `phased_begin`, and [`Self::wv_paint_path_shadow`] blits the layer out of it during the
    /// round loop. Cleared each frame; the layer textures ride in `frame_transient`.
    shadow_fine: HashMap<(u128, u8, usize), wgpu::TextureView>,

    /// Full-frame OFFSET-SILHOUETTE scratches for SOFT shadows riding the MAIN round loop
    /// (`WV_DROPBLUR_FINE`/`WV_INNERBLUR_FINE`), keyed by the shadow's H (`BlurH`) marker ROUND — so a
    /// shape with several shadows keeps one silhouette per shadow without colliding. Unlike
    /// [`Self::shadow_fine`], this is the RAW (un-blurred) coverage at device position — the H blur marker
    /// reads it as `input_in` inside the main session, so no nested `phased_begin` is needed. Rasterised
    /// before `phased_begin`; the texture rides in `frame_transient`, the view is cleared each frame.
    stack_sil: HashMap<u32, wgpu::TextureView>,

    /// The 2D-blurred PUNCH scratch for an INNER shadow riding the main loop (`WV_INNERBLUR_FINE`), keyed
    /// by the inner's `punch_key` (its H round) — the offset silhouette after blur H+V, written by the
    /// inner V marker and read by the band marker one or more rounds later. Populated during the round
    /// loop; the texture rides in `frame_transient`.
    stack_punch: HashMap<u32, wgpu::TextureView>,

    /// Whole-viewport effect surfaces materialised from the strip by [`Self::wv_atlas_copy_out`]
    /// (only for shapes the batch cannot express), keyed by
    /// `(node, kind, index)` — kind `0` a drop-shadow silhouette, `1` the node's isolated body.
    ///
    /// Every one of these used to be its own `backend.rasterize`, i.e. its own full vello front-end
    /// (~13 dispatches) for a handful of geometry. The prepass draws them all into ONE shelf-packed
    /// atlas with a single front-end and copies each cell out, so the per-surface cost collapses to a
    /// texture copy. Rebuilt every frame; drained into `frame_transient` when the frame ends.
    wv_atlas: HashMap<(u128, u8, usize), (wgpu::Texture, wgpu::TextureView)>,

    /// DEBUG: an atlas captured this frame (view, w, h) to blit over the swapchain so the batched
    /// gather's intermediates can be inspected. Selected by `abi::debug_atlas()`.
    dbg_atlas: Option<(wgpu::TextureView, u32, u32)>,

    /// Real GPU execution time for the frame, bracketed across every pass this sink records. `None`
    /// when the device lacks `TIMESTAMP_QUERY`. Built lazily on the first `execute` because the
    /// queue (needed for the tick period) is not available at construction.
    gpu_timer: Option<crate::vello::gputime::GpuTimer>,
    gpu_timer_tried: bool,

    /// Per-pass GPU timing for the effect graph (lens displacement/refraction/blur/composite), when
    /// `abi::prof_passes()` is set. Shares the lazy build with `gpu_timer`. Threaded into
    /// `run_graph_into` so each gather's passes are bracketed individually.
    pass_prof: Option<crate::vello::gputime::PassProfiler>,

    /// Present-on-demand retained canvas: the last composited whole-viewport frame, kept across frames
    /// (NOT pooled) so a frame where nothing changed can re-present it instead of re-rendering. Tuple
    /// is `(texture, view, width, height)`. `canvas_view` is the device view it was rendered at, so a
    /// pan/zoom (view change) invalidates it. Only used when `abi::present_on_demand()`.
    canvas: Option<(wgpu::Texture, wgpu::TextureView, u32, u32)>,
    canvas_view: Option<Affine>,

    /// The view the *previous* frame ran at, for zoom/pan-proxy settle detection: a frame whose view
    /// differs from this is "actively navigating" and gets a cheap transformed re-blit of the retained
    /// canvas; a frame whose view matches it has settled, so the real render runs and re-sharpens.
    last_view: Option<Affine>,

    /// The whole-viewport gathers list (effect roots, z-indexed) cached across frames: it is a pure
    /// function of the scene, so it stays valid while [`crate::host::scene_epoch`] is unchanged —
    /// which covers idle, pan, zoom and modifier-driven drags, exactly the frames where recomputing
    /// it (a full-scene hash-lookup sweep, ~7ms at 20k shapes on wasm) was pure waste.
    wv_gathers_cache: Option<(u64, Vec<(usize, u128, u8)>, usize)>,

    /// A reusable `TILE_BUFFER²` scratch for the non-`SrcOver` `Composite` path: the target tile buffer
    /// is copied here so the blend shader can sample the destination it is about to overwrite (WebGL2
    /// forbids reading the live render target). Persists across frames (kept, not pooled); a run of
    /// consecutive blend composites in one encoder reuses it in order, which is safe because passes in
    /// an encoder execute in submission order. `(texture, format)` so a format change rebuilds it.
    blend_scratch: Option<(wgpu::Texture, wgpu::TextureFormat)>,

    /// The signed-distance-field bake pipeline for shape-following (`Sampled`) glass — a lens on a path
    /// or other non-box shape reads a baked SDF of its real outline instead of the analytic rounded
    /// box. Built once, lazily (the first sampled lens), since most frames have none.
    sdf_baker: Option<crate::vello::sdf::SdfBaker>,
}

impl Sink {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            unit_pipeline: UnitPipeline::new(device, format),
            surfaces: HashMap::new(),
            written: HashSet::new(),
            backdrop_origin: HashMap::new(),
            backdrop_scale: HashMap::new(),
            custom_pipelines: HashMap::new(),
            #[cfg(feature = "tiled-scheduler")]
            tile_cache: TileCache::new(),
            raster_usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            pool: TexturePool::default(),
            frame_transient: Vec::new(),
            frame_transient_views: Vec::new(),
            shadow_fine: HashMap::new(),
            stack_sil: HashMap::new(),
            stack_punch: HashMap::new(),
            wv_atlas: HashMap::new(),
            dbg_atlas: None,
            gpu_timer: None,
            gpu_timer_tried: false,
            pass_prof: None,
            canvas: None,
            canvas_view: None,
            last_view: None,
            wv_gathers_cache: None,
            blend_scratch: None,
            sdf_baker: None,
        }
    }

    #[cfg(feature = "tiled-scheduler")]
    /// Decide, for this frame, which visible tiles must be (re)rendered. A zoom drops the whole cache
    /// (tile pixels are scale-variant). Otherwise the edited region — the page-space rects the caller
    /// drained from the abi, or everything when `dirty_all` — is invalidated tile by tile, so an edit
    /// rebuilds only the tiles it changed. Whatever visible tiles are then uncached (the invalidated
    /// ones plus the strip a pan just exposed) are returned as dirty; the caller builds the schedule
    /// for exactly them, then calls [`Self::execute`].
    pub fn plan_frame(
        &mut self,
        full_view: Affine,
        width: u32,
        height: u32,
        dirty_all: bool,
        dirty_rects: &[Rect],
    ) -> Vec<TileKey> {
        let rects: std::borrow::Cow<[Rect]> = if dirty_all || dirty_rects.is_empty() {
            std::borrow::Cow::Borrowed(dirty_rects)
        } else {
            let extra = crate::vello::abi::with_scene(|scene, _, modifiers| {
                crate::schedule::gather_dirty_expansion(scene, modifiers, full_view, dirty_rects)
            });
            if extra.is_empty() {
                std::borrow::Cow::Borrowed(dirty_rects)
            } else {
                let mut all = dirty_rects.to_vec();
                all.extend(extra);
                std::borrow::Cow::Owned(all)
            }
        };
        let (dirty, invalidated) =
            self.tile_cache.plan(full_view, width, height, dirty_all, &rects);
        for s in invalidated {
            self.pool.release(s.texture);
        }
        dirty
    }

    #[cfg(feature = "tiled-scheduler")]
    /// Execute one frame's schedule onto `surface` (the swapchain texture).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub fn execute<B: RasterBackend>(
        &mut self,
        schedule: &Schedule,
        dirty: &[TileKey],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface: &wgpu::Texture,
        root: Affine,
        width: u32,
        height: u32,
    ) {
        for (_, s) in self.surfaces.drain() {
            self.pool.release(s.texture);
        }
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
        let gp = &schedule.gather_plan;
        crate::vello::prof::dbg_set(8, gp.total() as f64);
        crate::vello::prof::dbg_set(9, gp.deferrable_count() as f64);
        crate::vello::prof::dbg_set(10, gp.estimated_passes() as f64);
        crate::vello::prof::dbg_set(11, gp.batched_dispatches() as f64);
        self.raster_usage = backend.rasterize_target_usage();
        let full_view = crate::vello::abi::effective_view(root);
        let format = surface.format();
        let sw_view = surface.create_view(&wgpu::TextureViewDescriptor::default());

        let safe = backend.batched_submits_safe();
        let batch = if safe { crate::vello::abi::sink_batch() } else { 1 };
        let mut frame_enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });

        if !self.gpu_timer_tried {
            self.gpu_timer_tried = true;
            self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.begin();
        }

        let bg = crate::vello::abi::background().components;
        Compositor::clear(
            &mut frame_enc,
            &sw_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
            self.gpu_timer.as_ref().and_then(crate::vello::gputime::GpuTimer::start_writes),
        );

        let gather_groups: Vec<Vec<usize>> = if crate::vello::abi::gather_batch() {
            schedule.gather_plan.batched_groups()
        } else {
            Vec::new()
        };
        let batched_gathers: HashMap<u128, usize> = gather_groups
            .iter()
            .flatten()
            .map(|&gi| (schedule.gather_plan.gathers[gi].shape, gi))
            .collect();
        let mut atlased =
            self.atlas_effects(&schedule.steps, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(5, atlased.len() as f64);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        let fused = if crate::vello::abi::no_fuse() {
            HashSet::new()
        } else {
            self.atlas_fuse(&schedule.steps, &batched_gathers, backend, device, queue, &mut frame_enc, root, full_view, format)
        };
        crate::vello::prof::dbg_set(6, fused.len() as f64);
        atlased.extend(fused);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        let prepassed = self.atlas_prepass(&schedule.steps, &atlased, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(7, prepassed.len() as f64);
        atlased.extend(prepassed);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        crate::vello::prof::dbg_set(12, schedule.steps.len() as f64);
        crate::vello::prof::dbg_set(13, schedule.steps.iter().filter(|s| matches!(s, Step::Paint { .. })).count() as f64);
        crate::vello::prof::dbg_set(14, schedule.steps.iter().filter(|s| matches!(s, Step::Composite { .. })).count() as f64);

        let mut finalize: Vec<usize> = Vec::new();

        let mut batched = 0_u32;
        for (i, step) in schedule.steps.iter().enumerate() {
            if atlased.contains(&i) {
                continue;
            }
            if let Step::ComposeBackdrop { shape, .. } = step {
                if batched_gathers.contains_key(shape) {
                    continue;
                }
            }
            if let Step::PaintGather { shape, .. } = step {
                if batched_gathers.contains_key(shape) {
                    continue;
                }
            }
            if let Step::Composite { to, .. } = step {
                if to.is_target() {
                    finalize.push(i);
                    continue;
                }
            }
            match step {
                Step::Paint { ops, clip, write_to } => {
                    crate::vello::prof::inc_paint();
                    self.paint(ops, *write_to, *clip, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::Composite { from, to, paint, rect, .. } => {
                    crate::vello::prof::inc_composite();
                    let _tbl = crate::vello::prof::now();
                    self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                    crate::vello::prof::add_blit(crate::vello::prof::now() - _tbl);
                }
                Step::ComposeBackdrop { read_from, extent, reach, always_cap, acceptable_downscale, tile_mode, write_to, .. } => {
                    crate::vello::prof::inc_gather();
                    self.compose_backdrop(read_from, *extent, *reach, *always_cap, f64::from(*acceptable_downscale), *tile_mode, *write_to, device, &mut frame_enc, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    crate::vello::prof::inc_gather();
                    self.paint_gather(*backdrop, *clip, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::Snapshot { from, write_to } => {
                    self.snapshot(*from, *write_to, device, &mut frame_enc);
                }
                Step::PaintPathShadow { shape, shadow, sigma, extent, write_to, .. } => {
                    self.paint_path_shadow(*shape, *shadow, *sigma, *extent, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::PaintInnerShadow { shape, shadow, sigma, extent, write_to, .. } => {
                    self.paint_inner_shadow(*shape, *shadow, *sigma, *extent, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                _ => {}
            }
            batched += 1;
            if batch != 0 && batched >= batch {
                Self::submit_batch(&mut frame_enc, device, queue, backend);
                batched = 0;
            }
        }

        if !gather_groups.is_empty() {
            self.atlas_gather(&schedule.gather_plan, &gather_groups, backend, device, queue, &mut frame_enc, root, full_view, format);
            if !safe {
                Self::submit_batch(&mut frame_enc, device, queue, backend);
            }
        }
        for &i in &finalize {
            if let Step::Composite { from, to, paint, rect, .. } = &schedule.steps[i] {
                crate::vello::prof::inc_composite();
                let _tbl = crate::vello::prof::now();
                self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                crate::vello::prof::add_blit(crate::vello::prof::now() - _tbl);
            }
        }

        self.tile_cache.advance_frame();
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();

        for &t in dirty {
            let key = SurfaceRef::tile_ref(SurfaceRole::TileOutput, t);
            if let Some(old) = self.tile_cache.store(t, self.surfaces.remove(&key)) {
                self.pool.release(old.texture);
            }
        }

        let visible = tiling::visible_tiles(full_view, width, height);
        let mut reused = 0u32;
        for &t in &visible {
            if dirty_set.contains(&t) {
                continue;
            }
            let Some(view) = self.tile_cache.get(t).map(|s| s.view.clone()) else {
                continue;
            };
            self.blit_tile(device, &mut frame_enc, &sw_view, t, &view, full_view, width, height);
            self.tile_cache.touch(t);
            reused += 1;
        }
        if let Some((view, aw, ah)) = self.dbg_atlas.take() {
            self.compositor.blit(device, &mut frame_enc, &sw_view, (width as f32, height as f32), &Blit {
                src: &view,
                dst: (0.0, 0.0, aw as f32, ah as f32),
                src_rect: (0.0, 0.0, aw as f32, ah as f32),
                src_size: (aw as f32, ah as f32),
                alpha: 1.0,
            });
        }
        crate::vello::abi::set_tile_stats(u32::try_from(dirty.len()).unwrap_or(u32::MAX), reused);

        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut frame_enc, &sw_view);
            t.resolve(&mut frame_enc);
        }

        let _tsu = crate::vello::prof::now();
        crate::vello::prof::inc_submit();
        queue.submit([frame_enc.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }

        for s in self.tile_cache.evict(&visible) {
            self.pool.release(s.texture);
        }
    }

    /// Whole-viewport render (vello-native): the ENTIRE document is ONE vello scene driven through
    /// ONE pipeline. The scene walk records a native `CMD_EFFECT` boundary marker at every effect
    /// node, the front-end (flatten/bin/coarse) runs ONCE over the whole draw range, and each backdrop
    /// segment is painted by a lone `fine` dispatch over the shared PTCL. Effect work (gather stamps,
    /// shadow/blur stacks) records BETWEEN fine segments into the same encoder, and the whole frame is
    /// a single `queue.submit`. A frame with no effect nodes is the degenerate case — no boundaries,
    /// one fine segment. Gated by `abi::whole_viewport()`; the tiled scheduler remains the hybrid
    /// backend's path.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub fn render_whole_viewport<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::Texture,
        root: Affine,
        width: u32,
        height: u32,
        content_dirty: bool,
    ) {
        let format = wgpu::TextureFormat::Rgba8Unorm;
        self.raster_usage = backend.rasterize_target_usage();
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        self.shadow_fine.clear();
        self.stack_sil.clear();
        self.stack_punch.clear();
        let full_view = crate::vello::abi::effective_view(root);
        let sz = (width as f32, height as f32);
        let sw_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        if crate::vello::abi::present_on_demand() {
            let view_changed = self.canvas_view != Some(full_view);
            let dims_changed = self.canvas.as_ref().is_none_or(|c| c.2 != width || c.3 != height);
            if !(content_dirty || view_changed || dims_changed) {
                if let Some((_, cv, _, _)) = self.canvas.as_ref() {
                    let cv = cv.clone();
                    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("wv present-on-demand"),
                    });
                    self.blit_full(&mut enc, device, &sw_view, &cv, sz);
                    crate::vello::prof::inc_submit();
                    queue.submit([enc.finish()]);
                                backend.after_submit();
                    crate::vello::prof::dbg_add(24, 1.0);
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }

        if crate::vello::abi::present_on_demand() && crate::vello::abi::zoom_proxy() {
            let moving = self.last_view.is_some_and(|v| v != full_view);
            let dims_ok = self.canvas.as_ref().is_some_and(|c| c.2 == width && c.3 == height);
            if moving && !content_dirty && dims_ok {
                if let (Some((_, cv, _, _)), Some(cview)) = (self.canvas.as_ref(), self.canvas_view) {
                    let cv = cv.clone();
                    let d = (full_view * cview.inverse()).as_coeffs();
                    let (a, dd, e, f) = (d[0] as f32, d[3] as f32, d[4] as f32, d[5] as f32);
                    let bg = crate::vello::abi::background().components;
                    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("wv zoom-proxy"),
                    });
                    Compositor::clear(&mut enc, &sw_view,
                        [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
                    self.compositor.blit(device, &mut enc, &sw_view, sz, &Blit {
                        src: &cv,
                        dst: (e, f, a * width as f32, dd * height as f32),
                        src_rect: (0.0, 0.0, sz.0, sz.1),
                        src_size: sz,
                        alpha: 1.0,
                    });
                    crate::vello::prof::inc_submit();
                    queue.submit([enc.finish()]);
                                backend.after_submit();
                    crate::vello::prof::dbg_add(25, 1.0);
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }
        self.last_view = Some(full_view);

        let _tgd = crate::vello::prof::now();
        let epoch = crate::host::scene_epoch();
        let (gathers, root_count) = match &self.wv_gathers_cache {
            Some((e, g, rc)) if *e == epoch => (g.clone(), *rc),
            _ => {
                let gathers: Vec<(usize, u128, u8)> = crate::vello::abi::with_scene(|live, _, _| {
                    live.roots()
                        .iter()
                        .enumerate()
                        .filter_map(|(i, &id)| {
                            let n = live.get(id)?;
                            let non_box = matches!(n.kind, crate::model::ShapeKind::Path | crate::model::ShapeKind::Text);
                            let has_gather = n.background_blur.is_some() || n.glass.is_some() || n.gather_shader().is_some() || n.background_tint.is_some() || n.background_field.is_some();
                            let has_silhouette_shadow = non_box && !n.shadows.is_empty();
                            // Ask what the node LOWERS TO, not which authoring fields it happens to
                            // set: any effect that replaces the body runs through the stack path, so
                            // a filter graph gets there the same way a layer blur does. Re-listing
                            // the fields here is what kept filter graphs from rendering at all.
                            let replaces_body = crate::effect::effect_stack(n)
                                .iter()
                                .any(|e| e.compose == crate::effect::Compose::Replace);
                            let needs_stack = has_silhouette_shadow || replaces_body;
                            if needs_stack {
                                Some((i, id, FX_STACK))
                            } else if has_gather {
                                Some((i, id, FX_GATHER))
                            } else {
                                None
                            }
                        })
                        .collect()
                });
                let root_count = crate::vello::abi::with_scene(|live, _, _| live.roots().len());
                self.wv_gathers_cache = Some((epoch, gathers.clone(), root_count));
                (gathers, root_count)
            }
        };
        crate::vello::prof::dbg_add(26, crate::vello::prof::now() - _tgd);

        if gathers.is_empty() && root_count == 0 {
            let bg = crate::vello::abi::background().components;
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("whole-viewport"),
            });
            Compositor::clear(&mut enc, &sw_view,
                [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
            crate::vello::prof::inc_submit();
            queue.submit([enc.finish()]);
                backend.after_submit();
            return;
        }

        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("whole-viewport") });
        let mut flush_mark = passes_recorded();

        if !self.gpu_timer_tried {
            self.gpu_timer_tried = true;
            self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
            if crate::vello::abi::prof_passes() {
                self.pass_prof = crate::vello::gputime::PassProfiler::new(device, queue);
            }
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.begin();
            t.begin_pass(&mut enc, &sw_view);
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.begin();
        }
        let _tenc = crate::vello::prof::now();
        // The stack-effect sources ride in a strip below the viewport inside ONE enlarged
        // accumulator, so the whole frame — document plus every source surface — is a single tile
        // grid and therefore a single front-end run. They are encoded FIRST, ahead of every
        // CMD_EFFECT marker, which puts their (marker-free) tiles in the first fine window and
        // excludes them from all later ones. `None` = the strip did not fit or is disabled, and the
        // separate prepass render below fills the sources instead.
        let strip = self.wv_strip_plan(&gathers, device, full_view, width, height);
        // The strip starts on a TILE boundary, not directly under the viewport. `fine` works a tile
        // at a time, so a viewport whose height is not a multiple of the tile size leaves its last
        // tile row straddling the boundary — the first strip cell would then share tiles with the
        // frame's bottom rows, and a cell drawn with `Copy` reaches them. Rounding up costs at most
        // one tile row of texture and makes the two regions tile-disjoint by construction.
        let strip_y = strip.as_ref().map_or(height, |_| height.next_multiple_of(TILE_PX));
        let strip_h = strip.as_ref().map_or(0, |(p, _)| p.height);
        let acc_h = strip_y + strip_h;
        let acc_sz = (width as f32, acc_h as f32);
        let mut scene = backend.new_scene(width as u16, acc_h as u16);

        let reaches: Vec<[f32; 4]> = gathers
            .iter()
            .map(|&(_, gid, kind)| {
                wv_clamp_reach(self.wv_marker_reach(gid, kind, full_view, width, height), width, height)
            })
            .collect();
        let rounds = wv_rounds(&reaches, width, height);
        // A separable blur needs TWO consecutive windows — H writes the draft, V composites — that must
        // not collide: a round can't be one blur's V and another's H, and an H window's dispatch target
        // is the draft, so nothing else may share it. Stretch the timeline: every effect's round
        // doubles (2r), and each fine blur's H pass takes the dedicated ODD round just before it (2r-1).
        // Blur-H rounds are then exclusively blur H; V and every other effect land on even rounds.
        // Reach-disjoint parallelism is preserved (same relative order, wider gaps between rounds).
        let blur_gather: Vec<bool> = if wv_blur_fine() {
            gathers
                .iter()
                .map(|&(_, gid, kind)| {
                    kind != FX_STACK
                        && crate::vello::abi::with_scene(|live, _, _| live.get(gid).and_then(|n| n.background_blur)).is_some()
                })
                .collect()
        } else {
            vec![false; gathers.len()]
        };
        // A FROSTED lens is a five-link chain (warp → blur H → blur V → scatter → tail) that
        // materialises intermediates, so it reserves a 5-round BLOCK — its markers land at the block's
        // consecutive rounds and each is dispatched to the right scratch surface below.
        let frost_gather: Vec<bool> = if wv_frost_fine() {
            gathers
                .iter()
                .map(|&(_, gid, kind)| kind != FX_STACK && self.wv_frost_passes(gid, full_view, width, height).is_some())
                .collect()
        } else {
            vec![false; gathers.len()]
        };
        // Glass-in-a-stack rides fine (gated `WV_STACK_GATHER_FINE`): a stack whose BACKDROP is a glass
        // fractures — its z-below layers (drops) composite at the block's FIRST round, the glass RELOADS
        // that materialised backdrop at the next round(s), and the body/inner composite on the last.
        // SHARP glass is a single reload marker (2-round block); FROSTED is the 5-link chain (6-round
        // block, the chain OFFSET one round past the drops). A pure-sharp frame skips the block layout and
        // uses the cheaper ×2 doubling instead. `stack_fine[gid]` = the sharp descriptor;
        // `stack_frost[gid]` = the frosted 5-descriptor chain — a stack is in at most one.
        let mut stack_fine: std::collections::HashMap<u128, [f32; 26]> = if wv_stack_gather_fine() {
            gathers
                .iter()
                .filter(|(_, _, k)| *k == FX_STACK)
                .filter_map(|&(_, gid, _)| {
                    let u = self.wv_lens_fine_uniform(gid, full_view, width, height)?;
                    let mut d = [0.0f32; 26];
                    d[0] = 56.0; // bits = SHADE(8) | MASKMIX(16) | WARP(32)
                    d[1] = 1.0; // program = lens
                    d[2..26].copy_from_slice(&u);
                    Some((gid, d))
                })
                .collect()
        } else {
            std::collections::HashMap::new()
        };
        let stack_frost: std::collections::HashMap<u128, Vec<[f32; 26]>> = if wv_stack_frost_fine() && wv_frost_fine() {
            gathers
                .iter()
                .filter(|(_, _, k)| *k == FX_STACK)
                .filter_map(|&(_, gid, _)| self.wv_frost_passes(gid, full_view, width, height).map(|c| (gid, c)))
                .collect()
        } else {
            std::collections::HashMap::new()
        };
        // Emitter-swap (WV_DAG): build + fill the whole-frame DAG once so an effect's descriptor comes
        // from the scheduler's baked units (`bake`) instead of the per-effect planner. Filled at the whole
        // viewport (origin 0, k=1). Built here — before stack_shadows — so both the shadow plan and fx_fine
        // source from it.
        let wv_dag_graph = wv_dag().then(|| {
            let mut d = crate::vello::frame_dag::build_frame_dag_installed();
            crate::vello::abi::with_scene(|scene, _viewport, modifiers| {
                d.fill_lens_uniforms(full_view, width, height, |id| {
                    let n = scene.get(id)?;
                    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    crate::effect_graph::lens_geometry(n, m)
                });
            });
            // The blur half of the fill: a PURE background blur (a blur, no lens) gets its device sigma
            // stamped so its axis passes drive through `arms_for`. A frost blur (blur WITH a lens) is left
            // page-space — `arms_for` gates it out and it rides the planner.
            d.fill_blur_uniforms(|id| {
                let pure_blur = crate::vello::abi::with_scene(|live, _, _| {
                    live.get(id).map(|n| n.background_blur.is_some() && n.glass.is_none())
                })
                .unwrap_or(false);
                pure_blur.then(|| self.gather_sigma(id, full_view, 1.0))
            });
            // The shadow half of the fill: device sigma + straight colour for each shadow slot, so the
            // DAG's shadow nodes carry device values (elision + the edge-driven dispatch read them).
            let cs = full_view.as_coeffs();
            let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
            // Any shadow slot (drop OR inner) — the blur sigma (drop's governing blur / inner's EraseBy
            // blur) and the tint colour, in DEVICE units, so the elision below sees device sigmas.
            let shadow_at = |id: u128, slot: usize| -> Option<crate::effect::Effect> {
                crate::vello::abi::with_scene(|live, _, _| {
                    let n = live.get(id)?;
                    let e = crate::effect::effect_stack(n).into_iter().nth(slot)?;
                    matches!(e.source, crate::effect::Source::Coverage { .. }).then_some(e)
                })
            };
            d.fill_shadow_uniforms(
                |id, slot| {
                    shadow_at(id, slot).map(|e| {
                        let r = match e.compose {
                            crate::effect::Compose::Over => e.ops.iter().find_map(|op| match op {
                                crate::effect::Op::EraseBy { blur, .. } => Some(*blur),
                                crate::effect::Op::Blur { radius } => Some(*radius),
                                _ => None,
                            }),
                            _ => e.governing_blur(),
                        };
                        crate::blur::radius_to_sigma(r.unwrap_or(0.0)) * scale
                    })
                },
                |id, slot| {
                    shadow_at(id, slot).and_then(|e| {
                        e.ops.iter().find_map(|op| match op {
                            crate::effect::Op::Tint(c) => Some(c.components),
                            _ => None,
                        })
                    })
                },
            );
            // Scheduler simplification: drop the sub-pixel blurs → a sharp shadow's composite edge lands on
            // the silhouette and rides the SAME edge-driven dispatch as a soft one (no sharp lane).
            d.elide_negligible_blurs();
            d
        });
        // Shadows (drops AND inners, any number, mixed, SHARP or SOFT) on a Path/Text stack ride the MAIN
        // loop as per-shadow blocks (gated `WV_DROPBLUR_FINE`/`WV_INNERBLUR_FINE`/`WV_SPREAD_FINE`), retiring
        // the pre-pass. One `Vec<ShadowMarker>` per node holds every shadow in z-order — drops under the
        // body, inners over it; a sharp drop is a single composite marker (no blur), a soft shadow an H/V
        // block. A stack is in at most one of stack_fine/frost/shadows. Under WV_DAG an all-soft-drop shape
        // sources its markers from the DAG (`wv_shadow_plan_dag`); every other case falls back to
        // `wv_shadow_plan`, which returns `None` (→ pre-pass) if a shadow's gate is off, a sharp INNER is
        // present, or the node is not a Path/Text.
        let stack_shadows: std::collections::HashMap<u128, Vec<ShadowMarker>> =
            if wv_dropblur_fine() || wv_innerblur_fine() || wv_spread_fine() {
                gathers
                    .iter()
                    .filter(|(_, _, k)| *k == FX_STACK)
                    .filter(|(_, gid, _)| !stack_fine.contains_key(gid) && !stack_frost.contains_key(gid))
                    .filter_map(|&(_, gid, _)| {
                        wv_dag_graph
                            .as_ref()
                            .and_then(|d| self.wv_shadow_plan_dag(gid, d))
                            .or_else(|| self.wv_shadow_plan(gid, full_view, width, height))
                            .map(|c| (gid, c))
                    })
                    .collect()
            } else {
                std::collections::HashMap::new()
            };
        // Shape-following (`Sampled`) glass: for each SHARP stack whose shape is a PATH the field distance
        // comes from a baked SDF of the real outline, not the analytic box — flip the descriptor to program
        // 4 with `decode` in the corner slot (`u[1].z` = `d[8]`). A FROSTED stack does NOT need this: its
        // TAIL clips to the silhouette (`area[i]`) so the shape follows regardless, and the warp
        // displacement is washed out by the blur — so the SDF there was invisible. Gated `WV_GLASS_SHAPE`.
        let stack_sdf: std::collections::HashMap<u128, (Vec<[f32; 4]>, (u32, u32, u32, u32), f32)> =
            if wv_glass_shape_fine() {
                stack_fine
                    .keys()
                    .copied()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .filter_map(|gid| {
                        let segs = self.wv_lens_sdf_segments(gid, full_view)?;
                        let (bx, by, bw, bh, _k) = self.wv_lens_box(gid, full_view, width, height)?;
                        // half = u[1].xy = uni[4], uni[5]; decode sizes the box so interior distances
                        // stay in the encoded [0, 1] range.
                        let u = self.wv_lens_fine_uniform(gid, full_view, width, height)?;
                        let decode = 2.0 * u[4].max(u[5]);
                        Some((gid, (segs, (bx, by, bw, bh), decode)))
                    })
                    .collect()
            } else {
                std::collections::HashMap::new()
            };
        for (gid, (_, _, decode)) in &stack_sdf {
            if let Some(d) = stack_fine.get_mut(gid) {
                d[1] = 4.0; // program = sampled lens (baked SDF)
                d[8] = *decode; // u[1].z = decode
            }
        }
        let frost_stack_gather: Vec<bool> =
            gathers.iter().map(|&(_, gid, _)| stack_frost.contains_key(&gid)).collect();
        // A sharp GLASS stack wants a 2-round block (drops at the block start, glass reload one round later).
        let sharp_stack_gather: Vec<bool> =
            gathers.iter().map(|&(_, gid, _)| stack_fine.contains_key(&gid)).collect();
        // A SOFT-shadow stack blurs each shadow H→V (drop composites, inner materialises a punch) then the
        // body then the inner bands — a per-shadow block ([`shadow_span`]), so like frost it needs the
        // CONTIGUOUS-block layout (the ×2 doubling only frees ONE slot). Its presence forces block mode.
        let shadow_stack_gather: Vec<bool> =
            gathers.iter().map(|&(_, gid, _)| stack_shadows.contains_key(&gid)).collect();
        let any_frost = frost_gather.iter().any(|&f| f) || frost_stack_gather.iter().any(|&f| f);
        let any_block = any_frost || shadow_stack_gather.iter().any(|&f| f);
        let mut rounds: Vec<u32> = if any_block {
            // With a frosted chain in play the timeline is laid out in CONTIGUOUS blocks, grouped by the
            // reach round (z-order) and, within each, by kind — standalone frost (5 rounds), a frosted
            // stack (6 = drops + 5), a sharp stack (2 = drops + glass), blur (2), the rest (1). Two rules
            // drive it: (a) different-KIND links write different scratch targets, so they must not share a
            // round; (b) the window tracking the routing keys on breaks on a GAP, so blocks pack with no
            // empty rounds between them. Reach-disjoint gathers of the SAME kind and reach round share one
            // block (their scratch writes land in disjoint regions).
            let base = rounds.clone();
            let max_base = base.iter().copied().max().unwrap_or(0);
            let mut out = vec![0u32; gathers.len()];
            let mut cursor = 1u32;
            let lay = |out: &mut Vec<u32>, cursor: &mut u32, pick: &dyn Fn(usize) -> bool, span: u32| {
                let group: Vec<usize> = (0..gathers.len()).filter(|&j| pick(j)).collect();
                if !group.is_empty() {
                    for &j in &group {
                        out[j] = *cursor;
                    }
                    *cursor += span;
                }
            };
            for br in 0..=max_base {
                lay(&mut out, &mut cursor, &|j| base[j] == br && frost_gather[j], 5);
                // 7 = drops + 5 frost links + a trailing round for the BODY. The body must land the round
                // AFTER the frost tail: an imperative paint at round X runs BEFORE the fine marker at
                // round X (whose window is [X,X+1), dispatched next iteration), so a body sharing the tail
                // round would be OVERWRITTEN by the tail's masked composite (it reads base_in = the body).
                lay(&mut out, &mut cursor, &|j| base[j] == br && frost_stack_gather[j], 7);
                lay(&mut out, &mut cursor, &|j| base[j] == br && sharp_stack_gather[j], 2);
                // Each SOFT-shadow stack gets its OWN block of `shadow_span` rounds (per-shadow H/V pairs +
                // the body + the inner bands). The silhouette/punch/draft scratches are keyed by ROUND, so
                // two stacks must not share a block (unlike same-kind frost blocks, whose scratches are
                // gid-keyed); lay them one at a time in gather order, each advancing the cursor by its span.
                for j in 0..gathers.len() {
                    if base[j] == br && shadow_stack_gather[j] {
                        out[j] = cursor;
                        cursor += shadow_span(&stack_shadows[&gathers[j].1]);
                    }
                }
                lay(&mut out, &mut cursor, &|j| base[j] == br && blur_gather[j] && !frost_gather[j], 2);
                lay(&mut out, &mut cursor, &|j| {
                    base[j] == br && !frost_gather[j] && !frost_stack_gather[j] && !sharp_stack_gather[j] && !shadow_stack_gather[j] && !blur_gather[j]
                }, 1);
            }
            out
        } else {
            rounds
                .iter()
                .zip(&blur_gather)
                .map(|(&r, &b)| if b { (2 * r).saturating_sub(1) } else { 2 * r })
                .collect()
        };
        // No frost anywhere: sharp stacks ride the cheaper ×2 doubling — every round doubles, freeing the
        // odd "R+1" slot for a stack's glass reload without colliding with a separable blur's H/V pair
        // (which stay a consecutive pair below their ×2 grid point).
        if !any_block && !stack_fine.is_empty() {
            for r in &mut rounds {
                *r *= 2;
            }
        }
        // Now that each shadow stack's block start (`rounds[j]`) is fixed, assign absolute rounds to its
        // per-shadow markers — one `Vec<ShadowMk>` the marker emission, window plan, silhouette rasterise,
        // and dispatch all read (so the round assignment is computed ONCE). Keyed by gid.
        let shadow_sched: std::collections::HashMap<u128, Vec<ShadowMk>> = gathers
            .iter()
            .enumerate()
            .filter_map(|(j, &(_, gid, _))| {
                // WV_DAG_EXEC (stage 1): derive the schedule straight from the DAG for a soft-drop shape;
                // otherwise (and for any sharp/inner shape) the effect-stack `schedule_shadows`. The two
                // are byte-identical where both fire, so downstream is unchanged.
                let dag_sched = wv_dag_exec()
                    .then(|| wv_dag_graph.as_ref().and_then(|d| self.wv_shadow_sched_dag(gid, d, rounds[j])))
                    .flatten();
                dag_sched
                    .or_else(|| stack_shadows.get(&gid).map(|plan| schedule_shadows(plan, rounds[j])))
                    .map(|sched| (gid, sched))
            })
            .collect();
        // WV_DAG_EXEC: the edge-driven dispatch plan for each soft-drop shape — DAG nodes the round loop
        // binds by edge (node scratches) instead of the `DropBlurH`/`DropBlurV` roles. Descriptor delivery
        // still rides `shadow_sched`/`stack_markers` (same rounds); only the binding moves to the DAG.
        let dag_shadow: std::collections::HashMap<u128, DagShadow> = if wv_dag_exec() {
            shadow_sched
                .iter()
                .filter_map(|(&gid, sched)| {
                    wv_dag_graph.as_ref().and_then(|d| self.wv_dag_shadow(gid, d, sched)).map(|ds| (gid, ds))
                })
                .collect()
        } else {
            std::collections::HashMap::new()
        };
        // WV_DAG_EXEC: the sharp glass warp for each stack shape — the warp node the reload window binds
        // by edge, plus its SDF source node (Some for a shape-following lens, None for an analytic box).
        // Descriptor delivery still rides `stack_markers` (same round); only the binding moves to the DAG.
        let dag_glass: std::collections::HashMap<u128, (usize, Option<usize>)> = if wv_dag_exec() {
            stack_fine
                .keys()
                .filter_map(|&gid| {
                    wv_dag_graph.as_ref().and_then(|d| self.wv_dag_glass(gid, d)).map(|w| (gid, w))
                })
                .collect()
        } else {
            std::collections::HashMap::new()
        };
        // A sharp stack's glass reload + body land ONE round past its drops (the block/×2 both put the
        // drops at rounds[j]). A frosted stack's chain runs at rounds[j]+1..+5 and its body on the tail
        // (round +5). `stack_reload_sub[gid]` = the round OFFSET at which the body composites (1 sharp,
        // 5 frosted, a soft-shadow stack's pre-body round count) — the fracture phase `wv_paint_stack`
        // paints its post-backdrop layers at.
        let stack_reload_sub: std::collections::HashMap<u128, u32> = gathers
            .iter()
            .filter_map(|&(_, gid, _)| {
                if stack_frost.contains_key(&gid) {
                    Some((gid, 6))
                } else if let Some(plan) = stack_shadows.get(&gid) {
                    // Body composites after all the pre-body H/V rounds; the inner bands follow.
                    Some((gid, shadow_pre_rounds(plan)))
                } else if stack_fine.contains_key(&gid) {
                    // Sharp glass reload at the block start; body one round later.
                    Some((gid, 1))
                } else {
                    None
                }
            })
            .collect();
        let mut max_round = rounds.iter().copied().max().unwrap_or(0);
        for (j, &(_, gid, _)) in gathers.iter().enumerate() {
            if let Some(&s) = stack_reload_sub.get(&gid) {
                max_round = max_round.max(rounds[j] + s);
            }
            // A soft-shadow stack's last inner band sits at rounds[j] + span - 1, past reload_sub.
            if let Some(plan) = stack_shadows.get(&gid) {
                max_round = max_round.max(rounds[j] + shadow_span(plan) - 1);
            }
        }
        // Effects-in-fine WARP gathers (linchpin, gated `WV_GLASS_FINE=1`): a sharp glass routed
        // through `fine` instead of the batched lens stages. Each needs a RELOAD round after its
        // backdrop materialises (so `base_in` holds it) — hence `max_round >= its round + 1` — and its
        // device-space lens uniform, keyed by gid. Excluded from `wv_lens_plan` below so it renders
        // once, and it forces the ping-pong path (`base_in` is unbound in the rw accumulator).
        // wv_dag_graph (the filled whole-frame DAG) is built above, before stack_shadows.
        let fx_fine: std::collections::HashMap<u128, Vec<[f32; 26]>> = if wv_glass_fine() || wv_blur_fine() || wv_frost_fine() {
            gathers
                .iter()
                .enumerate()
                .filter(|(_, g)| g.2 != FX_STACK)
                .filter_map(|(j, &(_, gid, _))| {
                    // WV_DAG: the scheduler's baked descriptor where its arm structure matches current
                    // fine (sharp glass); otherwise the planner. Byte-identical where both fire.
                    let passes = wv_dag_graph
                        .as_ref()
                        .and_then(|d| self.wv_dag_glass_passes(gid, d))
                        .or_else(|| self.wv_fine_passes(gid, full_view, width, height));
                    passes.map(|passes| {
                        // Each pass is one marker in a successive reload window (glass 1, blur H+V 2).
                        max_round = max_round.max(rounds[j] + passes.len() as u32);
                        (gid, passes)
                    })
                })
                .collect()
        } else {
            std::collections::HashMap::new()
        };

        // As many scratch atlases as the stage colouring asked for — A4's chromatic number, not a
        // pair this function decided on. Textures and their views are kept apart so the views can be
        // borrowed as a slice for the executor.

        // Effects-in-fine: descriptors for effects that run INLINE in fine (backdrop-tint so far).
        // Each is [bits, program, then the 24-float unit uniform]; the marker carries its float offset
        // in p2 and the driver skips its post-fine pass. Empty → fine renders exactly as before.
        const FX_TINT_ID: u32 = 100;
        // Same inline effect (>= EFFECT_INLINE_BASE), but coarse rasterises its coverage over the REACH
        // rect instead of the shape silhouette — the separable blur's H pass, whose draft the V pass
        // samples up to its radius PAST the silhouette; without the dilated coverage the draft is only
        // H-blurred inside the silhouette and the V taps beyond it read the sharp backdrop (bands).
        const FX_TINT_DILATED_ID: u32 = 101;
        let mut fx_params: Vec<f32> = Vec::new();
        let mut fx_offset: HashMap<u128, u32> = HashMap::new();
        // A fine gather emits ONE marker per pass, at successive rounds R, R+1, … — the separable blur
        // is two markers (H, V), the planner's whole say over the passes; the executor runs each.
        let mut fx_markers: HashMap<u128, Vec<(u32, u32)>> = HashMap::new();
        // A fine-backdrop STACK's glass markers as (round, fx_params offset): SHARP glass is one marker
        // at the reload round R+1; FROSTED is the 5-link chain at R+1..R+5. Emitted beside the eid=6
        // window marker in the draw loop below. All use DILATED coverage (see there).
        let mut stack_markers: HashMap<u128, Vec<(u32, u32)>> = HashMap::new();
        for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
            if kind == FX_STACK {
                if let Some(d) = stack_fine.get(&gid) {
                    let off = fx_params.len() as u32;
                    fx_params.extend_from_slice(d);
                    stack_markers.insert(gid, vec![(rounds[j] + 1, off)]);
                } else if let Some(chain) = stack_frost.get(&gid) {
                    let markers = chain
                        .iter()
                        .enumerate()
                        .map(|(p, d)| {
                            let off = fx_params.len() as u32;
                            fx_params.extend_from_slice(d);
                            (rounds[j] + 1 + p as u32, off)
                        })
                        .collect();
                    stack_markers.insert(gid, markers);
                } else if let Some(sched) = shadow_sched.get(&gid) {
                    // Soft shadows: one marker per scheduled `ShadowMk`, at its assigned round. Drops blur
                    // H→V (V composites under the body); inners blur H→V (V materialises the punch) with a
                    // band over the body. The per-marker eid is picked at emission from the mk's role.
                    let markers = sched
                        .iter()
                        .map(|mk| {
                            let off = fx_params.len() as u32;
                            fx_params.extend_from_slice(&mk.desc);
                            (mk.round, off)
                        })
                        .collect();
                    stack_markers.insert(gid, markers);
                }
                continue;
            }
            if let Some(passes) = fx_fine.get(&gid) {
                let markers = passes
                    .iter()
                    .enumerate()
                    .map(|(p, d)| {
                        let off = fx_params.len() as u32;
                        fx_params.extend_from_slice(d);
                        (rounds[j] + p as u32, off)
                    })
                    .collect();
                fx_markers.insert(gid, markers);
                continue;
            }
            // Descriptor layout: [bits, program, then 6×vec4 uniform] = 26 floats.
            let desc = crate::vello::abi::with_scene(|live, viewport, modifiers| {
                let n = live.get(gid)?;
                if let Some(color) = n.background_tint {
                    let [r, g, b, a] = color.components;
                    let mut d = [0.0f32; 26];
                    d[0] = 4.0; // bits = TINT (see fine.wgsl fx_applyPointwise)
                    d[14] = r; // u[3] = tint colour
                    d[15] = g;
                    d[16] = b;
                    d[17] = a;
                    return Some(d);
                }
                if let Some(color) = n.background_field {
                    // Field-measured tint: mask fades with distance from the device-space silhouette
                    // centre. TINT(4)|MASKMIX(16) → mix(backdrop, tinted, radial-mask); program 3.
                    let modifier = modifiers.get(&gid).copied().unwrap_or(Affine::IDENTITY);
                    let m = viewport * modifier * n.effective_transform();
                    let c = m * n.bounds.center();
                    let coeffs = m.as_coeffs();
                    let sx = (coeffs[0] * coeffs[0] + coeffs[1] * coeffs[1]).sqrt();
                    let radius = 0.5 * n.bounds.width().min(n.bounds.height()) * sx;
                    let [r, g, b, a] = color.components;
                    let mut d = [0.0f32; 26];
                    d[0] = 20.0; // bits = TINT(4) | MASKMIX(16)
                    d[1] = 3.0; // program = radial ramp
                    d[4] = c.x as f32; // u[0].z = centre.x (device)
                    d[5] = c.y as f32; // u[0].w = centre.y (device)
                    d[6] = radius as f32; // u[1].x = radius (device)
                    d[14] = r; // u[3] = tint colour
                    d[15] = g;
                    d[16] = b;
                    d[17] = a;
                    return Some(d);
                }
                None
            });
            if let Some(desc) = desc {
                let off = fx_params.len() as u32;
                fx_offset.insert(gid, off);
                fx_params.extend_from_slice(&desc);
            }
        }
        let fx_bytes: Vec<u8> = fx_params.iter().flat_map(|f| f.to_le_bytes()).collect();

        // `boundaries[j]` = draw count before gather j's marker(s); `markers_before[j]` = markers emitted
        // before it; `total_markers` = all of them. A gather emits one marker per pass, each at its own
        // z ordinal — so a gather is no longer 1:1 with a marker (a separable blur emits two).
        let (boundaries, markers_before, total_markers): (Vec<u32>, Vec<u32>, u32) = {
            let mut b = Vec::with_capacity(gathers.len());
            let mut mb = Vec::with_capacity(gathers.len());
            let mut cursor = 0usize;
            let mut z = 0u32;
            for (_j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                if gi > cursor {
                    backend.draw_scene_range(&mut scene, root, cursor, gi);
                    cursor = gi;
                }
                b.push(backend.draw_object_count(&scene));
                mb.push(z);
                if let Some(markers) = fx_markers.get(&gid) {
                    // Every MATERIALIZE link of a chained gather (a blur's H, a frosted lens's
                    // warp/blurH/blurV/scatter) writes an UNMASKED scratch that a later link samples over
                    // the REACH, so it needs the dilated reach-rect coverage; only the LAST marker (the
                    // blur's V, the lens's tail) keeps the silhouette for its masked composite.
                    for (mi, &(mround, moff)) in markers.iter().enumerate() {
                        z += 1;
                        let eid = if mi < markers.len() - 1 { FX_TINT_DILATED_ID } else { FX_TINT_ID };
                        backend.draw_effect_marker(&mut scene, root, gid, eid, z, mround, moff, reaches[_j]);
                    }
                } else {
                    let (effect_id, fx_p2) = if let Some(&off) = fx_offset.get(&gid) {
                        (FX_TINT_ID, off)
                    } else if kind == FX_STACK {
                        (6u32, 0u32)
                    } else {
                        let eid = crate::vello::abi::with_scene(|live, _, _| {
                            live.get(gid).map_or(1u32, |n| {
                                if n.glass.is_some() { 0 } else if n.gather_shader().is_some() { 2 } else { 1 }
                            })
                        });
                        (eid, 0u32)
                    };
                    z += 1;
                    backend.draw_effect_marker(&mut scene, root, gid, effect_id, z, rounds[_j], fx_p2, reaches[_j]);
                    if kind == FX_STACK {
                        // A fine-backdrop stack ALSO emits its glass marker (inline WARP, silhouette
                        // coverage) at the RELOAD round — one past the eid=6 window marker its drops
                        // composited under. The eid=6 marker opens the drops window (round R); this
                        // reloads the materialised backdrop at R+1 and the body composites over it.
                        // DILATED coverage (the reach rect, not the node silhouette): the lens SDF is its
                        // own shape (a rounded rect that may differ from a path body), so the MASKMIX field
                        // does the shaping and the coverage must not clip it to the node's outline — exactly
                        // the run_chain/tiled oracle's self-clipping lens. A frosted chain's intermediate
                        // links materialise scratch over the reach too, so dilated fits every marker.
                        if let Some(markers) = stack_markers.get(&gid) {
                            // A FROSTED stack is a 5-link chain whose TAIL (shade+maskmix) composites the
                            // masked result: it needs the SILHOUETTE (`FX_TINT_ID`) so `area[i]` clips the
                            // frost to the node's real outline — its analytic-box maskmix does NOT shape a
                            // path. The intermediate links (and the sharp stack's SDF-masked marker) keep
                            // the dilated reach-rect. This mirrors the standalone frost chain's coverage.
                            let is_frost = stack_frost.contains_key(&gid);
                            // A shadow stack's per-marker eid comes from the scheduled role: an inner BAND
                            // clips to the shape's UNOFFSET outline (the flood, FX_TINT_ID); every sharp
                            // drop / blur H/V materialises or composites over the dilated reach. A frost tail
                            // (last marker) also takes FX_TINT_ID so `area[i]` clips it to the outline.
                            let sched = shadow_sched.get(&gid);
                            for (mi, &(mround, moff)) in markers.iter().enumerate() {
                                z += 1;
                                let last = mi == markers.len() - 1;
                                let eid = if let Some(sched) = sched {
                                    if matches!(sched[mi].role, ShadowRole::InnerBand | ShadowRole::SharpInnerBand) {
                                        FX_TINT_ID
                                    } else {
                                        FX_TINT_DILATED_ID
                                    }
                                } else if is_frost && last {
                                    FX_TINT_ID
                                } else {
                                    FX_TINT_DILATED_ID
                                };
                                backend.draw_effect_marker(&mut scene, root, gid, eid, z, mround, moff, reaches[_j]);
                            }
                        }
                        cursor = gi + 1;
                    }
                }
            }
            backend.draw_scene_range(&mut scene, root, cursor, usize::MAX);
            (b, mb, z)
        };
        if let Some((packing, cells)) = strip.as_ref() {
            self.wv_strip_encode(backend, &mut scene, packing, cells, root, strip_y);
        }
        let total_draws = backend.draw_object_count(&scene);
        crate::vello::prof::dbg_add(30, crate::vello::prof::now() - _tenc);

        let phase_usage = self.raster_usage
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING;
        // The single-accumulator fast path: with rgba8unorm read-write storage, fine updates ONE
        // texture in place (untouched tiles cost nothing) and the second ping-pong slot is never
        // allocated. Same usage bits either way — the phase textures already carry storage +
        // attachment + sampling.
        // An inline WARP samples `base_in` (the prior window's output as a read-only texture) at a
        // displaced offset — only the ping-pong path binds it; the rw accumulator has no separable
        // read-only backdrop to sample cross-tile without racing. So force ping-pong when one rides.
        let rw = backend.rw_accumulator()
            && format == wgpu::TextureFormat::Rgba8Unorm
            && fx_fine.is_empty()
            && stack_fine.is_empty()
            && stack_frost.is_empty()
            && stack_shadows.is_empty();
        let n_slots: usize = if rw { 1 } else { 2 };
        let texs: Vec<wgpu::Texture> = (0..n_slots)
            .map(|_| self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv phase"))
            .collect();
        let views: Vec<wgpu::TextureView> =
            texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();

        // Shape-following glass: bake every sampled lens's outline SDF into ONE viewport-sized scratch,
        // each into its own device rectangle (disjoint, so they share the texture the way the frost
        // chain shares its scratch). Bound as `input_in` at each `SampledGlass` window below; `fine`
        // reads it at the device pixel. Built once the frame has any sampled lens; the baker is lazy.
        let sdf_view: Option<wgpu::TextureView> = if stack_sdf.is_empty() {
            None
        } else {
            if self.sdf_baker.is_none() {
                self.sdf_baker = Some(crate::vello::sdf::SdfBaker::new(device));
            }
            let tex = self.pool.acquire_target(
                device,
                width,
                acc_h,
                crate::vello::sdf::SDF_FORMAT,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv glass sdf",
            );
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            let baker = self.sdf_baker.as_ref().expect("sdf baker just built");
            let mut first = true;
            for (segs, region, decode) in stack_sdf.values() {
                baker.bake_into(device, &mut enc, &view, segs, *region, *decode, first);
                first = false;
            }
            self.frame_transient.push(tex);
            Some(view)
        };

        // A separable blur is TWO fine markers (H then V) at consecutive rounds. The H pass writes its
        // UNMASKED result to this draft (a scratch surface, not the accumulator) so the V pass can
        // sample the full blurred field while `base_in` still holds the original backdrop — the mask
        // then applies exactly once, at V. `WindowRole::BlurH`/`BlurV` name, per round, whether that
        // round's window is a blur's H pass (draft is its `out`) or V pass (draft is its extra input).
        // Only the ping-pong path carries base_in, so blurs already force it off the rw accumulator (fx_fine).
        // ONE order-driven plan folds what were three ad-hoc routing maps (rw / blur-H-V / frost-stage):
        // for a window's start round it names the ROLE the fine dispatch plays there, and the dispatch
        // resolves that role's surfaces from the shared scratch stores below. A round ABSENT from the map
        // is a plain ping-pong window. `Rw` (single accumulator, applied to every round) is mutually
        // exclusive with the blur/frost roles — a blur or frost forces the ping-pong path (`rw` requires
        // `fx_fine` empty) — so the two arms of the build below never overlap. The rounds themselves were
        // assigned in the effects' declared order (contiguous per-kind blocks), so walking the map in
        // round order walks the composition in the order the node declared.
        #[derive(Clone, Copy)]
        enum WindowRole {
            /// Single rw accumulator, updated in place.
            Rw,
            /// A separable blur's H pass: reads the accumulator, writes a fresh draft (keyed by this round).
            BlurH,
            /// A blur's V pass: reads the accumulator + the draft its H wrote (round − 1), composites masked.
            BlurV,
            /// A frosted lens chain link, stage 0..=4 (warp / blur-H / blur-V / scatter / tail).
            Frost(u8),
            /// A sharp shape-following glass: a single WARP reload that reads the backdrop (`base_in`)
            /// AND the baked SDF of the shape's outline (`input_in`) for its `Sampled` field distance.
            SampledGlass,
            /// A SHARP drop shadow: reads the rasterised offset SILHOUETTE (`input_in`, [`Self::stack_sil`]
            /// keyed by THIS round) and lays the shadow colour at its alpha (no blur), source-OVER the
            /// accumulator (under the body) — the crisp analogue of `DropBlurV`.
            SharpDrop,
            /// A soft shadow's blur H (drop OR inner): reads the shadow's rasterised offset SILHOUETTE
            /// (`input_in`, [`Self::stack_sil`] keyed by THIS round), writes the H-blurred draft. The
            /// silhouette is round-keyed so a shape's several shadows never collide.
            DropBlurH,
            /// A soft drop shadow's blur V + SPREAD composite: reads that draft, blurs vertically, lays the
            /// shadow colour over the 2D-blurred coverage source-OVER the accumulator (under the body).
            DropBlurV,
            /// A soft INNER shadow's blur V: reads the H-blurred draft, blurs vertically, MATERIALISES the
            /// 2D-blurred punch to [`Self::stack_punch`] keyed by the carried `punch_key` (the inner's H
            /// round), which its band reads (does NOT composite).
            InnerV(u32),
            /// A soft INNER shadow's BAND: reads the punch scratch (`input_in`, [`Self::stack_punch`] at the
            /// carried `punch_key`) and lays the shadow colour where the shape's flood coverage is NOT under
            /// it (`cov*(1-punch)`), OVER the body.
            InnerBand(u32),
            /// A SHARP inner shadow's BAND: like `InnerBand` but the punch is the RAW offset silhouette
            /// ([`Self::stack_sil`] at THIS round, no blur) rather than a blurred `stack_punch` scratch.
            SharpInnerBand,
            /// EDGE-DRIVEN (`WV_DAG_EXEC`): one shadow pass, dispatched from its DAG node — the executor
            /// reads the node's op + input edges to bind `node_scratch`, deciding everything (materialise vs
            /// spread, which scratch) with NO role/`punch_key`/round keying. Replaces every shadow role.
            DagNode { node: usize },
        }
        let mut window_role: std::collections::HashMap<u32, WindowRole> = std::collections::HashMap::new();
        if rw {
            for r in 1..=max_round {
                window_role.insert(r, WindowRole::Rw);
            }
        } else {
            for (j, &(_, gid, _)) in gathers.iter().enumerate() {
                // A FROSTED stack's chain runs one round PAST its drops (rounds[j] = the drops round), so
                // its Frost windows are offset +1; the sharp stack's single glass marker rides a plain
                // ping-pong (None) window at rounds[j]+1. Neither is in `fx_fine` (both ride `stack_*`).
                if frost_stack_gather[j] {
                    for p in 0..5u32 {
                        window_role.insert(rounds[j] + 1 + p, WindowRole::Frost(p as u8));
                    }
                    continue;
                }
                // A sharp SHAPE-FOLLOWING stack: its single glass reload (round +1 past the drops, the
                // same slot the analytic sharp stack rides as a plain `None` window) needs the SDF bound
                // as `input_in`, so it takes the `SampledGlass` role instead.
                if sharp_stack_gather[j] && stack_sdf.contains_key(&gid) {
                    window_role.insert(rounds[j] + 1, WindowRole::SampledGlass);
                    continue;
                }
                // A soft-shadow stack: each scheduled marker names its window role at its round. `BlurH`
                // reads the round-keyed silhouette; `DropV` composites the drop; `InnerV`/`InnerBand` carry
                // the punch key. The band(s) sit at the block tail so the final flush carries their role.
                if let Some(sched) = shadow_sched.get(&gid) {
                    for mk in sched {
                        let role = match mk.role {
                            ShadowRole::SharpDrop => WindowRole::SharpDrop,
                            ShadowRole::BlurH => WindowRole::DropBlurH,
                            ShadowRole::DropV => WindowRole::DropBlurV,
                            ShadowRole::InnerV => WindowRole::InnerV(mk.punch_key),
                            ShadowRole::InnerBand => WindowRole::InnerBand(mk.punch_key),
                            ShadowRole::SharpInnerBand => WindowRole::SharpInnerBand,
                        };
                        window_role.insert(mk.round, role);
                    }
                    continue;
                }
                let Some(passes) = fx_fine.get(&gid) else { continue };
                if frost_gather[j] {
                    for p in 0..5u32 {
                        window_role.insert(rounds[j] + p, WindowRole::Frost(p as u8));
                    }
                } else if passes.len() == 2 && (passes[0][0] as u32) & 64u32 != 0 {
                    window_role.insert(rounds[j], WindowRole::BlurH);
                    window_role.insert(rounds[j] + 1, WindowRole::BlurV);
                }
            }
        }
        // WV_DAG_EXEC: OVERRIDE this shape's shadow windows with the edge-driven `DagNode` — the dispatch
        // binds `node_scratch` by the DAG node's op + input edges instead of the role/punch_key.
        for ds in dag_shadow.values() {
            for &(round, node) in &ds.passes {
                window_role.insert(round, WindowRole::DagNode { node });
            }
        }
        // Background blur + standalone frost, edge-driven too. bg blur: H reads the `Reload` backdrop, V
        // reads the H draft (overrides `BlurH`/`BlurV`). Frost: the 5-stage chain (warp/blur-H/blur-V/
        // scatter/tail) maps to its DAG nodes (overrides `Frost(0..4)`).
        if wv_dag_exec() {
            if let Some(dag) = wv_dag_graph.as_ref() {
                for (j, &(_, gid, _)) in gathers.iter().enumerate() {
                    if frost_gather[j] {
                        if let Some(nodes) = self.wv_dag_frost(gid, dag) {
                            for (p, &node) in nodes.iter().enumerate() {
                                window_role.insert(rounds[j] + p as u32, WindowRole::DagNode { node });
                            }
                        }
                    } else if frost_stack_gather[j] {
                        // A frosted stack: its drops ride rounds[j], so the 5-stage frost chain is offset
                        // +1 (rounds[j]+1..+5), overriding the `Frost(0..4)` role windows.
                        if let Some(nodes) = self.wv_dag_frost(gid, dag) {
                            for (p, &node) in nodes.iter().enumerate() {
                                window_role.insert(rounds[j] + 1 + p as u32, WindowRole::DagNode { node });
                            }
                        }
                    } else if let Some(&(warp, _)) = dag_glass.get(&gid) {
                        // A sharp stack's glass reload (round +1 past its drops) — the fused warp arm binds
                        // the backdrop as `base_in` and, for a shape-following lens, the SDF node as
                        // `input_in`. Overrides the `SampledGlass`/`None` window.
                        window_role.insert(rounds[j] + 1, WindowRole::DagNode { node: warp });
                    } else if fx_fine.get(&gid).is_some_and(|p| p.len() == 2) {
                        if let Some((h, v)) = self.wv_dag_bg_blur(gid, dag) {
                            window_role.insert(rounds[j], WindowRole::DagNode { node: h });
                            window_role.insert(rounds[j] + 1, WindowRole::DagNode { node: v });
                        }
                    }
                }
            }
        }
        // Edge-driven scratch: every materialised DAG node writes its OWN texture, keyed by NODE INDEX; a
        // reader binds it by following its `inputs` edge. Replaces the role/round-keyed draft & silhouette
        // maps for the effects on the executor path.
        let mut node_scratch: std::collections::HashMap<usize, wgpu::TextureView> = std::collections::HashMap::new();
        // A FRESH draft per blur-H round, not one reused texture: the engine orders cross-dispatch
        // reads/writes of an EXTERNAL texture the way the accumulator ping-pong does — by alternating
        // surfaces. One draft written (H), read (V), written (next H), read (next V) is a same-texture
        // hazard the tracking misses, and the second V reads the first H's stale content (its blur
        // never took → the checker's vertical bands survive). Keyed by the H round; the V round looks
        // its H up at `round - 1`. Held for the whole loop, released to the frame-transient list after.
        let mut draft_texs: Vec<wgpu::Texture> = Vec::new();
        let mut draft_views: std::collections::HashMap<u32, wgpu::TextureView> = std::collections::HashMap::new();

        // A FROSTED lens is a five-link chain over its reserved 5-round block (warp / blur-H / blur-V /
        // scatter / tail) — named per round by `WindowRole::Frost` above. The four intermediate links
        // write to a private set of scratch surfaces (one texture per link so no in-block surface is both
        // read and written — the same-texture hazard the blur draft taught), keyed by the block's start
        // round and shared by every reach-disjoint lens in it.
        let mut frost_texs: Vec<wgpu::Texture> = Vec::new();
        let mut frost_scratch: std::collections::HashMap<u32, [wgpu::TextureView; 4]> = std::collections::HashMap::new();

        for (_, (tex, _)) in std::mem::take(&mut self.wv_atlas) {
            self.pool.release(tex);
        }
        if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
            Self::submit_batch(&mut enc, device, queue, backend);
            flush_mark = passes_recorded();
        }

        // Shadow pre-pass (`WV_SHADOW_FINE`): the fine blur is a mini phased session and the backend
        // holds ONE session, so a shadow's blur cannot nest inside the frame's main phased render — it
        // runs here, BEFORE `phased_begin`. For each stack shape's shadow silhouette, blur it through
        // fine and stash the layer keyed by cell for the round-loop painter to pick up. Drops (kind 0)
        // are blitted directly by `wv_paint_path_shadow`, so bake the tint in and offset them like the
        // tiled `paint_path_shadow` oracle; inner-shadow punches (kind 3) are the erase input to
        // `wv_paint_inner_shadow`'s band, so leave them untinted (the flood carries the colour) and
        // build them exactly as `wv_cell_source` would. Sharp shadows (sigma < 0.5) fall through to the
        // graph in both painters.
        if wv_shadow_fine() {
            // A soft drop that rides the MAIN loop (`stack_dropblur`) blurs its silhouette in-session, so
            // it must NOT also go through the pre-pass mini-session — skip those stacks here.
            let stack_ids: Vec<u128> = gathers
                .iter()
                .filter(|g| g.2 == FX_STACK && !stack_shadows.contains_key(&g.1))
                .map(|g| g.1)
                .collect();
            for id in stack_ids {
                for cell in self.wv_effect_cells(id, full_view, width, height).into_iter().filter(|c| c.key.1 == 0 || c.key.1 == 3) {
                    let sigma = cell.geom.sigma * cell.geom.k;
                    if sigma < 0.5 || cell.kw == 0 || cell.kh == 0 {
                        continue;
                    }
                    let sil_view = if cell.key.1 == 0 {
                        let (odx, ody) = match &cell.source {
                            CellSource::Silhouette { offset } => (f64::from(offset.0), f64::from(offset.1)),
                        };
                        let m = Affine::scale(f64::from(cell.geom.k))
                            * Affine::translate((odx - f64::from(cell.geom.bx()), ody - f64::from(cell.geom.by())))
                            * root;
                        let sil = self.pool.acquire_target(device, cell.kw, cell.kh, format, self.raster_usage, "wv shadow sil tinted");
                        let sil_view = sil.create_view(&wgpu::TextureViewDescriptor::default());
                        let mut sscene = backend.new_scene(cell.kw as u16, cell.kh as u16);
                        backend.build_shadow_silhouette(&mut sscene, m, cell.key.0, cell.key.2, false, true, true);
                        backend.rasterize(&sscene, device, queue, &mut enc, &sil_view, cell.kw, cell.kh, TRANSPARENT);
                        self.frame_transient.push(sil);
                        self.frame_transient_views.push(sil_view.clone());
                        sil_view
                    } else {
                        self.wv_cell_source(&cell, backend, device, queue, &mut enc, root, 0, format)
                    };
                    let blurred = self.wv_blur_texture_fine(backend, device, queue, &mut enc, &sil_view, cell.kw, cell.kh, sigma, format);
                    if let Some((tex, view)) = blurred {
                        self.frame_transient.push(tex);
                        self.shadow_fine.insert(cell.key, view);
                    }
                }
            }
        }

        // Soft shadows riding the MAIN loop: rasterise EACH shadow's OFFSET silhouette into a full-frame
        // scratch at device position (untinted white coverage), keyed by its H (`BlurH`) marker ROUND, so
        // the `DropBlurH` dispatch reads it as `input_in` inside the main session. A shape with several
        // shadows gets one silhouette per shadow — a drop blurs its OFFSET DROP silhouette, an inner its
        // OFFSET INSET silhouette (the punch), `slot` picking which shadow of that inset class. This is
        // just a rasterise (no nested phased session); the blur + composite ride the round loop.
        let sil_jobs: Vec<(u32, u128, usize, bool)> = shadow_sched
            .iter()
            .flat_map(|(&gid, sched)| {
                sched
                    .iter()
                    .filter(|mk| matches!(mk.role, ShadowRole::BlurH | ShadowRole::SharpDrop | ShadowRole::SharpInnerBand))
                    .map(move |mk| (mk.round, gid, mk.slot, mk.inset))
            })
            .collect();
        for (round, gid, slot, inset) in sil_jobs {
            let sil = self.pool.acquire_target(device, width, acc_h, format, self.raster_usage, "wv shadow silhouette");
            let sv = sil.create_view(&wgpu::TextureViewDescriptor::default());
            let mut sscene = backend.new_scene(width as u16, acc_h as u16);
            backend.build_shadow_silhouette(&mut sscene, root, gid, slot, inset, true, false);
            backend.rasterize(&sscene, device, queue, &mut enc, &sv, width, acc_h, TRANSPARENT);
            self.frame_transient.push(sil);
            self.frame_transient_views.push(sv.clone());
            self.stack_sil.insert(round, sv);
        }
        // Edge-driven silhouettes (`WV_DAG_EXEC`): rasterise each soft-drop's silhouette `Rasterize` node
        // into `node_scratch[node]` — the H blur binds it by following its input edge, no round key.
        for (gid, ds) in &dag_shadow {
            for &(sil_node, slot, inset) in &ds.sils {
                let sil = self.pool.acquire_target(device, width, acc_h, format, self.raster_usage, "wv dag silhouette");
                let sv = sil.create_view(&wgpu::TextureViewDescriptor::default());
                let mut sscene = backend.new_scene(width as u16, acc_h as u16);
                backend.build_shadow_silhouette(&mut sscene, root, *gid, slot, inset, true, false);
                backend.rasterize(&sscene, device, queue, &mut enc, &sv, width, acc_h, TRANSPARENT);
                self.frame_transient.push(sil);
                self.frame_transient_views.push(sv.clone());
                node_scratch.insert(sil_node, sv);
            }
        }
        // Edge-driven SDF fields (`WV_DAG_EXEC`): reach-disjoint glasses that SHARE a reload round also
        // share ONE window dispatch (the scheduler packs same-kind stacks into one span-2 block), so their
        // SDF `Rasterize` nodes CO-LOCATE into one region-packed texture — each glass its own device rect
        // (`clear` only the first, later ones `load`), exactly as the shared `sdf_view` did. Every glass
        // sdf node binds this one texture; the single window dispatch reads each glass's field at its own
        // device pixels. (One physical scratch spans several nodes here, as the accumulator and the frost
        // block scratch do — the node identity stays, only the allocation is shared.)
        let glass_sdf_nodes: Vec<(usize, u128)> = dag_glass
            .iter()
            .filter_map(|(&gid, &(_, sdf))| sdf.map(|s| (s, gid)))
            .collect();
        if !glass_sdf_nodes.is_empty() {
            if self.sdf_baker.is_none() {
                self.sdf_baker = Some(crate::vello::sdf::SdfBaker::new(device));
            }
            let tex = self.pool.acquire_target(
                device,
                width,
                acc_h,
                crate::vello::sdf::SDF_FORMAT,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv dag sdf",
            );
            let sv = tex.create_view(&wgpu::TextureViewDescriptor::default());
            let baker = self.sdf_baker.as_ref().expect("sdf baker just built");
            let mut first = true;
            for (sdf_node, gid) in &glass_sdf_nodes {
                if let Some((segs, region, decode)) = stack_sdf.get(gid) {
                    baker.bake_into(device, &mut enc, &sv, segs, *region, *decode, first);
                    first = false;
                }
                node_scratch.insert(*sdf_node, sv.clone());
            }
            self.frame_transient.push(tex);
            self.frame_transient_views.push(sv.clone());
        }

        let _tpb = crate::vello::prof::now();
        backend.phased_begin(&scene, device, queue, &mut enc, width, acc_h, crate::vello::abi::background(), &fx_bytes);
        crate::vello::prof::dbg_add(31, crate::vello::prof::now() - _tpb);

        backend.phased_frontend_full(device, queue, &mut enc);
        let n_gathers = gathers.len() as u32;

        let _tpl = crate::vello::prof::now();
        let n_markers = total_markers;
        let real_draws = total_draws.saturating_sub(n_markers);
        let draws_after = |j: usize| -> u32 {
            total_draws.saturating_sub(boundaries[j]).saturating_sub(n_markers - markers_before[j])
        };
        let window_has_draws = |lo: u32, hi: u32| -> bool {
            if lo == 0 {
                return real_draws > 0;
            }
            (0..gathers.len()).any(|j| {
                let in_window =
                    rounds[j] >= lo && (hi == crate::vello::rasterize::SEG_ALL || rounds[j] < hi);
                // An inline base-reading marker IS work in its reload window even with no scene draw
                // after it. A single-tap gather opens one window (round R); a separable BLUR opens two
                // (round R = H pass, R+1 = V pass), off the one marker.
                let fine_here = fx_fine.get(&gathers[j].1).is_some_and(|passes| {
                    (0..passes.len() as u32).any(|p| {
                        let w = rounds[j] + p;
                        w >= lo && (hi == crate::vello::rasterize::SEG_ALL || w < hi)
                    })
                });
                // A fine-backdrop stack's rounds are work even without a scene draw after them: the DROPS
                // round (rounds[j], where its z-below layers composite and its backdrop materialises) and
                // every glass marker round (the reload chain + the body). The drops round MUST open its own
                // window — if it merged forward into the warp round (which happens when the stack has no
                // drops and nothing draws after it, e.g. a glass-first stack late in z) the frost chain
                // desyncs and renders nothing.
                let stack_here = stack_markers.get(&gathers[j].1).is_some_and(|markers| {
                    let drops = rounds[j];
                    (drops >= lo && (hi == crate::vello::rasterize::SEG_ALL || drops < hi))
                        || markers.iter().any(|&(w, _)| w >= lo && (hi == crate::vello::rasterize::SEG_ALL || w < hi))
                });
                // A soft-shadow stack's whole block is work — including the BODY round, which carries no
                // fine marker (the body composites imperatively). Without this the body round is a GAP:
                // `window_lo` stalls there and the NEXT stack's first marker merges into a window whose
                // role is `None`, so its blur draft is never written (its V then panics). Covering the full
                // span makes the body round open its own (plain) window so `window_lo` advances past it.
                let shadow_here = stack_shadows.get(&gathers[j].1).is_some_and(|plan| {
                    let span = shadow_span(plan);
                    (rounds[j]..rounds[j] + span).any(|w| w >= lo && (hi == crate::vello::rasterize::SEG_ALL || w < hi))
                });
                (in_window && draws_after(j) > 0) || fine_here || stack_here || shadow_here
            })
        };
        let mut window_lo = 0u32;
        let mut cur: Option<usize> = None;
        let mut strip_filled = false;
        let (tex_cp, view_cp) = (self.frame_transient.len(), self.frame_transient_views.len());
        let seed_clear = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView| {
            let bg = crate::vello::abi::background().components;
            Compositor::clear(enc, view,
                [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
        };
        for r in 1..=max_round {
            // Counted where the segment actually runs. Charging every round two passes up front made
            // a round that opens no window — every round the batch adds to step over a declined
            // entry — look like it cost a fine pass and a clear, which is exactly the accounting the
            // coalescing gate reads.
            if window_has_draws(window_lo, r) {
                note_passes_of(pass_kind::FINE, 2);
                match window_role.get(&window_lo).copied() {
                    Some(WindowRole::Rw) => {
                        // The FIRST window keeps the plain clearing permutation (write-only, clears to
                        // the base color in-shader — no load, exactly the ping-pong phase 0); only the
                        // windows after it go in-place, where the read is the price of skipping
                        // untouched tiles entirely.
                        if cur.is_none() {
                            backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, None, &views[0]);
                            cur = Some(0);
                        } else {
                            backend.phased_fine_segment_rw(device, queue, &mut enc, window_lo, r, &views[0]);
                        }
                    }
                    Some(WindowRole::BlurH) => {
                        // Read the accumulator (backdrop), write a fresh draft, and DON'T advance the
                        // ping-pong — the accumulator still holds the original backdrop the V pass needs.
                        let c = cur.expect("a blur has a backdrop to read");
                        let dt = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv blur draft");
                        let dv = dt.create_view(&wgpu::TextureViewDescriptor::default());
                        backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&views[c]), &dv);
                        draft_views.insert(window_lo, dv);
                        draft_texs.push(dt);
                    }
                    Some(WindowRole::BlurV) => {
                        // Read that backdrop as base_in AND the draft its H wrote (keyed at `round − 1`)
                        // as the blur source, composite masked.
                        let c = cur.expect("a blur has a backdrop to read");
                        let out = 1 - c;
                        let dv = draft_views.get(&(window_lo - 1)).expect("blur V after its H");
                        backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &views[c], dv, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::SharpDrop) => {
                        // A sharp drop: read the rasterised offset silhouette (`input_in`, keyed by THIS
                        // round) and SPREAD|SCRATCH_COV lays the shadow colour at its alpha, source-OVER the
                        // accumulator — under the body (which composites a later round). No blur, no draft.
                        let c = cur.expect("a sharp drop composites over a backdrop");
                        let out = 1 - c;
                        let sil = self.stack_sil.get(&window_lo).expect("sharp-drop silhouette rasterised pre-pass").clone();
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sil, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::DropBlurH) => {
                        // A soft shadow's blur H: the tap SOURCE is the rasterised offset silhouette
                        // (`input_in`, keyed by THIS round), NOT the accumulator — the shadow blurs its own
                        // coverage, not the backdrop. Writes the H-blurred draft; the accumulator
                        // (`views[c]`, bound as base_in) is untouched so the V composite still has it.
                        let _c = cur.expect("a soft drop composites over a backdrop");
                        let sil = self.stack_sil.get(&window_lo).expect("soft-shadow silhouette rasterised pre-pass");
                        let dt = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv dropblur draft");
                        let dv = dt.create_view(&wgpu::TextureViewDescriptor::default());
                        // base_in is the SILHOUETTE, not the accumulator: a fine pass writes `base_in`
                        // through on any tile the marker's coverage misses, so with the accumulator as base
                        // the OPAQUE backdrop would land in the draft just past the reach and the V's taps
                        // would read its alpha=1 as coverage — a solid shadow bar at the reach edge. The
                        // silhouette is transparent outside the shape, so those tiles stay empty.
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, sil, sil, &dv);
                        draft_views.insert(window_lo, dv);
                        draft_texs.push(dt);
                    }
                    Some(WindowRole::DropBlurV) => {
                        // Blur V of that draft, then the SPREAD arm lays the shadow colour over the 2D-blurred
                        // coverage source-OVER the accumulator (`views[c]`) — the shadow layer, under the body.
                        let c = cur.expect("a soft drop composites over a backdrop");
                        let out = 1 - c;
                        let dv = draft_views.get(&(window_lo - 1)).expect("dropblur V after its H");
                        backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &views[c], dv, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::InnerV(punch_key)) => {
                        // Blur V of the draft, MATERIALISE the 2D-blurred punch to its own scratch keyed by
                        // `punch_key` (does not touch the accumulator — the body still paints normally). The
                        // band reads it later, possibly several rounds on (past the body). `base_in` is the
                        // OFFSET silhouette (keyed by `punch_key` = this inner's H round), not the accumulator:
                        // a TEXT inner's FLOOD_ERASE fold samples it (shifted back by the shadow offset) to
                        // recover the flood; a PATH inner never reads base here, so binding it is harmless.
                        let _c = cur.expect("an inner shadow composites over a backdrop");
                        let dv = draft_views.get(&(window_lo - 1)).expect("inner V after its H");
                        let sil = self
                            .stack_sil
                            .get(&punch_key)
                            .expect("inner silhouette rasterised pre-pass")
                            .clone();
                        let pt = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv inner punch");
                        let pv = pt.create_view(&wgpu::TextureViewDescriptor::default());
                        backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &sil, dv, &pv);
                        self.frame_transient.push(pt);
                        self.stack_punch.insert(punch_key, pv);
                    }
                    Some(WindowRole::InnerBand(punch_key)) => {
                        // The band: read the materialised punch (`input_in`, at `punch_key`) and lay the
                        // shadow colour where the shape's flood coverage (`area[i]`, the unoffset outline) is
                        // NOT under it — the SPREAD|ERASE arm — source-OVER the body in the accumulator.
                        let c = cur.expect("an inner band composites over the body");
                        let out = 1 - c;
                        let punch = self.stack_punch.get(&punch_key).expect("inner punch materialised by its V").clone();
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &punch, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::SharpInnerBand) => {
                        // A sharp inner band: the punch is the RAW offset silhouette (`stack_sil` at THIS
                        // round, no blur); SPREAD|ERASE lays the shadow colour where `area[i]` (the unoffset
                        // outline flood) is NOT under it, source-OVER the body.
                        let c = cur.expect("an inner band composites over the body");
                        let out = 1 - c;
                        let sil = self.stack_sil.get(&window_lo).expect("sharp-inner silhouette rasterised pre-pass").clone();
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sil, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::Frost(stage)) => {
                        // A frosted lens chain link. Every link reads the accumulator (`views[c]`, the
                        // backdrop) as `base`. Stages 0..3 write to a private scratch and DON'T advance the
                        // ping-pong (the backdrop must survive for the warp displacement and the tail's
                        // maskmix orig); the tail (stage 4) composites masked into the next slot.
                        let c = cur.expect("a frost chain has a backdrop to read");
                        let block = window_lo - u32::from(stage);
                        if stage == 0 {
                            let mut mk = |label| {
                                let t = self.pool.acquire_target(device, width, acc_h, format, phase_usage, label);
                                let v = t.create_view(&wgpu::TextureViewDescriptor::default());
                                frost_texs.push(t);
                                v
                            };
                            frost_scratch.insert(
                                block,
                                [mk("wv frost warp"), mk("wv frost blurH"), mk("wv frost blurV"), mk("wv frost scatter")],
                            );
                        }
                        let sc = frost_scratch.get(&block).expect("frost scratch allocated at stage 0");
                        match stage {
                            0 => backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&views[c]), &sc[0]),
                            1 => backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sc[0], &sc[1]),
                            2 => backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &views[c], &sc[1], &sc[2]),
                            3 => backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sc[2], &sc[3]),
                            _ => {
                                let out = 1 - c;
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sc[3], &views[out]);
                                cur = Some(out);
                            }
                        }
                    }
                    Some(WindowRole::SampledGlass) => {
                        // A sharp shape-following glass: read the materialised backdrop (`base_in`) for
                        // the refracted sample AND the baked SDF (`input_in`) for the field distance, then
                        // composite masked into the next slot — exactly the analytic sharp stack's reload,
                        // plus the SDF input. The drops already ran, so the accumulator holds the backdrop.
                        let c = cur.expect("a sampled glass has a materialised backdrop to read");
                        let out = 1 - c;
                        let sdf = sdf_view.as_ref().expect("a SampledGlass window has a baked SDF");
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], sdf, &views[out]);
                        cur = Some(out);
                    }
                    Some(WindowRole::DagNode { node }) => {
                        // EDGE-DRIVEN: bind scratches by the node's op + input edges — no role/punch_key.
                        use crate::vello::units::UnitOp;
                        let dag = wv_dag_graph.as_ref().expect("a DagNode window has the DAG");
                        let n = &dag.nodes[node];
                        // A helper: a fresh scratch view kept alive for the loop, recorded in node_scratch.
                        let mut acquire = || {
                            let t = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv dag scratch");
                            let v = t.create_view(&wgpu::TextureViewDescriptor::default());
                            draft_texs.push(t);
                            v
                        };
                        // base_in: the coverage silhouette (a shadow) or the accumulator backdrop (a blur /
                        // lens link), decided by tracing the input chain to its Rasterize or Reload root.
                        let base = match dag_base_rasterize(dag, node) {
                            Some(rz) => node_scratch.get(&rz).expect("silhouette materialised").clone(),
                            None => views[cur.expect("a backdrop effect reads the accumulator")].clone(),
                        };
                        // Does a later EFFECT stage read this node (→ materialise a scratch it will bind), or
                        // does it feed the final composite (→ composite over the accumulator)?
                        let materialize = dag
                            .nodes
                            .iter()
                            .filter(|m| m.inputs.contains(&node))
                            .any(|m| matches!(m.op, UnitOp::Blur { .. } | UnitOp::Scatter(_) | UnitOp::Warp(_) | UnitOp::EraseBy(_)));
                        match &n.op {
                            UnitOp::Warp(_) => {
                                if materialize {
                                    // A FROST warp head: read the backdrop, materialise the refracted
                                    // sample for the blur chain that follows.
                                    let dv = acquire();
                                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&base), &dv);
                                    node_scratch.insert(node, dv);
                                } else {
                                    // A SHARP glass warp = the whole fused [Warp,Shade,MaskMix] arm in one
                                    // pass: read the backdrop (base_in), plus the SDF (input_in) for a
                                    // shape-following lens, and composite masked. Analytic box lens: base only.
                                    let c = cur.expect("a glass warp composites over the backdrop");
                                    let out = 1 - c;
                                    match n.inputs.get(1) {
                                        Some(&sdf) => {
                                            let src = node_scratch.get(&sdf).expect("SDF field baked").clone();
                                            backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &src, &views[out]);
                                        }
                                        None => {
                                            backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&views[c]), &views[out]);
                                        }
                                    }
                                    cur = Some(out);
                                }
                            }
                            UnitOp::Blur { .. } => {
                                let input = n.inputs[0];
                                match &dag.nodes[input].op {
                                    // H over a SILHOUETTE (shadow): base_in = input_in = the source.
                                    UnitOp::Rasterize => {
                                        let dv = acquire();
                                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &base, &base, &dv);
                                        node_scratch.insert(node, dv);
                                    }
                                    // H over the BACKDROP (background blur): base only, no input.
                                    UnitOp::Reload => {
                                        let dv = acquire();
                                        backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&base), &dv);
                                        node_scratch.insert(node, dv);
                                    }
                                    // H over a WARP scratch (frost blur): base = backdrop, input = warp scratch.
                                    UnitOp::Warp(_) => {
                                        let src = node_scratch.get(&input).expect("warp scratch materialised").clone();
                                        let dv = acquire();
                                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &base, &src, &dv);
                                        node_scratch.insert(node, dv);
                                    }
                                    // V (input is a Blur draft): materialise (inner punch / frost blur-V) or
                                    // composite (drop spread / bg masked mix / — same call).
                                    _ => {
                                        let src = node_scratch.get(&input).expect("H draft materialised").clone();
                                        if materialize {
                                            let dv = acquire();
                                            backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &base, &src, &dv);
                                            node_scratch.insert(node, dv);
                                        } else {
                                            let c = cur.expect("a composite reads a backdrop");
                                            let out = 1 - c;
                                            backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &views[c], &src, &views[out]);
                                            cur = Some(out);
                                        }
                                    }
                                }
                            }
                            UnitOp::Scatter(_) => {
                                // Frost scatter: read the backdrop + the blur-V scratch, materialise.
                                let src = node_scratch.get(&n.inputs[0]).expect("blur-V scratch materialised").clone();
                                let dv = acquire();
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &base, &src, &dv);
                                node_scratch.insert(node, dv);
                            }
                            UnitOp::Shade(_) => {
                                // Frost tail (shade+maskmix fused): backdrop + the scatter scratch, composite.
                                let src = node_scratch.get(&n.inputs[0]).expect("scatter scratch materialised").clone();
                                let c = cur.expect("a frost tail composites over the backdrop");
                                let out = 1 - c;
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &src, &views[out]);
                                cur = Some(out);
                            }
                            UnitOp::EraseBy(_) => {
                                // Inner band: read the punch (inputs[1]), composite over the body. Flood
                                // (inputs[0]) is area[i], never bound.
                                let punch = node_scratch.get(&n.inputs[1]).expect("inner punch materialised").clone();
                                let c = cur.expect("an inner band composites over the body");
                                let out = 1 - c;
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &punch, &views[out]);
                                cur = Some(out);
                            }
                            UnitOp::Tint(_) => {
                                // Sharp drop (blur elided): composite the raw silhouette (inputs[0]).
                                let sil = node_scratch.get(&n.inputs[0]).expect("sharp-drop silhouette materialised").clone();
                                let c = cur.expect("a sharp drop composites over a backdrop");
                                let out = 1 - c;
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, r, &views[c], &sil, &views[out]);
                                cur = Some(out);
                            }
                            other => panic!("DagNode dispatch: unexpected op {other:?}"),
                        }
                    }
                    None => {
                        // A plain ping-pong window: read the current accumulator, write the other slot.
                        let out = cur.map_or(0, |c| 1 - c);
                        let base = cur.map(|c| &views[c]);
                        backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, base, &views[out]);
                        cur = Some(out);
                    }
                }
                window_lo = r;
            } else if cur.is_none() {
                seed_clear(&mut enc, &views[0]);
                cur = Some(0);
            }
            let ci = cur.expect("accumulator seeded");
            // The first window is the one that rasterized the strip (its tiles carry no marker, so
            // they belong to no later window). Record where each source landed in the accumulator —
            // the draft — so a consumer can crop the one it needs instead of every cell being
            // materialised up front.
            // The first window is the one that rasterized the strip (its tiles carry no marker,
            // so they belong to no later window). Materialise every cell NOW, in one contiguous run
            // of copies — the same copies the prepass encodes, just placed after the front-end
            // instead of before a second one. Contiguity is load-bearing: these SAME copies issued
            // one-per-consumer between the effect passes cost ~45 ms/frame at 4K in encoder churn
            // (measured); issued back-to-back here they cost ~3 ms.
            if let Some((packing, cells)) = strip.as_ref().filter(|_| !strip_filled) {
                self.wv_atlas_copy_out(device, &mut enc, &texs[ci], packing, cells, 0, strip_y, format, None);
                strip_filled = true;
            }
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                // A fine-backdrop stack spans its reload sub too: R (drops, sub 0) through R+reload (glass
                // marker(s) + body). Its glass rides fine, so the whole stack runs per-shape here.
                let extra = stack_reload_sub.get(&gid).copied().unwrap_or(0);
                if r < rounds[j] || r > rounds[j] + extra {
                    continue;
                }
                let sub = r - rounds[j];
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_TRACE").is_ok() {
                    eprintln!("wv trace: round={r} j={j} gi={gi} kind={kind} transient={}", self.frame_transient.len());
                }
                if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
                    Self::submit_batch(&mut enc, device, queue, backend);
                    flush_mark = passes_recorded();
                }
                match kind {
                    FX_STACK => self.wv_paint_stack(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, gi, width, height, format, acc_sz, None, sub, stack_reload_sub.get(&gid).copied(), stack_shadows.contains_key(&gid), stack_shadows.contains_key(&gid)),
                    _ if sub > 0 => {}
                    // An inline effect ran in fine at its CMD_EFFECT marker(s); no post-fine pass. Pointwise
                    // (tint/field) rides fx_offset; a fine gather (glass/blur) rides fx_markers.
                    _ if fx_offset.contains_key(&gid) || fx_markers.contains_key(&gid) => {}
                    _ => self.wv_stamp_gather(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, width, height, format, acc_sz),
                }
                self.recycle_node_transient(tex_cp, view_cp);
            }
        }
        let final_slot = if window_has_draws(window_lo, crate::vello::rasterize::SEG_ALL) {
            if rw {
                if cur.is_none() {
                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, None, &views[0]);
                } else {
                    backend.phased_fine_segment_rw(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[0]);
                }
                0
            } else if matches!(window_role.get(&window_lo), Some(WindowRole::SampledGlass)) {
                // The sharp shape-following glass marker often lands in THIS final window (a lone stack has
                // nothing after it). Honor the role here too: bind the backdrop + SDF like the in-loop arm,
                // else the marker runs load_base-only and `program 4` falls through to a null field.
                let c = cur.expect("a sampled glass has a materialised backdrop to read");
                let out = 1 - c;
                let sdf = sdf_view.as_ref().expect("a SampledGlass window has a baked SDF");
                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], sdf, &views[out]);
                out
            } else if let Some(&WindowRole::InnerBand(punch_key)) = window_role.get(&window_lo) {
                // An inner band is the LAST marker of its block, so it commonly lands in this final window.
                // Bind the materialised punch as `input_in` exactly like the in-loop arm — the generic
                // fallthrough below leaves `input_in` unbound, so the SPREAD|ERASE arm reads a stale punch
                // (a pure-inner block's punch happens to survive, but a mixed drop+inner block's extra
                // dispatches clobber it → the band vanishes).
                let c = cur.expect("an inner band composites over the body");
                let out = 1 - c;
                let punch = self.stack_punch.get(&punch_key).expect("inner punch materialised by its V").clone();
                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], &punch, &views[out]);
                out
            } else if matches!(window_role.get(&window_lo), Some(WindowRole::SharpInnerBand)) {
                // A sharp inner band is the LAST (often ONLY) marker of its block — for a pure sharp inner
                // it shares the body round — so it lands here. Bind the raw silhouette as `input_in` like the
                // in-loop arm; the generic fallthrough would leave it unbound.
                let c = cur.expect("an inner band composites over the body");
                let out = 1 - c;
                let sil = self.stack_sil.get(&window_lo).expect("sharp-inner silhouette rasterised pre-pass").clone();
                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], &sil, &views[out]);
                out
            } else if let Some(&WindowRole::DagNode { node }) = window_role.get(&window_lo) {
                // An edge-driven COMPOSITE pass (a drop's V spread, or an inner band) can land in the final
                // window when nothing draws after it. Bind its source by the DAG edge, like the in-loop arm.
                // (A materialise pass — H / inner V — always has a later reader, so it never lands here.)
                use crate::vello::units::UnitOp;
                let dag = wv_dag_graph.as_ref().expect("a DagNode window has the DAG");
                let n = &dag.nodes[node];
                let c = cur.expect("an edge-driven composite reads a backdrop");
                let out = 1 - c;
                match &n.op {
                    // A sharp glass warp = the fused refraction arm: read the backdrop (base_in), plus the
                    // SDF (inputs[1]) for a shape-following lens, composite masked. Analytic box: base only.
                    UnitOp::Warp(_) => match n.inputs.get(1) {
                        Some(&sdf) => {
                            let src = node_scratch.get(&sdf).expect("SDF field baked").clone();
                            backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], &src, &views[out]);
                        }
                        None => {
                            backend.phased_fine_segment(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, Some(&views[c]), &views[out]);
                        }
                    },
                    // A drop's V blur reads its draft (inputs[0]) as a blur draft.
                    UnitOp::Blur { .. } => {
                        let src = node_scratch.get(&n.inputs[0]).expect("edge source materialised").clone();
                        backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], &src, &views[out]);
                    }
                    // An inner band reads its punch (inputs[1]); a sharp drop / frost tail reads its
                    // coverage (inputs[0]) as input_in.
                    _ => {
                        let src_node = if matches!(&n.op, UnitOp::EraseBy(_)) { n.inputs[1] } else { n.inputs[0] };
                        let src = node_scratch.get(&src_node).expect("edge source materialised").clone();
                        backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, &views[c], &src, &views[out]);
                    }
                }
                out
            } else {
                let out = cur.map_or(0, |c| 1 - c);
                let base = cur.map(|c| &views[c]);
                backend.phased_fine_segment(device, queue, &mut enc, window_lo, crate::vello::rasterize::SEG_ALL, base, &views[out]);
                out
            }
        } else if let Some(c) = cur {
            c
        } else {
            seed_clear(&mut enc, &views[0]);
            0
        };
        // The blur drafts lived across the whole round loop (like the batch atlases); hand them to the
        // frame-transient list so they return to the pool after the frame, not at a per-node recycle.
        self.frame_transient.extend(draft_texs);
        self.frame_transient_views.extend(draft_views.into_values());
        // Frosted-lens scratch surfaces lived across the block; return them with the frame.
        self.frame_transient.extend(frost_texs);
        for sc in frost_scratch.into_values() {
            self.frame_transient_views.extend(sc);
        }
        backend.phased_finish(device, queue, &mut enc);
        crate::vello::prof::dbg_add(27, crate::vello::prof::now() - _tpl);

        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(&mut enc, &views[final_slot], crate::vello::graph::prof_bucket::OTHER);
        }
        // With a strip below it the accumulator is taller than the frame, and presenting from it
        // would sample across the boundary: a viewport-sized target gives the present blit
        // clamp-to-edge on its last row, and a taller one silently replaces that clamp with the
        // strip. Lift the viewport into a target of exactly its own size first — a copy, not a
        // sample, so the pixels are untouched and the present sees precisely what it always saw.
        #[cfg(not(target_arch = "wasm32"))]
        let dbg_strip = std::env::var("WV_DEBUG_STRIP").is_ok();
        #[cfg(target_arch = "wasm32")]
        let dbg_strip = false;
        let present_tex = (strip.is_some() && !dbg_strip).then(|| {
            let t = self.pool.acquire_target(
                device, width, height, format,
                self.raster_usage | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv present",
            );
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texs[final_slot],
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &t,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            let v = t.create_view(&wgpu::TextureViewDescriptor::default());
            (t, v)
        });
        let (present_view, present_sz) =
            present_tex.as_ref().map_or((&views[final_slot], acc_sz), |(_, v)| (v, sz));
        self.present_final(&mut enc, device, &sw_view, present_view, width, height, format, sz, present_sz, full_view);
        if let Some((t, v)) = present_tex {
            self.frame_transient.push(t);
            self.frame_transient_views.push(v);
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(&mut enc, &sw_view, crate::vello::graph::prof_bucket::SWAP_BLIT);
        }
        if let Some((view, aw, ah)) = self.dbg_atlas.take() {
            #[cfg(not(target_arch = "wasm32"))]
            if std::env::var("WV_DBG_CLEAR").is_ok() {
                Compositor::clear(&mut enc, &sw_view, [0.0, 0.0, 0.0, 0.0], None);
            }
            #[cfg(not(target_arch = "wasm32"))]
            let dbg_y: f32 = std::env::var("WV_DBG_ATLAS_Y").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
            #[cfg(target_arch = "wasm32")]
            let dbg_y = 0.0f32;
            self.compositor.blit(device, &mut enc, &sw_view, sz, &Blit {
                src: &view,
                dst: (0.0, 0.0, aw as f32, ah as f32),
                src_rect: (0.0, dbg_y, aw as f32, ah as f32),
                src_size: (aw as f32, ah as f32),
                alpha: 1.0,
            });
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut enc, &sw_view);
            t.resolve(&mut enc);
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.resolve(&mut enc);
        }
        drop(views);
        crate::vello::prof::inc_submit();
        queue.submit([enc.finish()]);
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.after_submit();
        }
        for t in texs {
            self.frame_transient.push(t);
        }
    }

    /// Release every frame-transient texture (and its view) acquired since the `tex_cp`/`view_cp`
    /// checkpoint back into the pool. Called at each whole-viewport effect-node boundary, once the
    /// node's result is already composited into the accumulator so all of its scratch is dead.
    ///
    /// Without this, the frame keeps EVERY node's intermediates resident until the single submit — a
    /// node fully loaded with effects allocates ~19 full-viewport textures, so peak memory is Σ(nodes)
    /// (~7 GB at 4K × 12 heavy nodes, which spills GPU memory). With it, the next node REUSES the same
    /// GPU textures via the pool free-list, so peak is `accumulator + one node`.
    ///
    /// Safe because the node's last read of each scratch texture is already RECORDED (the composite
    /// into the accumulator) before the next node re-acquires and writes it: wgpu's hazard tracking —
    /// in-encoder for the collapsed path, cross-submit on the same queue for the per-segment path —
    /// serialises the write-after-read on the recycled texture. The pool holds the handle between
    /// release and re-acquire, so the resource is never dropped while commands still reference it.
    fn recycle_node_transient(&mut self, tex_cp: usize, view_cp: usize) {
        crate::vello::prof::note_node_scratch(self.frame_transient.len().saturating_sub(tex_cp));
        self.frame_transient_views.truncate(view_cp);
        for tex in self.frame_transient.drain(tex_cp..) {
            self.pool.release(tex);
        }
    }

    /// A full-viewport 1:1 src-over blit of `src` onto `target`.
    fn blit_full(&self, enc: &mut wgpu::CommandEncoder, device: &wgpu::Device, target: &wgpu::TextureView, src: &wgpu::TextureView, sz: (f32, f32)) {
        self.compositor.blit(device, enc, target, sz, &Blit {
            src, dst: (0.0, 0.0, sz.0, sz.1), src_rect: (0.0, 0.0, sz.0, sz.1), src_size: sz, alpha: 1.0,
        });
    }

    /// (Re)allocate the retained present-on-demand canvas when missing or the viewport resized. The
    /// canvas is persistent (survives frames, never pooled) and holds the last composited frame.
    fn ensure_canvas(&mut self, device: &wgpu::Device, width: u32, height: u32, format: wgpu::TextureFormat) {
        let ok = self.canvas.as_ref().is_some_and(|c| c.2 == width && c.3 == height && c.0.format() == format);
        if !ok {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("retained canvas"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.canvas = Some((tex, view, width, height));
            self.canvas_view = None;
        }
    }

    /// Present the finished whole-viewport frame `final_view` to the swapchain. With present-on-demand
    /// on, first RETAIN it into the persistent canvas (so a later unchanged frame can re-present it)
    /// and record the view it was rendered at, then blit canvas → swapchain. Off: a single direct blit,
    /// byte-identical to the original path.
    ///
    /// `sz` is the viewport (what gets presented); `acc_sz` is the accumulator's own size, which is
    /// taller than the viewport whenever a source strip rode along below it. They differ only in the
    /// sampling denominator — the presented region is always the viewport rectangle at the origin.
    #[expect(clippy::too_many_arguments, reason = "the GPU context + present bookkeeping travel together")]
    fn present_final(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        device: &wgpu::Device,
        sw_view: &wgpu::TextureView,
        final_view: &wgpu::TextureView,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
        acc_sz: (f32, f32),
        full_view: Affine,
    ) {
        // DEBUG (native): present the WHOLE accumulator, source strip included, squeezed into the
        // viewport — the only way to actually look at the surfaces the effects consume rather than
        // infer their contents from the frame they produce.
        #[cfg(not(target_arch = "wasm32"))]
        let show_all = std::env::var("WV_DEBUG_STRIP").ok();
        #[cfg(target_arch = "wasm32")]
        let show_all: Option<String> = None;
        // `all` squeezes the entire accumulator into the frame; a number presents the accumulator
        // from that y at 1:1, which is how the source cells get inspected at their real size.
        let src_rect = match show_all.as_deref() {
            Some("all") => (0.0, 0.0, acc_sz.0, acc_sz.1),
            Some(v) if v.parse::<f32>().is_ok() => (0.0, v.parse::<f32>().unwrap(), sz.0, sz.1),
            _ => (0.0, 0.0, sz.0, sz.1),
        };
        let viewport = Blit {
            src: final_view,
            dst: (0.0, 0.0, sz.0, sz.1),
            src_rect,
            src_size: acc_sz,
            alpha: 1.0,
        };
        if crate::vello::abi::present_on_demand() {
            self.ensure_canvas(device, width, height, format);
            let cv = self.canvas.as_ref().expect("canvas ensured").1.clone();
            Compositor::clear(enc, &cv, [0.0, 0.0, 0.0, 0.0], None);
            self.compositor.blit(device, enc, &cv, sz, &viewport);
            self.compositor.blit(device, enc, sw_view, sz, &viewport);
            self.canvas_view = Some(full_view);
        } else {
            self.compositor.blit(device, enc, sw_view, sz, &viewport);
        }
    }

    /// The device box and render scale one scoped lens reads and writes — the same derivation
    /// [`Self::wv_stamp_gather_scoped`] does, factored out so the batch planner and the per-shape
    /// path can never disagree about a lens's geometry.
    /// The lens shape's outline as DEVICE-space line segments for the SDF bake — `Some` only for a path
    /// (a non-box shape whose glass must follow the real outline, not the analytic rounded box). The
    /// outline is `full_view · modifier · local`, exactly the device transform the shape is drawn under,
    /// so the baked field lands on the shape's own device pixels.
    fn wv_lens_sdf_segments(&self, id: u128, full_view: Affine) -> Option<Vec<[f32; 4]>> {
        let path = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            if n.kind != crate::model::ShapeKind::Path {
                return None;
            }
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(full_view * m * crate::geometry::outline(n))
        })?;
        Some(crate::vello::sdf::flatten_segments(&path, 0.3))
    }

    fn wv_lens_box(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32, f64)> {
        use crate::kurbo::Point;
        let page = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        })?;
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let sigma = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id).and_then(|n| n.glass).map_or(0.0, |g| g.total_blur_sigma() * scale)
        });
        let reach = 3.0 * f64::from(sigma) + 20.0;
        let pts = [
            full_view * Point::new(page.x0, page.y0),
            full_view * Point::new(page.x1, page.y0),
            full_view * Point::new(page.x0, page.y1),
            full_view * Point::new(page.x1, page.y1),
        ];
        let minx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min) - reach;
        let miny = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) - reach;
        let maxx = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) + reach;
        let maxy = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) + reach;
        let bx = minx.floor().clamp(0.0, f64::from(width)) as u32;
        let by = miny.floor().clamp(0.0, f64::from(height)) as u32;
        let ex = maxx.ceil().clamp(0.0, f64::from(width)) as u32;
        let ey = maxy.ceil().clamp(0.0, f64::from(height)) as u32;
        let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
        if bw == 0 || bh == 0 {
            return None;
        }
        let declared = f64::from(
            crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map_or(1.0_f32, |n| n.glass.map_or(1.0, |g| g.acceptable_downscale))
            })
            .clamp(f32::MIN_POSITIVE, 1.0),
        );
        let k = tiling::resolution_cap(full_view, reach / f64::from(scale)).min(declared);
        Some((bx, by, bw, bh, k))
    }

    /// The device box and render scale a NON-self-clipping gather (a background blur) reads and writes
    /// — the exact derivation [`Self::wv_stamp_gather_scoped`]'s non-`self_clips` branch does, factored
    /// out so the batch planner and the per-shape path can never disagree about a gather's geometry
    /// (the same guarantee [`Self::wv_lens_box`] gives for a lens).
    fn wv_gather_box(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32, f64)> {
        use crate::kurbo::Point;
        let page = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        })?;
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let reach = 3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0;
        let pts = [
            full_view * Point::new(page.x0, page.y0),
            full_view * Point::new(page.x1, page.y0),
            full_view * Point::new(page.x0, page.y1),
            full_view * Point::new(page.x1, page.y1),
        ];
        let minx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min) - reach;
        let miny = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) - reach;
        let maxx = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) + reach;
        let maxy = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) + reach;
        let bx = minx.floor().clamp(0.0, f64::from(width)) as u32;
        let by = miny.floor().clamp(0.0, f64::from(height)) as u32;
        let ex = maxx.ceil().clamp(0.0, f64::from(width)) as u32;
        let ey = maxy.ceil().clamp(0.0, f64::from(height)) as u32;
        let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
        if bw == 0 || bh == 0 {
            return None;
        }
        let k = tiling::resolution_cap(full_view, reach / f64::from(scale)).min(1.0);
        Some((bx, by, bw, bh, k))
    }


    /// Run a gather's effect graph over the whole-viewport backdrop (`acc`) and stamp the result back
    /// onto `acc` through the shape's silhouette — the whole-viewport counterpart of the tiled
    /// `paint_gather`, at full res (no `k` cap, backdrop origin `(0,0)`).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    /// Composite a gather's rendered result `(rtex, rview)` back into the accumulator over `region`
    /// (device px). A self-clipping lens writes straight in; every other gather is silhouette-masked
    /// so only the shape's own pixels land. `k < 1` selects the sharp (Catmull-Rom) upscale, matching
    /// the batched `MASKED`/`SHARP_MASKED` arms. Shared by the scoped (box) and unscoped (viewport)
    /// per-shape paths — the unscoped case is just `region = (0, 0, viewport)` with `k = 1` — so the
    /// two oracle branches cannot drift in how a gather lands. Takes ownership of the result texture
    /// (and any mask it builds) and parks them on the frame's transient list.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn wv_composite_gather<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        self_clips: bool,
        region: (f32, f32, f32, f32),
        k: f32,
        sz: (f32, f32),
        format: wgpu::TextureFormat,
        rtex: wgpu::Texture,
        rview: wgpu::TextureView,
    ) {
        let (bx, by, bw, bh) = region;
        if self_clips {
            let b = Blit {
                src: &rview,
                dst: (bx, by, bw, bh),
                src_rect: (0.0, 0.0, bw, bh),
                src_size: (bw, bh),
                alpha: 1.0,
            };
            if k < 0.999 {
                self.compositor.blit_sharp(device, enc, acc_view, sz, &b);
            } else {
                self.compositor.blit(device, enc, acc_view, sz, &b);
            }
        } else {
            let (mw, mh) = (bw.round() as u32, bh.round() as u32);
            let mask = self.pool.acquire_target(device, mw, mh, format, self.raster_usage, "wv gather mask");
            let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
            let m = Affine::translate((-(bx as f64), -(by as f64))) * root;
            rasterize_masks(backend, device, queue, enc, &mask_view, mw, mh, TRANSPARENT, [(id, m)]);
            let mb = MaskedBlit {
                src: &rview,
                mask: &mask_view,
                dst: (bx, by, bw, bh),
                src_rect: (0.0, 0.0, bw, bh),
                src_size: (bw, bh),
                alpha: 1.0,
            };
            if k < 0.999 {
                self.compositor.blit_masked_sharp(device, enc, acc_view, sz, &mb);
            } else {
                self.compositor.blit_masked(device, enc, acc_view, sz, &mb);
            }
            self.frame_transient.push(mask);
            self.frame_transient_views.push(mask_view);
        }
        self.frame_transient.push(rtex);
        self.frame_transient_views.push(rview);
    }

    fn wv_stamp_gather<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let self_clips = Self::wv_gather_self_clips(id);
        let is_custom = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));
        if crate::vello::abi::wv_scope() && !is_custom {
            self.wv_stamp_gather_scoped(backend, device, queue, enc, acc_view, root, full_view, id, self_clips, width, height, format, sz);
            return;
        }
        let passes = self.wv_gather_graph(id, width, height, 0.0, 0.0, full_view, 1.0, device, format);
        let Some(passes) = passes else { return };
        // This path runs the graph over VIEWPORT-sized surfaces, so its backdrop input must be the
        // viewport alone. When a source strip rides below it the accumulator is taller, and handing
        // the graph that whole texture would sample the strip into the blur; crop first instead.
        // Everything downstream then samples in viewport space, and only the destination extent is `sz`.
        let vp = (width as f32, height as f32);
        let crop = (sz.1 > vp.1 + 0.5).then(|| {
            let t = self.pool.acquire_target(
                device, width, height, format,
                self.raster_usage | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv gather viewport crop",
            );
            let v = t.create_view(&wgpu::TextureViewDescriptor::default());
            self.compositor.blit(device, enc, &v, vp, &Blit {
                src: acc_view, dst: (0.0, 0.0, vp.0, vp.1), src_rect: (0.0, 0.0, vp.0, vp.1), src_size: sz, alpha: 1.0,
            });
            (t, v)
        });
        let graph_in = crop.as_ref().map_or(acc_view, |(_, v)| v);
        let graph = self.wv_run_chain(device, enc, &[graph_in], &passes, width, height, format);
        if let Some((t, v)) = crop {
            self.frame_transient.push(t);
            self.frame_transient_views.push(v);
        }
        let Some((rtex, rview)) = graph else {
            return;
        };
        self.wv_composite_gather(
            backend, device, queue, enc, acc_view, root, id, self_clips,
            (0.0, 0.0, vp.0, vp.1), 1.0, sz, format, rtex, rview,
        );
    }

    /// Every effect surface a whole-viewport node needs, resolved to geometry, in ONE pass over the
    /// node's unified effect list ([`crate::effect::effect_stack`]).
    ///
    /// This used to be three planners — one for drop silhouettes, one for the inner-shadow flood and
    /// punch, one for the body — each re-deriving its own extent and render scale from a different
    /// authoring field. They are the same computation: take the shape's page bounds, let the effect's
    /// own pipeline displace and spread them ([`Effect::footprint`]), snap to device pixels, and pick
    /// a render scale. Asking the effect instead of asking which field it came from collapses all
    /// three into this loop, and a new effect kind needs no new planner.
    ///
    /// Backdrop readers are skipped: a gather samples the accumulator, which does not exist yet when
    /// the prepass runs, so it cannot be batched into it.
    ///
    /// Cell keys stay `(node, kind, index)` with kind `0` drop silhouette, `1` body, `2` inner flood,
    /// `3` inner punch, because that is what the consuming helpers look up.
    fn wv_effect_cells(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Vec<Cell> {
        let Some((base, stack)) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let node = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some((crate::schedule::page_bounds(node, m), crate::effect::effect_stack(node)))
        }) else {
            return Vec::new();
        };
        let c = full_view.as_coeffs();
        let view_scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut out = Vec::new();
        let mut has_body = false;
        for effect in &stack {
            if effect.reads_backdrop() {
                continue;
            }
            let kinds: &[u8] = match (&effect.source, effect.compose) {
                (Source::Coverage { .. }, Compose::Under) => &[0],
                (Source::Coverage { .. }, Compose::Over) => &[2, 3],
                (Source::Body, _) => &[1],
                _ => continue,
            };
            let Some((bx, by, bw, bh)) = wv_device_box(effect.footprint(base), full_view, width, height) else {
                continue;
            };
            // ONLY the body carries its chain's translation here. A shadow's silhouette is
            // rasterized already offset (`build_shadow_silhouette` takes `apply_offset`), so adding
            // it again would move every drop shadow twice — measured as a 10% frame diff before this
            // guard existed.
            let dev_offset = if !matches!(effect.source, Source::Body) {
                (0.0, 0.0)
            } else {
                effect.ops.iter().fold((0.0_f32, 0.0_f32), |(x, y), op| match op {
                    crate::effect::Op::Offset(o) => {
                        let c = full_view.as_coeffs();
                        (x + (c[0] * o.x + c[2] * o.y) as f32, y + (c[1] * o.x + c[3] * o.y) as f32)
                    }
                    _ => (x, y),
                })
            };
            let device_sigma = effect
                .governing_blur()
                .map(|r| crate::blur::radius_to_sigma(r) * view_scale)
                .filter(|s| *s >= 0.5);
            let k = match device_sigma {
                Some(sigma) => (tiling::resolution_cap(full_view, 3.0 * f64::from(sigma / view_scale))
                    .min(f64::from(blur_acceptable_downscale(sigma)))) as f32,
                None => (tiling::resolution_cap(full_view, 0.0)
                    .min(f64::from(effect.shader_downscale_floor()))) as f32,
            };
            let (kw, kh) = (((bw as f32 * k).round() as u32).max(1), ((bh as f32 * k).round() as u32).max(1));
            let index = match kinds[0] {
                0 => drop_i,
                2 => inner_i,
                _ => 0,
            };
            let sigma = device_sigma.unwrap_or(0.0);
            for &kind in kinds {
                let graph = wv_cell_graph(effect, kind, kw, kh, sigma * k);
                out.push(Cell {
                    key: (id, kind, index),
                    geom: CellGeom { dev: (bx as f32, by as f32, bw as f32, bh as f32), k, sigma, sharp: false },
                    passes: std::rc::Rc::new(lower_graph(&graph, None)),
                    tint: graph_tint(&graph),
                    kw, kh,
                    source: CellSource::Silhouette { offset: dev_offset },
                });
            }
            match kinds[0] {
                0 => drop_i += 1,
                2 => inner_i += 1,
                _ => has_body = true,
            }
        }
        if !has_body {
            if let Some((bx, by, bw, bh)) = wv_device_box(base, full_view, width, height) {
                let k = tiling::resolution_cap(full_view, 0.0) as f32;
                let (kw, kh) = (((bw as f32 * k).round() as u32).max(1), ((bh as f32 * k).round() as u32).max(1));
                out.push(Cell {
                    key: (id, 1, 0),
                    geom: CellGeom { dev: (bx as f32, by as f32, bw as f32, bh as f32), k, sigma: 0.0, sharp: false },
                    passes: std::rc::Rc::new(Vec::new()),
                    tint: None,
                    kw, kh,
                    source: CellSource::Silhouette { offset: (0.0, 0.0) },
                });
            }
        }
        out
    }

    /// The device-space box an effect node's whole-viewport stamp (and its blur neighbourhood) can
    /// touch — the region whose tiles need this node's `CMD_EFFECT` boundary marker. A stack node's
    /// stamps composite at its effect cells' boxes; a gather stamps inside its lens bbox expanded by
    /// the blur reach (lens adds refraction slack — same margins as `wv_stamp_gather_scoped`); a
    /// custom backdrop shader may sample and stamp anywhere, so it keeps the full viewport, as do all
    /// gathers when `wvScope` is off (the unscoped stamp blits the whole viewport). Padded a tile so
    /// partially-covered edge tiles are included.
    fn wv_marker_reach(&self, id: u128, kind: u8, full_view: Affine, width: u32, height: u32) -> [f32; 4] {
        let full = [0.0, 0.0, width as f32, height as f32];
        const NONE: [f32; 4] = [0.0, 0.0, 0.0, 0.0];
        const PAD: f32 = 16.0;
        if kind == FX_STACK {
            let cells = self.wv_effect_cells(id, full_view, width, height);
            if cells.is_empty() {
                return NONE;
            }
            let (mut x0, mut y0, mut x1, mut y1) =
                (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
            for c in &cells {
                x0 = x0.min(c.geom.bx());
                y0 = y0.min(c.geom.by());
                x1 = x1.max(c.geom.bx() + c.geom.bw());
                y1 = y1.max(c.geom.by() + c.geom.bh());
            }
            return [x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD];
        }
        use crate::effect::Op;
        use crate::kurbo::Point;
        let Some(page) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        }) else {
            return full;
        };
        let eff = Self::wv_backdrop_effect(id);
        let head = eff.as_ref().and_then(|e| e.ops.first());
        let is_custom = matches!(head, Some(Op::Shader(_)));
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        // A sampling head (Lens) displaces past its blur, so it pads wider (refraction slack); a plain
        // gather blur pads to its own reach. Both numerators are `3·sigma`, from the head op itself.
        let reach = match head {
            Some(Op::Lens(g)) => 3.0 * f64::from(g.total_blur_sigma() * scale) + 20.0,
            _ => 3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0,
        };
        let pts = [
            full_view * Point::new(page.x0, page.y0),
            full_view * Point::new(page.x1, page.y0),
            full_view * Point::new(page.x0, page.y1),
            full_view * Point::new(page.x1, page.y1),
        ];
        let minx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min) - reach;
        let miny = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) - reach;
        let maxx = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) + reach;
        let maxy = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) + reach;
        if maxx + f64::from(PAD) <= 0.0
            || maxy + f64::from(PAD) <= 0.0
            || minx - f64::from(PAD) >= f64::from(width)
            || miny - f64::from(PAD) >= f64::from(height)
        {
            return NONE;
        }
        if is_custom || !crate::vello::abi::wv_scope() {
            return full;
        }
        [minx as f32 - PAD, miny as f32 - PAD, maxx as f32 + PAD, maxy as f32 + PAD]
    }

    /// Rasterize EVERY effect surface in the frame in one go.
    ///
    /// Each surface is a cell of one shelf-packed atlas, drawn by a single scene and so a single vello
    /// front-end, then copied out into its own pooled texture. That replaces one full front-end per
    /// surface (~13 dispatches each) with one for the whole frame plus N cheap texture copies. Cells are
    /// sized to their own device extent and separated by `GAP`, so neither geometry nor a blur kernel
    /// can reach a neighbouring cell — the same containment `atlas_effects` relies on.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    /// Plan every stack-effect source surface this frame needs and shelf-pack them into one atlas
    /// rectangle: the shared half of the two fill strategies — the separate prepass render
    /// and the in-scene strip ([`Self::wv_strip_encode`]). Pure apart
    /// from reading the live model, so the caller may run it before the main scene is built (the
    /// strip needs each cell's packed origin at encode time).
    ///
    /// `target_w` is the shelf-wrap width; gathers are skipped (they crop the accumulator and have no
    /// source render), cells larger than `max_dim` are dropped, and fewer than two surviving cells
    /// returns `None` — one cell would cost the same render either way and only add a pack and a copy.
    fn wv_atlas_plan(
        &self,
        gathers: &[(usize, u128, u8)],
        full_view: Affine,
        width: u32,
        height: u32,
        target_w: u32,
        align: u32,
        max_dim: u32,
    ) -> Option<(crate::atlas::Packing, Vec<(Cell, usize)>)> {
        const GAP: u32 = 4;
        let mut cells: Vec<(Cell, usize)> = Vec::new();
        for &(gi, gid, kind) in gathers {
            if kind != FX_STACK {
                continue;
            }
            for c in self.wv_effect_cells(gid, full_view, width, height) {
                cells.push((c, gi));
            }
        }
        cells.retain(|(c, _)| c.kw <= max_dim && c.kh <= max_dim);
        if cells.len() < 2 {
            return None;
        }
        let sizes: Vec<(u32, u32)> = cells
            .iter()
            .map(|(c, _)| (c.kw.next_multiple_of(align), c.kh.next_multiple_of(align)))
            .collect();
        // A5: the batch's blur clamps every tap to the instance's own rect, so no gap at all is
        // required for correctness. `GAP` is the slack that keeps a sampler grazing half a texel past
        // a cell in transparent black rather than in its neighbour's ink — and an aligned packing
        // already has that slack inside the alignment.
        let gap = if align > 1 { 0 } else { GAP };
        let packing = crate::vello::plan::pack_groups(&sizes, gap, target_w, max_dim)?;
        Some((packing, cells))
    }

    /// The page→cell transform for one packed source surface: place the cell's device-space box at
    /// `(ox + cell.x, oy + cell.y)`, at the surface's render scale `k`. Shared by both fill
    /// strategies so a cell lands on the same texels whichever one runs.
    ///
    /// The cell's own translation (a spread's [`CellSource::Silhouette`] offset, a filter graph's
    /// `Offset`) is applied
    /// here rather than at the stamp, because the cell's box already moved with it — its footprint
    /// walks the same ops — so rendering at the unmoved position and stamping at the moved box would
    /// cancel exactly, which is what made a filter offset a silent no-op. Zero for every chain
    /// without one, so every other cell is byte-identical.
    fn wv_cell_transform(c: &Cell, place: &crate::atlas::Placement, ox: u32, oy: u32, root: Affine) -> Affine {
        let (dox, doy) = match &c.source {
            CellSource::Silhouette { offset } => *offset,
        };
        Affine::translate((f64::from(ox + place.x), f64::from(oy + place.y)))
            * Affine::scale(f64::from(c.geom.k))
            * Affine::translate((
                f64::from(dox) - f64::from(c.geom.bx()),
                f64::from(doy) - f64::from(c.geom.by()),
            ))
            * root
    }

    /// Split a packed source atlas at `(ox, oy)` in `src` into the standalone per-cell textures the
    /// effect stages look up by key.
    #[expect(clippy::too_many_arguments, reason = "GPU context plus the packing travel together")]
    fn wv_atlas_copy_out(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        src: &wgpu::Texture,
        packing: &crate::atlas::Packing,
        cells: &[(Cell, usize)],
        ox: u32,
        oy: u32,
        format: wgpu::TextureFormat,
        skip: Option<&HashSet<(u128, u8, usize)>>,
    ) {
        for place in &packing.cells {
            let (c, _) = &cells[place.index];
            // Per CELL, not per shape: a partially batched stack still needs its declined cells
            // materialised for the per-shape painter.
            if skip.is_some_and(|set| set.contains(&c.key)) {
                continue;
            }
            let tex = self.pool.acquire_target(
                device, c.kw, c.kh, format,
                self.raster_usage | wgpu::TextureUsages::COPY_DST,
                "wv atlas cell",
            );
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: src,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: ox + place.x, y: oy + place.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: c.kw, height: c.kh, depth_or_array_layers: 1 },
            );
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.wv_atlas.insert(c.key, (tex, view));
        }
    }

    /// Plan the in-scene source **strip**: pack every stack-effect source below the viewport inside
    /// one enlarged accumulator, so the frame keeps a single tile grid and one front-end run. `None`
    /// when nothing needs a source, a cell is wider than the viewport, or the combined height would
    /// exceed the device's max texture dimension — those shapes then rasterize their sources on
    /// demand through the per-shape consumers' atlas-miss fallbacks.
    fn wv_strip_plan(
        &self,
        gathers: &[(usize, u128, u8)],
        device: &wgpu::Device,
        full_view: Affine,
        width: u32,
        height: u32,
    ) -> Option<(crate::atlas::Packing, Vec<(Cell, usize)>)> {
        if !crate::vello::abi::wv_atlas() {
            return None;
        }
        let max_dim = device.limits().max_texture_dimension_2d;
        let (packing, cells) = self.wv_atlas_plan(gathers, full_view, width, height, width, TILE_PX, max_dim)?;
        if packing.width > width || height.checked_add(packing.height)? > max_dim {
            return None;
        }
        Some((packing, cells))
    }

    /// Encode every planned source surface into the MAIN scene, at its packed place in the strip
    /// below the viewport. Encoded LAST, after every other draw: the document is drawn unclipped, so
    /// whatever falls below the viewport's bottom edge lands in these very tiles, and drawing the
    /// cells afterwards is what lets `Copy` erase it. The strip's tiles carry no `CMD_EFFECT` marker
    /// — [`wv_clamp_reach`] keeps every marker inside the frame — so their whole command list runs in
    /// the first fine window, complete before any effect reads it.
    ///
    /// Each cell is wrapped in a `Compose::Copy` layer clipped to its own rectangle, which makes the
    /// cell's pixels REPLACE whatever the accumulator holds there rather than composite over it. That
    /// buys both properties a source surface needs and the shared accumulator cannot otherwise give:
    /// the transparent ground an effect requires (`fine` clears the whole target to the page colour,
    /// which would otherwise smear the page into every blurred shadow), and isolation from the
    /// document content underneath.
    ///
    /// The clip is snapped OUT to whole tiles. A clip that ends inside a tile drops that tile from
    /// the layer entirely — the cell then loses every pixel past the last tile boundary it fully
    /// covers, which is where the source's blurred tail lives. Snapping out is only safe because the
    /// packing is tile-aligned and tile-padded, so no two cells ever share a tile and one cell's
    /// snapped-out clip can never erase its neighbour.
    fn wv_strip_encode<B: RasterBackend>(
        &self,
        backend: &mut B,
        scene: &mut B::Scene,
        packing: &crate::atlas::Packing,
        cells: &[(Cell, usize)],
        root: Affine,
        strip_y: u32,
    ) {
        let replace = peniko::BlendMode::new(peniko::Mix::Normal, peniko::Compose::Copy);
        for place in &packing.cells {
            let (c, root_index) = &cells[place.index];
            let m = Self::wv_cell_transform(c, place, 0, strip_y, root);
            #[cfg(not(target_arch = "wasm32"))]
            if std::env::var("WV_TRACE_CELLS").is_ok() {
                eprintln!("strip key={:?} place=({},{}) k={}x{} b=({},{},{},{}) scale={} sigma={}",
                    c.key, place.x, strip_y + place.y, c.kw, c.kh, c.geom.bx(), c.geom.by(), c.geom.bw(), c.geom.bh(), c.geom.k, c.geom.sigma);
            }
            let rect = Rect::new(
                f64::from(place.x),
                f64::from(strip_y + place.y),
                f64::from((place.x + c.kw).next_multiple_of(TILE_PX)),
                f64::from((strip_y + place.y + c.kh).next_multiple_of(TILE_PX)),
            );
            scene.set_transform(Affine::IDENTITY);
            scene.push_layer(Some(&rect.to_path(0.1)), Some(replace), None, None, None);
            Self::wv_cell_source_into(backend, scene, c, m, *root_index);
            scene.pop_layer();
        }
    }

    /// Draw one cell's SOURCE into `scene` at `m` — the silhouette a shadow cell rasterises, or the
    /// shape itself for a body cell. The one place that knows what a cell of each kind is made of.
    ///
    /// It was four places: the strip prepass and the three per-shape painters each spelled the same
    /// match out, and each was a place `build_shadow_silhouette`'s three booleans could be flipped
    /// independently of the others.
    fn wv_cell_source_into<B: RasterBackend>(backend: &mut B, scene: &mut B::Scene, c: &Cell, m: Affine, root_index: usize) {
        match c.key.1 {
            0 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, false, true, false),
            2 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, true, false, false),
            3 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, true, true, false),
            _ => backend.draw_scene_range(scene, m, root_index, root_index + 1),
        }
    }

    /// This cell's source as a texture: the one the strip prepass already packed if it is there, and
    /// a freshly rasterised one otherwise. Both halves of the fallback lived three times over, once
    /// per painter, each with its own label and its own copy of the crop.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_cell_source<B: RasterBackend>(
        &mut self,
        c: &Cell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        root_index: usize,
        format: wgpu::TextureFormat,
    ) -> wgpu::TextureView {
        if let Some(v) = self.wv_atlas.get(&c.key).map(|(_, v)| v.clone()) {
            return v;
        }
        // A body chain may translate its result; its cell box moved with it, so the render has to
        // move by the same device vector or the two cancel out. Zero for every cell without one.
        let (odx, ody) = match &c.source {
            CellSource::Silhouette { offset } => (f64::from(offset.0), f64::from(offset.1)),
        };
        let m = Affine::scale(f64::from(c.geom.k))
            * Affine::translate((odx - f64::from(c.geom.bx()), ody - f64::from(c.geom.by())))
            * root;
        let tex = self.pool.acquire_target(device, c.kw, c.kh, format, self.raster_usage, "wv cell source");
        let v = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let mut scene = backend.new_scene(c.kw as u16, c.kh as u16);
        Self::wv_cell_source_into(backend, &mut scene, c, m, root_index);
        backend.rasterize(&scene, device, queue, enc, &v, c.kw, c.kh, TRANSPARENT);
        self.frame_transient.push(tex);
        self.frame_transient_views.push(v.clone());
        v
    }

    /// Run one lowered chain over the whole-viewport accumulator's world: the sink's pool, its
    /// frame-transient lists and its profiler, bound once here so the three WV callers do not each
    /// thread twelve arguments through [`run_graph_into`] by hand.
    ///
    /// This is the WHOLE-VIEWPORT executor. It is deliberately a method beside `run_graph_into`
    /// rather than a change to it: the tiled and WebGL paths call `run_graph_into` directly and must
    /// not move, so the two share the per-op dispatch inside `run_graph_into` while the WV path owns
    /// its own binding of the sink's state. A custom shader is just a unit whose pipeline is
    /// user-authored — the dispatch does not special-case it, and neither does this.
    fn wv_run_chain(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        inputs: &[&wgpu::TextureView],
        passes: &[Pass],
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
    ) -> Option<(wgpu::Texture, wgpu::TextureView)> {
        // The WV path runs entirely on the unit-based executor now: every chain — multi-op, reduced
        // scale, custom — goes through `run_unit_chain`, which dispatches on each pass's UNITS. Verified
        // byte-identical against `pre-unit-collapse` on the fixtures. `run_graph_into` remains only for
        // the tiled/WebGL callers until they move too.
        crate::vello::graph::run_unit_chain(
            &self.compositor, &self.unit_pipeline, device, enc, inputs, passes, w, h, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views,
        )
    }

    /// Run `passes` over `inputs` at the cell's own size and stamp the result at the cell's box —
    /// the tail every per-shape painter ends with. An empty chain stamps the source unchanged, which
    /// is what a cell whose effect is the identity means.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_effect_blit(
        &mut self,
        c: &Cell,
        inputs: &[&wgpu::TextureView],
        passes: &[Pass],
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let (kwf, khf) = (c.kw as f32, c.kh as f32);
        let out = self.wv_run_chain(device, enc, inputs, passes, c.kw, c.kh, format);
        let src = out.as_ref().map_or(inputs[0], |(_, v)| v);
        self.compositor.blit(device, enc, acc_view, sz, &Blit {
            src,
            dst: (c.geom.bx(), c.geom.by(), c.geom.bw(), c.geom.bh()),
            src_rect: (0.0, 0.0, kwf, khf),
            src_size: (kwf, khf),
            alpha: 1.0,
        });
        if let Some((tex, view)) = out {
            self.frame_transient.push(tex);
            self.frame_transient_views.push(view);
        }
    }

    /// Composite a node's drop shadows into the whole-viewport accumulator, UNDER the body.
    ///
    /// Geometry comes from [`Self::wv_effect_cells`] — the same planner the atlas prepass used — so
    /// the crop box, render scale and device sigma are derived once and cannot drift between the
    /// surface that was rasterized and the composite that places it. This helper is now only the GPU
    /// half: take the prepared silhouette, blur it, and stamp it at its box.
    ///
    /// Offset, colour and spread ride on the node and were applied when the silhouette was drawn, so
    /// nothing here reads the shadow list.
    /// Blur one texture through FINE — a self-contained mini phased session (front-end once over a
    /// two-marker full-frame BLUR), the separable draft blur applied to an arbitrary surface rather
    /// than the frame backdrop. `src` is the (already tinted, offset) silhouette; the result is its
    /// blurred copy, transparent out-of-bounds (base colour is TRANSPARENT so the shadow fades to
    /// nothing at the crop edge). Runs OUTSIDE the main phased session — the backend holds a single
    /// session — so the shadow pre-pass calls it before the frame's `phased_begin`. Returns None below
    /// the blur threshold (the caller uses the sharp silhouette) or if the surface is degenerate.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_blur_texture_fine<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        src: &wgpu::TextureView,
        w: u32,
        h: u32,
        sigma: f32,
        format: wgpu::TextureFormat,
    ) -> Option<(wgpu::Texture, wgpu::TextureView)> {
        if sigma < 0.5 || w == 0 || h == 0 {
            return None;
        }
        // Two BLUR markers (H axis (1,0), V axis (0,1)) over the WHOLE w×h — a dilated inline id (101)
        // rasterises the reach rect as coverage, so both passes cover every pixel (no silhouette mask;
        // the shadow's own extent already bounds it). The descriptors are the same [f32; 26] the frame
        // path builds: bits = BLUR(64), u[0] = (axis.x, axis.y, sigma, _).
        let mk = |ax: f32, ay: f32| {
            let mut d = [0.0f32; 26];
            d[0] = 64.0;
            d[2] = ax;
            d[3] = ay;
            d[4] = sigma;
            d
        };
        let mut fx_params: Vec<f32> = Vec::with_capacity(52);
        let off_h = fx_params.len() as u32;
        fx_params.extend_from_slice(&mk(1.0, 0.0));
        let off_v = fx_params.len() as u32;
        fx_params.extend_from_slice(&mk(0.0, 1.0));
        let fx_bytes: Vec<u8> = fx_params.iter().flat_map(|f| f.to_le_bytes()).collect();
        let reach = [0.0, 0.0, w as f32, h as f32];

        let mut scene = backend.new_scene(w as u16, h as u16);
        backend.draw_effect_marker(&mut scene, Affine::IDENTITY, 1u128, 101, 1, 1, off_h, reach);
        backend.draw_effect_marker(&mut scene, Affine::IDENTITY, 1u128, 101, 2, 2, off_v, reach);
        backend.phased_begin(&scene, device, queue, enc, w, h, TRANSPARENT, &fx_bytes);
        backend.phased_frontend_full(device, queue, enc);

        let draft = self.pool.acquire_target(device, w, h, format, self.raster_usage, "wv shadow draft");
        let out = self.pool.acquire_target(device, w, h, format, self.raster_usage, "wv shadow blurred");
        let draft_view = draft.create_view(&wgpu::TextureViewDescriptor::default());
        let out_view = out.create_view(&wgpu::TextureViewDescriptor::default());
        // H reads `src` → draft; V reads the draft → `out`. Windows keyed to the two marker rounds.
        backend.phased_fine_segment(device, queue, &mut *enc, 1, 2, Some(src), &draft_view);
        backend.phased_fine_segment_draft(device, queue, &mut *enc, 2, crate::vello::rasterize::SEG_ALL, src, &draft_view, &out_view);
        backend.phased_finish(device, queue, enc);

        self.frame_transient.push(draft);
        self.frame_transient_views.push(draft_view);
        Some((out, out_view))
    }

    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_path_shadow<B: RasterBackend>(
        &mut self,
        cell: Cell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        // Blurred through fine in the pre-pass? Blit that layer (empty passes = straight SrcOver blit).
        if let Some(view) = self.shadow_fine.get(&cell.key).cloned() {
            self.wv_effect_blit(&cell, &[&view], &[], device, enc, acc_view, format, sz);
            return;
        }
        let sil = self.wv_cell_source(&cell, backend, device, queue, enc, root, 0, format);
        let passes = cell.passes.clone();
        self.wv_effect_blit(&cell, &[&sil], &passes, device, enc, acc_view, format, sz);
    }

    /// Composite a node's inner (inset) shadows over the whole-viewport accumulator, on top of the
    /// body already painted below this boundary.
    ///
    /// The band is built entirely in textures: the shadow-coloured silhouette at the shape's own
    /// position is the flood (already clipped to the outline because it IS the outline), the same
    /// silhouette offset and blurred is the punch, and `DestOut` of the punch from the flood leaves
    /// colour only in the band on the offset side.
    ///
    /// This is the one chain that is not any single cell's — it reads TWO of them — so it is built
    /// here from the builder both paths share, with the colour taken off the flood's own chain
    /// rather than looked up on the node a second time.
    ///
    /// Geometry comes from [`Self::wv_effect_cells`], the same planner the atlas prepass used, so the
    /// flood and the punch are guaranteed to share one box — which they must, since the `DestOut`
    /// aligns them 1:1.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_inner_shadow<B: RasterBackend>(
        &mut self,
        flood: Cell,
        punch: Cell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let Some(colour) = wv_cell_tint(&flood) else { return };
        let flood_view = self.wv_cell_source(&flood, backend, device, queue, enc, root, 0, format);
        // Blurred through fine in the pre-pass? Take that layer as the (already-blurred) punch input
        // and drop the graph Blur pass; otherwise rasterise the punch and let the graph blur it.
        let fine_punch = self.shadow_fine.get(&punch.key).cloned();
        let punch_view = match &fine_punch {
            Some(view) => view.clone(),
            None => self.wv_cell_source(&punch, backend, device, queue, enc, root, 0, format),
        };
        // The band: the flood silhouette coloured, with its offset+blurred punch erased out. The
        // punch is a second input, blurred only when the erase declares a radius.
        let (w, h, sig) = (flood.kw as f32, flood.kh as f32, flood.geom.sigma * flood.geom.k);
        use crate::effect_graph::{tint_unit, unit_pass, EffectPass, GraphPass, Src, UnitKind};
        let mut graph = Vec::new();
        let punch = if fine_punch.is_some() || sig <= 0.5 {
            Src::Input(1)
        } else {
            graph.push(GraphPass::new(EffectPass::Blur { sigma: sig, linear: true }, vec![Src::Input(1)]));
            Src::Pass(0)
        };
        let band = graph.len();
        graph.push(GraphPass::new(tint_unit(w, h, colour), vec![Src::Input(0)]));
        graph.push(GraphPass::new(unit_pass(UnitKind::EraseBy, w, h, colour), vec![Src::Pass(band), punch]));
        let passes = lower_graph(&graph, None);
        self.wv_effect_blit(&flood, &[&flood_view, &punch_view], &passes, device, enc, acc_view, format, sz);
    }

    /// Run a stack node's WHOLE ordered effect stack over the whole-viewport accumulator, at the node's
    /// z. Its body is excluded from the shared walk, so this composites the full stack in the same order
    /// the tiled path does — **drops (under) → gather lens → body[+spread shaders +layer blur] (over) →
    /// inner shadows (over)** — which is what lets several effects on ONE shape (and several of the same
    /// kind) combine correctly. Each sub-effect reuses the same building block the single-effect path did.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_stack<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        root_index: usize,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
        claim: Option<(&HashSet<(u128, u8, usize)>, &HashMap<(u128, u8, usize), u32>)>,
        sub: u32,
        reload_sub: Option<u32>,
        drops_ride_fine: bool,
        inners_ride_fine: bool,
    ) {
        let stack = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id).map(crate::effect::effect_stack).unwrap_or_default()
        });
        let cells = self.wv_effect_cells(id, full_view, width, height);
        let dragged = crate::vello::abi::with_scene(|_, _, modifiers| {
            modifiers.get(&id).is_some_and(|m| *m != Affine::IDENTITY)
        });
        if dragged {
            if let Some(c) = cells.iter().find(|c| c.key.1 == 1) {
                crate::vello::prof::dbg_set(16, f64::from(c.geom.bx()));
                crate::vello::prof::dbg_set(17, f64::from(c.geom.by()));
                crate::vello::prof::dbg_set(18, f64::from(c.geom.bw()));
                crate::vello::prof::dbg_set(19, f64::from(c.geom.bh()));
                crate::vello::prof::dbg_set(23, f64::from(c.kw));
                crate::vello::prof::dbg_set(29, f64::from(c.geom.k) * 1000.0);
            }
        }
        // An entry the batch composites is not this painter's to draw; one it declined is, but only
        // in the round the plan put it in. A shape the batch never looked at has neither, so every
        // entry is mine and they all sit in round offset zero.
        //
        // When the backdrop rides fine (`reload_sub` = Some), the stack instead FRACTURES across rounds
        // and `sub` is the z-PHASE relative to the fine glass marker(s): the layers BEFORE the backdrop
        // (drops) paint at sub 0, the layers AFTER it (body, inner) at sub == reload_sub (1 for a sharp
        // glass marker, 5 for the frosted chain's tail), with the glass reloading the materialised
        // backdrop on the rounds between. The batch never claims a backdrop stack, so `mine` is bypassed
        // and the phase gate replaces it.
        let fine_backdrop = reload_sub.is_some();
        let body_sub = reload_sub.unwrap_or(0);
        let mine = |key: &(u128, u8, usize)| match claim {
            Some((taken, legacy)) => !taken.contains(key) && legacy.get(key).copied().unwrap_or(0) == sub,
            None => sub == 0,
        };
        let find = |kind: u8, idx: usize| {
            cells
                .iter()
                .find(|c| c.key.1 == kind && c.key.2 == idx)
                .cloned()
                .filter(|c| fine_backdrop || mine(&c.key))
        };
        // The inner shadow's punch is an INPUT to the flood's chain, never composited on its own, so
        // it is not claimed and not assigned a round — the flood's verdict covers both. Filtering it
        // like a composite would lose it whenever the flood moved to a later round.
        let source = |kind: u8, idx: usize| {
            cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).cloned()
        };

        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut body_done = false;
        // z-phase relative to the fine glass marker(s): 0 before them (drops paint at sub 0), 1 after
        // (body/inner paint at sub == body_sub). With no fine backdrop `here` is always true, so the whole
        // stack paints in one round.
        let mut phase = 0u32;
        let here_at = |phase: u32| !fine_backdrop || sub == if phase == 0 { 0 } else { body_sub };
        for effect in &stack {
            let here = here_at(phase);
            match (&effect.source, effect.compose) {
                (Source::Coverage { .. }, Compose::Under) => {
                    // A sharp drop that rides fine composited itself as an inline SPREAD marker (a layer
                    // under the body); the painter must not also blit it, or the shadow lands twice.
                    if here && !drops_ride_fine {
                        if let Some(c) = find(0, drop_i) {
                            self.wv_paint_path_shadow(c, backend, device, queue, enc, acc_view, root, format, sz);
                        }
                    }
                    drop_i += 1;
                    if drops_ride_fine {
                        // The drop's fine marker is the fracture point (its own round, one before the
                        // body), so — like a glass backdrop — everything after it is phase 1 and composites
                        // at `body_sub`. Without a Backdrop effect nothing else would advance the phase, so
                        // the body would wrongly paint in the drop's round and land under it.
                        phase = 1;
                    }
                }
                (Source::Backdrop, _) => {
                    if fine_backdrop {
                        // The glass rides fine at the reload round; everything after it is phase 1.
                        phase = 1;
                    } else if sub == 0 {
                        self.wv_stamp_gather(backend, device, queue, enc, acc_view, root, full_view, id, width, height, format, sz);
                    }
                }
                (Source::Body, _) => {
                    if here {
                        if let Some(c) = find(1, 0) {
                            self.wv_composite_body(c, backend, device, queue, enc, acc_view, root, root_index, format, sz);
                        }
                    }
                    body_done = true;
                }
                (Source::Coverage { .. }, Compose::Over) => {
                    if !body_done {
                        if here {
                            if let Some(c) = find(1, 0) {
                                self.wv_composite_body(c, backend, device, queue, enc, acc_view, root, root_index, format, sz);
                            }
                        }
                        body_done = true;
                    }
                    // A soft inner that rides fine builds its band as the InnerBand marker (over the body);
                    // the painter must not also blit it.
                    if here && !inners_ride_fine {
                        if let (Some(flood), Some(punch)) = (find(2, inner_i), source(3, inner_i)) {
                            self.wv_paint_inner_shadow(flood, punch, backend, device, queue, enc, acc_view, root, format, sz);
                        }
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        if !body_done && here_at(phase) {
            if let Some(c) = find(1, 0) {
                self.wv_composite_body(c, backend, device, queue, enc, acc_view, root, root_index, format, sz);
            }
        }
    }

    /// Render a stack node's subtree isolated, run its body-only custom (spread) shaders and its layer
    /// blur over it in order, then SrcOver-composite the result onto the accumulator. The front-end-once
    /// analogue of the tiled `build_bodies` → `custom_over_body` → `layer_blur_over_body` chain. Each
    /// transform threads the running body texture through `run_graph_into` into the frame encoder;
    /// intermediates go to the frame keepalive. Full-viewport; extent-crop is a later opt.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_composite_body<B: RasterBackend>(
        &mut self,
        cell: Cell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        root_index: usize,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let src = self.wv_cell_source(&cell, backend, device, queue, enc, root, root_index, format);
        let passes = self.wv_resolve_pipelines(&cell, device, format);
        self.wv_effect_blit(&cell, &[&src], &passes, device, enc, acc_view, format, sz);
    }

    /// The cell's chain, lowered with every `Custom` pass paired with its compiled pipeline.
    ///
    /// This used to be a loop that ran ONE shader per `run_graph_into` call, threading the result
    /// texture into the next iteration by hand, because a chain could not be lowered at all without
    /// a pipeline in hand — `lower_graph` dropped the pass. Now that the shape of a chain survives
    /// lowering, the whole body is one chain and the executor threads it.
    fn wv_resolve_pipelines(&mut self, cell: &Cell, device: &wgpu::Device, format: wgpu::TextureFormat) -> Vec<Pass> {
        let mut passes = (*cell.passes).clone();
        let mut shaders = crate::vello::abi::with_scene(|live, _, _| {
            live.get(cell.key.0)
                .map(|n| n.spread_shaders().map(|s| s.wgsl.clone()).collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .into_iter();
        for pass in &mut passes {
            if !matches!(pass.units.as_slice(), [crate::vello::units::UnitOp::Custom { .. }]) {
                continue;
            }
            let Some(wgsl) = shaders.next() else { continue };
            let n_inputs = 1;
            let mut hasher = DefaultHasher::new();
            wgsl.hash(&mut hasher);
            n_inputs.hash(&mut hasher);
            let key = hasher.finish();
            self.cap_custom_pipelines(key);
            pass.custom = Some(
                self.custom_pipelines
                    .entry(key)
                    .or_insert_with(|| build_custom_pipeline(device, &wgsl, n_inputs, format))
                    .clone(),
            );
        }
        passes
    }

    /// Bbox-scoped gather stamp (the default gather path): crop the backdrop to the lens's device
    /// bounding box (expanded by the effect's blur reach, clamped to the viewport), run the effect
    /// graph at that size/origin, and stamp the small result back THROUGH the shape silhouette. Effect
    /// GPU work then scales with the lens area instead of the viewport area. Lens bakes its SDF mask,
    /// so an opaque bbox blit re-lays backdrop+lens; background blur clips with a bbox-local coverage
    /// mask. The effect passes stay rectangular (a blur must read a neighbourhood) — the silhouette is
    /// honoured at the composite, and the tight bbox is near-optimal for a convex lens.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn wv_stamp_gather_scoped<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        self_clips: bool,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        // The box + render scale are the SAME derivation the batch planner uses — factored into
        // `wv_lens_box` (self-clipping lens) and `wv_gather_box` (plain gather) so the per-shape and
        // batched routes can never disagree about a gather's geometry.
        let Some((bx, by, bw, bh, k)) = (if self_clips {
            self.wv_lens_box(id, full_view, width, height)
        } else {
            self.wv_gather_box(id, full_view, width, height)
        }) else {
            return;
        };
        let (kw, kh) = (
            ((f64::from(bw) * k).round() as u32).max(1),
            ((f64::from(bh) * k).round() as u32).max(1),
        );

        let bd = self.pool.acquire_target(
            device, kw, kh, format,
            self.raster_usage | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            "wv scoped backdrop",
        );
        let bd_view = bd.create_view(&wgpu::TextureViewDescriptor::default());
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(enc, acc_view, crate::vello::graph::prof_bucket::OTHER);
        }
        self.compositor.blit(device, enc, &bd_view, (kw as f32, kh as f32), &Blit {
            src: acc_view,
            dst: (0.0, 0.0, kw as f32, kh as f32),
            src_rect: (bx as f32, by as f32, bw as f32, bh as f32),
            src_size: sz,
            alpha: 1.0,
        });

        let passes = self.wv_gather_graph(id, kw, kh, f64::from(bx), f64::from(by), full_view, k, device, format);
        let Some(passes) = passes else { return };
        let Some((rtex, rview)) = self.wv_run_chain(device, enc, &[&bd_view], &passes, kw, kh, format) else {
            return;
        };

        self.wv_composite_gather(
            backend, device, queue, enc, acc_view, root, id, self_clips,
            (bx as f32, by as f32, bw as f32, bh as f32), k as f32, sz, format, rtex, rview,
        );
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(enc, acc_view, crate::vello::graph::prof_bucket::STAMP);
        }
        self.frame_transient.push(bd);
        self.frame_transient_views.push(bd_view);
    }

    /// Render the level-0 plain bodies (tile + scope buffers) as one atlas instead of one
    /// `renderer.render` per surface.
    ///
    /// Collects every `Paint` that is the *first* write to a `TileOutput` or `ScopeOf` — a plain body
    /// with no outward blur, and (being a first write) independent of every other one — packs each
    /// into its own `TILE_BUFFER`² cell of a single atlas scene, does ONE render + copies each cell
    /// into its surface, all in one submit. The rest of the schedule (composites, gathers, any second
    /// paint into a surface) then runs unchanged onto the populated, `written`-marked surfaces. Returns
    /// the handled step indices; empty (falls through to the per-paint path) below the batch threshold
    /// or if the atlas would exceed the device's max texture size.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_prepass<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        already: &HashSet<usize>,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        const ATLAS_MIN: usize = 3;
        let none = HashSet::new();

        let mut candidates: Vec<(usize, SurfaceRef, Vec<PaintOp>)> = Vec::new();
        for i in first_write_paints(steps) {
            if already.contains(&i) {
                continue;
            }
            if let Step::Paint { ops, write_to, .. } = &steps[i] {
                if matches!(write_to.role, SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_)) {
                    candidates.push((i, *write_to, ops.clone()));
                }
            }
        }
        if candidates.len() < ATLAS_MIN {
            return none;
        }

        let max_dim = device.limits().max_texture_dimension_2d;
        let Some(packing) = pack_grid(candidates.len(), TILE_BUFFER, max_dim) else {
            return none;
        };
        let (aw, ah) = (packing.width, packing.height);

        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let (_, write_to, ops) = &candidates[cell.index];
            let Some(tile) = write_to.tile else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            let m = f64::from(TILE_MARGIN);
            let root_for_cell = Affine::translate((f64::from(cell.x) + m - ox, f64::from(cell.y) + m - oy)) * root;
            let cell_rect = Rect::new(
                f64::from(cell.x),
                f64::from(cell.y),
                f64::from(cell.x) + f64::from(TILE_BUFFER),
                f64::from(cell.y) + f64::from(TILE_BUFFER),
            );
            backend.build_bodies_clipped(&mut scene, root_for_cell, ops, cell_rect);
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: aw, h: ah, format, usage: atlas_usage.bits() },
            "body atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());

        backend.rasterize(&scene, device, queue, enc, &atlas_view, aw, ah, CLEAR);
        for cell in &packing.cells {
            let (_, write_to, _) = &candidates[cell.index];
            self.ensure_surface(*write_to, device, TILE_BUFFER, TILE_BUFFER, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
            );
            self.written.insert(*write_to);
            crate::vello::prof::inc_step();
        }
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        self.frame_transient.push(atlas);

        candidates.iter().map(|(i, _, _)| *i).collect()
    }

    /// Render the level-0 spread bodies (per-shape `RasterEffectOutput` surfaces) as one atlas.
    ///
    /// Like [`Self::atlas_prepass`], but these surfaces vary in size (each is its shape's extrect) and
    /// carry a blur, so they are shelf-packed with a `GAP` between cells — each shape's blur is already
    /// clipped to its own layer bounds (its extrect), and the gap absorbs any 1px kernel spill so it
    /// can't reach a neighbour. Body-only custom shaders are excluded (they need the per-surface
    /// `custom_over_body` pass) and fall through to the direct path. The following `Composite` steps
    /// read the populated, `written`-marked surfaces unchanged.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_effects<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        const ATLAS_MIN: usize = 4;
        const GAP: u32 = 4;
        let none = HashSet::new();
        let max_dim = device.limits().max_texture_dimension_2d;

        let mut cands: Vec<(usize, SurfaceRef, Vec<PaintOp>, u32, u32, f64, f64)> = Vec::new();
        for i in first_write_paints(steps) {
            let Step::Paint { ops, write_to, clip } = &steps[i] else { continue };
            let SurfaceRole::RasterEffectOutput(id) = write_to.role else { continue };
            let has_custom = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).is_some_and(crate::model::Node::has_spread_shader)
            });
            if has_custom {
                continue;
            }
            if !backend.blurs_layer_inline() {
                let has_layer_blur = crate::vello::abi::with_scene(|live, _, _| {
                    live.get(id).is_some_and(|n| n.blur.is_some())
                });
                if has_layer_blur {
                    continue;
                }
            }
            let (dx, dy, dw, dh) = tiling::device_rect(full_view, *clip);
            let w = (dw.ceil() as u32).max(1);
            let h = (dh.ceil() as u32).max(1);
            if w > max_dim || h > max_dim {
                continue;
            }
            cands.push((i, *write_to, ops.clone(), w, h, dx, dy));
        }
        crate::vello::prof::dbg_set(0, cands.len() as f64);
        if cands.len() < ATLAS_MIN {
            return none;
        }

        let sizes: Vec<(u32, u32)> = cands.iter().map(|c| (c.3, c.4)).collect();
        crate::vello::prof::dbg_set(1, sizes.iter().map(|s| u64::from(s.0)).max().unwrap_or(0) as f64);
        crate::vello::prof::dbg_set(2, sizes.iter().map(|s| u64::from(s.1)).max().unwrap_or(0) as f64);
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else {
            crate::vello::prof::dbg_set(3, 1.0);
            return none;
        };
        crate::vello::prof::dbg_set(4, packing.height as f64);
        let (atlas_w, atlas_h) = (packing.width, packing.height);

        let mut scene = backend.new_scene(atlas_w as u16, atlas_h as u16);
        for cell in &packing.cells {
            let (_, _, ops, _, _, dx, dy) = &cands[cell.index];
            let root_for_cell = Affine::translate((f64::from(cell.x) - dx, f64::from(cell.y) - dy)) * root;
            backend.build_bodies(&mut scene, root_for_cell, ops);
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: atlas_w, h: atlas_h, format, usage: atlas_usage.bits() },
            "spread atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());

        backend.rasterize(&scene, device, queue, enc, &atlas_view, atlas_w, atlas_h, CLEAR);
        for cell in &packing.cells {
            let (_, write_to, _, w, h, _, _) = &cands[cell.index];
            self.ensure_surface(*write_to, device, *w, *h, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 },
            );
            self.written.insert(*write_to);
            crate::vello::prof::inc_step();
        }
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        self.frame_transient.push(atlas);

        cands.iter().map(|(i, _, _, _, _, _, _)| *i).collect()
    }

    /// The tile-fuse: render a whole tile — its plain bodies **and** its spread effect surfaces inlined
    /// as images — as ONE scene, so an effect composite no longer splits the tile's plain run into a
    /// fresh rasterize each. This is the Skia-style single-scene-per-tile: instead of `paint · composite
    /// spread · paint · …` (a rasterize per segment), one cell draws `body · image(spread) · body · …`
    /// in z-order, and the fixed-cell atlas batches many such tiles into one render.
    ///
    /// Only for backends that can [inline images](RasterBackend::inline_images_supported) (classic).
    /// A tile qualifies only if every step touching it is a plain `Paint` or a spread `Composite`
    /// (`RasterEffectOutput → TileOutput`) whose source surface is already rendered — any gather, scope,
    /// or layer touching the tile disqualifies it, and it falls back to the unchanged per-step path.
    /// Returns the handled step indices (all consumed paints + spread composites).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_fuse<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        batched_gathers: &HashMap<u128, usize>,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        let none = HashSet::new();
        if !backend.inline_images_supported() {
            return none;
        }

        enum Op {
            Plain(usize, Vec<PaintOp>, Rect),
            Spread(usize, SurfaceRef, Rect, f32),
        }
        let fuse_gathers = crate::vello::abi::fuse_gathers();
        let mut per_tile: std::collections::HashMap<TileKey, Vec<Op>> = std::collections::HashMap::new();
        let mut order: Vec<TileKey> = Vec::new();
        let mut disq: HashSet<TileKey> = HashSet::new();
        let mut gather_above: HashSet<TileKey> = HashSet::new();

        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Paint { ops, clip, write_to } => {
                    if matches!(write_to.role, SurfaceRole::TileOutput) {
                        if let Some(t) = write_to.tile {
                            if fuse_gathers && gather_above.contains(&t) {
                                disq.insert(t);
                            } else {
                                if !per_tile.contains_key(&t) {
                                    order.push(t);
                                }
                                per_tile.entry(t).or_default().push(Op::Plain(i, ops.clone(), *clip));
                            }
                        }
                    }
                }
                Step::Composite { from, to, paint, rect, .. } => match to.role {
                    SurfaceRole::TileOutput => {
                        if let Some(t) = to.tile {
                            if matches!(from.role, SurfaceRole::RasterEffectOutput(_))
                                && self.surfaces.contains_key(from)
                                && crate::vello::blend::mix_code(paint.blend.mix) == 0
                            {
                                if fuse_gathers && gather_above.contains(&t) {
                                    disq.insert(t);
                                } else {
                                    if !per_tile.contains_key(&t) {
                                        order.push(t);
                                    }
                                    per_tile.entry(t).or_default()
                                        .push(Op::Spread(i, *from, *rect, paint.opacity));
                                }
                            } else {
                                disq.insert(t);
                            }
                        }
                    }
                    _ => {}
                },
                Step::ComposeBackdrop { shape, .. } | Step::PaintGather { shape, .. }
                    if batched_gathers.contains_key(shape) => {}
                Step::ComposeBackdrop { .. } | Step::PaintGather { .. } => {
                    for r in step.reads().into_iter().chain(step.writes()) {
                        if let Some(t) = r.tile {
                            if fuse_gathers {
                                gather_above.insert(t);
                            } else {
                                disq.insert(t);
                            }
                        }
                    }
                }
                Step::Snapshot { .. } | Step::BeginLayer { .. } | Step::EndLayer { .. } => {
                    for r in step.reads().into_iter().chain(step.writes()) {
                        if let Some(t) = r.tile {
                            disq.insert(t);
                        }
                    }
                }
                _ => {}
            }
        }

        let fused_tiles: Vec<TileKey> = order
            .into_iter()
            .filter(|t| !disq.contains(t))
            .filter(|t| per_tile[t].iter().any(|op| matches!(op, Op::Spread(..))))
            .collect();
        if fused_tiles.is_empty() {
            return none;
        }

        let max_dim = device.limits().max_texture_dimension_2d;
        let Some(packing) = pack_grid(fused_tiles.len(), TILE_BUFFER, max_dim) else {
            return none;
        };
        let (aw, ah) = (packing.width, packing.height);

        let mut handles: std::collections::HashMap<SurfaceRef, u64> = std::collections::HashMap::new();
        for t in &fused_tiles {
            for op in &per_tile[t] {
                if let Op::Spread(_, from, _, _) = op {
                    if !handles.contains_key(from) {
                        let tex = self.surfaces[from].texture.clone();
                        handles.insert(*from, backend.register_inline_image(&tex));
                    }
                }
            }
        }

        let m = f64::from(TILE_MARGIN);
        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let t = fused_tiles[cell.index];
            let (ox, oy) = tiling::tile_device_origin(t, full_view);
            let root_for_cell = Affine::translate((f64::from(cell.x) + m - ox, f64::from(cell.y) + m - oy)) * root;
            let cell_rect = Rect::new(
                f64::from(cell.x),
                f64::from(cell.y),
                f64::from(cell.x) + f64::from(TILE_BUFFER),
                f64::from(cell.y) + f64::from(TILE_BUFFER),
            );
            scene.set_transform(Affine::IDENTITY);
            scene.push_clip_layer(&cell_rect.to_path(0.1));
            for op in &per_tile[&t] {
                match op {
                    Op::Plain(_, ops, _) => backend.build_bodies(&mut scene, root_for_cell, ops),
                    Op::Spread(_, from, rect, alpha) => {
                        let (dx, dy, dw, dh) = tiling::device_rect(full_view, *rect);
                        let x0 = f64::from(cell.x) + (dx - ox + m);
                        let y0 = f64::from(cell.y) + (dy - oy + m);
                        let handle = handles[from];
                        backend.draw_inline_image(&mut scene, handle, Rect::new(x0, y0, x0 + dw, y0 + dh), *alpha);
                    }
                }
            }
            scene.pop_layer();
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: aw, h: ah, format, usage: atlas_usage.bits() },
            "fuse atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(&scene, device, queue, enc, &atlas_view, aw, ah, CLEAR);

        for cell in &packing.cells {
            let t = fused_tiles[cell.index];
            let write_to = SurfaceRef::tile_ref(SurfaceRole::TileOutput, t);
            self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[&write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
            );
            self.written.insert(write_to);
            crate::vello::prof::inc_step();
        }
        self.frame_transient.push(atlas);

        for (_, handle) in handles {
            backend.unregister_inline_image(handle);
        }

        let mut handled = HashSet::new();
        for t in &fused_tiles {
            for op in &per_tile[t] {
                match op {
                    Op::Plain(i, _, _) | Op::Spread(i, _, _, _) => {
                        handled.insert(*i);
                    }
                }
            }
        }
        handled
    }

    #[cfg(feature = "tiled-scheduler")]
    /// The batched background-blur gather stage — **the collapse**. Instead of a backdrop-compose +
    /// blur pass *per* deferrable blur lens (a GPU round-trip each, the ~90 ms cost), it composes every
    /// lens's backdrop into one atlas, blurs the atlas **once** per radius group, rasterizes every
    /// silhouette into one mask atlas (one `backend.rasterize`), and scatters each cell through its mask
    /// into the lens's tiles. So N lenses cost ~1 blur-graph run + 1 mask render instead of N of each.
    ///
    /// Runs after the main loop has painted all non-deferred content, so recomposing each backdrop from
    /// the finished `TileOutput`s is pixel-identical to reading it at the lens's z — the sample-rect
    /// deferrability rule (see render-core's `gather_plan`) guarantees nothing above ever touched it.
    /// `groups` are the pre-filtered [`GatherPlan::deferrable_blur_groups`] the main loop skipped.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_gather<B: RasterBackend>(
        &mut self,
        plan: &GatherPlan,
        groups: &[Vec<usize>],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        const GAP: u32 = 8;
        let max_dim = device.limits().max_texture_dimension_2d;
        let bg = crate::vello::abi::background().components;
        let bgc = [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])];

        struct Cell {
            gi: usize,
            bdx: f64,
            bdy: f64,
            dw: f64,
            dh: f64,
            k: f64,
            w: u32,
            h: u32,
        }
        for group in groups {
            let mut cells: Vec<Cell> = Vec::with_capacity(group.len());
            for &gi in group {
                let g = &plan.gathers[gi];
                let (bdx, bdy, dw, dh) = tiling::device_rect(full_view, g.sample);
                let k = tiling::resolution_cap(full_view, g.reach).min(f64::from(g.acceptable_downscale).clamp(f64::MIN_POSITIVE, 1.0));
                let w = ((dw * k).ceil() as u32).clamp(1, 4096);
                let h = ((dh * k).ceil() as u32).clamp(1, 4096);
                if w > max_dim || h > max_dim {
                    continue;
                }
                cells.push(Cell { gi, bdx, bdy, dw, dh, k, w, h });
            }
            if cells.is_empty() {
                continue;
            }
            let sizes: Vec<(u32, u32)> = cells.iter().map(|c| (c.w, c.h)).collect();
            let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else { continue };
            let (aw, ah) = (packing.width, packing.height);

            let bd_usage =
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC;
            let bd_atlas = self.pool.acquire(device, PoolKey { w: aw, h: ah, format, usage: bd_usage.bits() }, "gather backdrop atlas");
            let bd_view = bd_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            Compositor::clear(enc, &bd_view, bgc, None);
            let m = f64::from(TILE_MARGIN);
            let stages = crate::vello::abi::gather_stages();
            for cell in &packing.cells {
                if stages & 1 == 0 {
                    break;
                }
                let c = &cells[cell.index];
                for &tile in &plan.gathers[c.gi].reads {
                    let snap = SurfaceRef::snapshot(plan.gathers[c.gi].shape, tile);
                    let tile_ref = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    let Some(src_view) =
                        self.backdrop_source(&snap).or_else(|| self.backdrop_source(&tile_ref))
                    else {
                        continue;
                    };
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let Some((ix0, iy0, iw, ih)) = tiling::tile_clip_device(tile, full_view, (c.bdx, c.bdy, c.dw, c.dh))
                    else {
                        continue;
                    };
                    self.compositor.blit(device, enc, &bd_view, (aw as f32, ah as f32), &Blit {
                        src: &src_view,
                        dst: (
                            cell.x as f32 + ((ix0 - c.bdx) * c.k) as f32,
                            cell.y as f32 + ((iy0 - c.bdy) * c.k) as f32,
                            (iw * c.k) as f32,
                            (ih * c.k) as f32,
                        ),
                        src_rect: ((m + ix0 - ox) as f32, (m + iy0 - oy) as f32, iw as f32, ih as f32),
                        src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                        alpha: 1.0,
                    });
                }
            }

            if crate::vello::abi::debug_atlas() == 1 {
                self.dbg_atlas = Some((bd_view.clone(), aw, ah));
            }
            Self::submit_batch(enc, device, queue, backend);

            let sigma = self.gather_sigma(plan.gathers[cells[0].gi].shape, full_view, cells[0].k);
            let passes = if stages & 2 == 0 { Vec::new() } else { lower_graph(&effect_graph::background_blur_graph(sigma), None) };
            let Some((blur_atlas, blur_view)) =
                run_graph(&self.compositor, &self.unit_pipeline, device, queue, &[&bd_view], &passes, aw, ah, format)
            else {
                self.frame_transient.push(bd_atlas);
                continue;
            };

            if crate::vello::abi::debug_atlas() == 2 {
                self.dbg_atlas = Some((blur_view.clone(), aw, ah));
            }
            let mask_atlas = new_target_with_usage(device, aw, ah, format, self.raster_usage);
            let mask_view = mask_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            if stages & 4 != 0 {
                let masks = packing.cells.iter().map(|cell| {
                    let c = &cells[cell.index];
                    let root_for_cell = Affine::translate((f64::from(cell.x), f64::from(cell.y)))
                        * Affine::scale(c.k)
                        * Affine::translate((-c.bdx, -c.bdy))
                        * root;
                    (plan.gathers[c.gi].shape, root_for_cell)
                });
                rasterize_masks(backend, device, queue, enc, &mask_view, aw, ah, CLEAR, masks);
            }

            if crate::vello::abi::debug_atlas() == 3 {
                self.dbg_atlas = Some((mask_view.clone(), aw, ah));
            }
            for cell in &packing.cells {
                if stages & 8 == 0 {
                    break;
                }
                let c = &cells[cell.index];
                let g = &plan.gathers[c.gi];
                for &tile in &g.writes {
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let (sdx, sdy, sdw, sdh) = tiling::device_rect(full_view, g.output);
                    let tsz = f64::from(TILE_SIZE);
                    let ix0 = sdx.max(ox);
                    let iy0 = sdy.max(oy);
                    let ix1 = (sdx + sdw).min(ox + tsz);
                    let iy1 = (sdy + sdh).min(oy + tsz);
                    if ix1 <= ix0 || iy1 <= iy0 {
                        continue;
                    }
                    let write_to = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
                    let to_view = self.surfaces[&write_to].view.clone();
                    if self.written.insert(write_to) {
                        Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
                    }
                    let mf = f64::from(TILE_MARGIN);
                    let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
                    let dst = ((ix0 - ox + mf) as f32, (iy0 - oy + mf) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
                    let src_rect = (
                        cell.x as f32 + ((ix0 - c.bdx) * c.k) as f32,
                        cell.y as f32 + ((iy0 - c.bdy) * c.k) as f32,
                        ((ix1 - ix0) * c.k) as f32,
                        ((iy1 - iy0) * c.k) as f32,
                    );
                    let src_size = (aw as f32, ah as f32);
                    self.compositor.blit_masked(device, enc, &to_view, buf, &MaskedBlit {
                        src: &blur_view,
                        mask: &mask_view,
                        dst,
                        src_rect,
                        src_size,
                        alpha: 1.0,
                    });
                }
            }
            self.frame_transient.push(bd_atlas);
            self.frame_transient.push(blur_atlas);
            self.frame_transient.push(mask_atlas);
        }
    }

    /// Blit a cached tile's centre `TILE_SIZE`² square onto the swapchain at its device origin — the
    /// same placement the finalize `Composite { to: Target }` uses, factored out so a reused tile can
    /// reach the screen without going through the schedule.
    #[expect(clippy::too_many_arguments, reason = "GPU context threads through the sink")]
    fn blit_tile(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        sw_view: &wgpu::TextureView,
        tile: TileKey,
        src_view: &wgpu::TextureView,
        full_view: Affine,
        width: u32,
        height: u32,
    ) {
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        self.compositor.blit(
            device,
            enc,
            sw_view,
            (width as f32, height as f32),
            &Blit {
                src: src_view,
                dst: (ox as f32, oy as f32, ts, ts),
                src_rect: (m, m, ts, ts),
                src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                alpha: 1.0,
            },
        );
    }

    /// Bound the custom-pipeline cache before inserting a new `key`: at the cap, drop the whole map
    /// (each pipeline recompiles cheaply on next use), so a churn of distinct shader sources can't
    /// grow it without limit. A key already present is a hit and never trips the cap.
    fn cap_custom_pipelines(&mut self, key: u64) {
        if !self.custom_pipelines.contains_key(&key)
            && self.custom_pipelines.len() >= MAX_CUSTOM_PIPELINES
        {
            self.custom_pipelines.clear();
        }
    }

    #[cfg(feature = "tiled-scheduler")]
    /// The pixels to read for one backdrop source tile: this frame's live surface if the tile is being
    /// re-rendered, otherwise the tile cache's copy.
    ///
    /// A gather's sample rect routinely reaches into tiles the frame is not touching. Their content is
    /// unchanged and already on the GPU, so serving it from the cache is what lets an edit next to a
    /// lens repaint only what actually changed instead of every tile the lens happens to read.
    /// Freeze `from`'s current pixels into the snapshot surface `write_to`, so a deferred gather's
    /// batched pass reads this copy at end of frame instead of the tile it read — which later paints
    /// may have overwritten. A copy, not an alias: `from` keeps accumulating for its own later use;
    /// the snapshot is immutable. The dst is a pooled texture keyed by `write_to`, drained + recycled
    /// at the next frame boundary like every other sink surface.
    fn snapshot(
        &mut self,
        from: SurfaceRef,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
    ) {
        let src = if let Some(s) = self.surfaces.get(&from) {
            s.texture.clone()
        } else if let Some(t) = from.tile.filter(|_| matches!(from.role, SurfaceRole::TileOutput)) {
            match self.tile_cache.get(t) {
                Some(s) => s.texture.clone(),
                None => return,
            }
        } else {
            return;
        };
        let (w, h, fmt) = (src.width(), src.height(), src.format());
        self.ensure_surface(write_to, device, w, h, fmt);
        let dst = self.surfaces[&write_to].texture.clone();
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &src,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &dst,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.written.insert(write_to);
        crate::vello::prof::inc_step();
    }

    #[cfg(feature = "tiled-scheduler")]
    fn backdrop_source(&self, src_ref: &SurfaceRef) -> Option<wgpu::TextureView> {
        if let Some(s) = self.surfaces.get(src_ref) {
            return Some(s.view.clone());
        }
        if !matches!(src_ref.role, SurfaceRole::TileOutput) {
            return None;
        }
        self.tile_cache.get(src_ref.tile?).map(|s| s.view.clone())
    }

    fn ensure_surface(&mut self, key: SurfaceRef, device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) {
        if self.surfaces.contains_key(&key) {
            return;
        }
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC
            | self.raster_usage;
        let texture =
            self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "sink surface");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.surfaces.insert(key, Surface { texture, view, width: w, height: h });
    }

    /// Rasterize `scene` into `target`, accumulating over anything already there.
    ///
    /// The backend rasterize seam is deliberately *clear-only* (classic vello has no load variant), so
    /// accumulation lives here, above it: the first write clears the surface to transparent and draws;
    /// a later write draws onto a transparent scratch and `SrcOver`-composites it over the surface (the
    /// shared compositor loads the target). That is exactly what hybrid's old `render_load` did, now
    /// expressed the one way both backends can honour.
    #[expect(clippy::too_many_arguments, reason = "the GPU context threads through the sink")]
    fn rasterize_accumulate<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        scene: &B::Scene,
        target: &wgpu::TextureView,
        w: u32,
        h: u32,
        first: bool,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) {
        if first {
            backend.rasterize(scene, device, queue, enc, target, w, h, CLEAR);
            return;
        }
        let usage = self.raster_usage | wgpu::TextureUsages::TEXTURE_BINDING;
        let scratch =
            self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "sink accumulate scratch");
        let scratch_view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(scene, device, queue, enc, &scratch_view, w, h, CLEAR);
        self.compositor.blit(
            device,
            enc,
            target,
            (w as f32, h as f32),
            &Blit {
                src: &scratch_view,
                dst: (0.0, 0.0, w as f32, h as f32),
                src_rect: (0.0, 0.0, w as f32, h as f32),
                src_size: (w as f32, h as f32),
                alpha: 1.0,
            },
        );
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        self.frame_transient.push(scratch);
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint<B: RasterBackend>(
        &mut self,
        ops: &[PaintOp],
        write_to: SurfaceRef,
        clip: Rect,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let (w, h, root_for_target) = match write_to.role {
            SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_) => {
                let Some(tile) = write_to.tile else { return };
                let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                let m = f64::from(TILE_MARGIN);
                (TILE_BUFFER, TILE_BUFFER, Affine::translate((m - ox, m - oy)) * root)
            }
            SurfaceRole::RasterEffectOutput(_) => {
                let (dx, dy, dw, dh) = tiling::device_rect(full_view, clip);
                let w = (dw.ceil() as u32).max(1);
                let h = (dh.ceil() as u32).max(1);
                (w, h, Affine::translate((-dx, -dy)) * root)
            }
            _ => return,
        };

        self.ensure_surface(write_to, device, w, h, format);
        let first = self.written.insert(write_to);
        let view = self.surfaces[&write_to].view.clone();

        let mut scene = backend.new_scene(w as u16, h as u16);
        backend.build_bodies(&mut scene, root_for_target, ops);
        self.rasterize_accumulate(backend, &scene, &view, w, h, first, device, queue, enc, format);
        crate::vello::prof::inc_step();

        if let SurfaceRole::RasterEffectOutput(id) = write_to.role {
            self.custom_over_body(id, write_to, device, enc, format);
            if !backend.blurs_layer_inline() {
                self.layer_blur_over_body(id, write_to, device, enc, full_view, format);
            }
        }
    }

    /// Run the shape's **spread chain** (its body-only shaders, `reads_backdrop: false`) over its
    /// freshly rendered effect surface, in application order, swapping the surface for the chain's final
    /// output. Each effect's output feeds the next as its `@binding(2)` body — `[texture, noise]` warps
    /// the body then colours the warped result — so a list of effects is one shader graph, wired
    /// output → next input. (Consecutive pointwise passes each round-trip a texture here; fusing them
    /// into a single shader where no blur/gather barrier sits between them is a later optimization.)
    fn custom_over_body(
        &mut self,
        id: u128,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) {
        let chain: Vec<(crate::model::EffectSlot, String, Vec<f32>, u32, f32)> =
            crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map(|n| {
                    n.spread_effects()
                        .map(|(slot, c)| (slot, c.wgsl.clone(), c.params.clone(), c.param_vec4s, c.reach))
                        .collect()
                })
            })
            .unwrap_or_default();
        if chain.is_empty() {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);

        let mut input_view = surf.view.clone();
        let mut result: Option<(wgpu::Texture, wgpu::TextureView)> = None;
        for (slot, wgsl, params, param_vec4s, reach) in chain {
            // An effect with a native lowering runs as units; the rest still run their WGSL. The
            // shader stays the definition for backends that have no unit pipeline.
            let passes = if slot == crate::model::EffectSlot::Texture {
                lower_graph(&crate::vello::effects::texture_units(&params, w as f32, h as f32), None)
            } else {
                let n_inputs = 1;
                let mut hasher = DefaultHasher::new();
                wgsl.hash(&mut hasher);
                n_inputs.hash(&mut hasher);
                let key = hasher.finish();
                self.cap_custom_pipelines(key);
                let pipeline = self
                    .custom_pipelines
                    .entry(key)
                    .or_insert_with(|| build_custom_pipeline(device, &wgsl, n_inputs, format))
                    .clone();
                let mut u = vec![w as f32, h as f32];
                u.extend_from_slice(&params);
                // A spread by definition (`spread_effects` filters `!reads_backdrop`); its reach is
                // declared, so the schedule sizes and batches it from that, not from a global guess.
                lower_graph(&effect_graph::custom_graph(u, param_vec4s, reach, false), Some(&pipeline))
            };
            let out = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, enc, &[&input_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            let Some((tex, view)) = out else { return };
            if let Some((ptex, pview)) = result.take() {
                self.frame_transient.push(ptex);
                self.frame_transient_views.push(pview);
            }
            input_view = view.clone();
            result = Some((tex, view));
        }
        if let Some((tex, view)) = result {
            if let Some(old) = self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h }) {
                self.frame_transient.push(old.texture);
            }
        }
    }

    /// Blur a layer-blurred shape's freshly-rendered body surface **in place**, through the same
    /// `run_graph` Gaussian a background blur uses — classic's stand-in for the inline filter layer
    /// hybrid applies in its walk. `node.blur` is the layer-blur radius; the effect surface is already
    /// extent-sized (`effect_extent` grows it by `3σ`) so the blur has room to spread. No-op when the
    /// shape has no layer blur or the device sigma is negligible.
    fn layer_blur_over_body(
        &mut self,
        id: u128,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(radius) = crate::vello::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.blur)) else {
            return;
        };
        if radius <= 0.0 {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);
        let input_view = surf.view.clone();
        let sigma = crate::geometry::cap_sigma_to_device(crate::blur::radius_to_sigma(radius), full_view);
        if sigma < 0.5 {
            return;
        }
        let passes = lower_graph(&effect_graph::background_blur_graph(sigma), None);
        let out = run_graph_into(
            &self.compositor, &self.unit_pipeline, device, enc, &[&input_view], &passes, w, h, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
        );
        let Some((tex, view)) = out else { return };
        if let Some(old) = self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h }) {
            self.frame_transient.push(old.texture);
        }
    }

    /// Submit `frame_enc` and swap in a fresh encoder in its place, then let the backend reclaim what
    /// the submitted batch retired. The single point every batch boundary goes through.
    fn submit_batch<B: RasterBackend>(
        frame_enc: &mut wgpu::CommandEncoder,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        backend: &mut B,
    ) {
        let fresh = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });
        let done = std::mem::replace(frame_enc, fresh);
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::inc_submit();
        queue.submit([done.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        backend.after_submit();
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn composite(
        &mut self,
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        sw_view: &wgpu::TextureView,
        full_view: Affine,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) {
        let Some(src) = self.surfaces.get(&from) else { return };
        let src_view = src.view.clone();
        let src_size = (src.width as f32, src.height as f32);
        let alpha = paint.opacity;
        let mix = crate::vello::blend::mix_code(paint.blend.mix);

        match to.role {
            SurfaceRole::Target => {
                let Some(tile) = from.tile else { return };
                let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                let m = TILE_MARGIN as f32;
                let ts = TILE_SIZE as f32;
                self.compositor.blit(
                    device,
                    enc,
                    sw_view,
                    (width as f32, height as f32),
                    &Blit {
                        src: &src_view,
                        dst: (ox as f32, oy as f32, ts, ts),
                        src_rect: (m, m, ts, ts),
                        src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                        alpha,
                    },
                );
            }
            SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_) => {
                let Some(tile) = to.tile else { return };
                self.ensure_surface(to, device, TILE_BUFFER, TILE_BUFFER, format);
                let to_view = self.surfaces[&to].view.clone();
                if self.written.insert(to) {
                    Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
                }
                let buf = TILE_BUFFER as f32;
                let (dst, src_rect) = if matches!(from.role, SurfaceRole::RasterEffectOutput(_)) {
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let m = f64::from(TILE_MARGIN);
                    let (dx, dy, dw, dh) = tiling::device_rect(full_view, rect);
                    (
                        ((dx - ox + m) as f32, (dy - oy + m) as f32, dw as f32, dh as f32),
                        (0.0, 0.0, src_size.0, src_size.1),
                    )
                } else {
                    ((0.0, 0.0, buf, buf), (0.0, 0.0, src_size.0, src_size.1))
                };
                if mix != 0 {
                    let backdrop = self.blend_backdrop(to, device, enc, format);
                    self.compositor.composite_blend(
                        device,
                        enc,
                        &to_view,
                        (buf, buf),
                        &BlendComposite { src: &src_view, backdrop: &backdrop, dst, src_rect, src_size, alpha, mix },
                    );
                } else {
                    self.compositor.blit(
                        device,
                        enc,
                        &to_view,
                        (buf, buf),
                        &Blit { src: &src_view, dst, src_rect, src_size, alpha },
                    );
                }
            }
            _ => {}
        }
        crate::vello::prof::inc_step();
    }

    /// Copy tile buffer `to`'s current content into the reusable `blend_scratch` and return a view of
    /// it, so a `composite_blend` can sample the destination it is about to overwrite (WebGL2 forbids
    /// sampling the live render target). The scratch is `TILE_BUFFER²`, kept across frames, and reused
    /// in order by consecutive blend composites in one encoder.
    fn blend_backdrop(
        &mut self,
        to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) -> wgpu::TextureView {
        let matches_fmt = matches!(&self.blend_scratch, Some((_, f)) if *f == format);
        if !matches_fmt {
            let usage = wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT;
            let tex = self.pool.acquire(
                device,
                PoolKey { w: TILE_BUFFER, h: TILE_BUFFER, format, usage: usage.bits() },
                "blend scratch",
            );
            self.blend_scratch = Some((tex, format));
        }
        let scratch = &self.blend_scratch.as_ref().expect("blend scratch just ensured").0;
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.surfaces[&to].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: scratch,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
        );
        scratch.create_view(&wgpu::TextureViewDescriptor::default())
    }

    #[cfg(feature = "tiled-scheduler")]
    /// Fuse the below-z-order content over a gather's sample rect into one `Backdrop` surface (sized
    /// to the sample rect, pre-filled with the page background), by blitting each covered tile's
    /// centre into it. The backdrop is the *input* the blur samples — assembling it here, at the
    /// gather's z-position, is what freezes it to only-below content.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn compose_backdrop(
        &mut self,
        read_from: &[SurfaceRef],
        extent: Rect,
        reach: f64,
        always_cap: bool,
        acceptable_downscale: f64,
        tile_mode: TileMode,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let (bdx, bdy, bw, bh) = tiling::device_rect(full_view, extent);
        let mut k = tiling::resolution_cap(full_view, reach);
        if always_cap {
            let ceiling = f64::from(TILE_BUFFER) / bw.max(bh).max(1.0);
            k = k.min(ceiling).min(1.0);
        }
        k = k.min(acceptable_downscale.clamp(f64::MIN_POSITIVE, 1.0));
        let w = ((bw * k).ceil() as u32).clamp(1, 4096);
        let h = ((bh * k).ceil() as u32).clamp(1, 4096);
        self.ensure_surface(write_to, device, w, h, format);
        self.written.insert(write_to);
        self.backdrop_origin.insert(write_to, (bdx, bdy));
        self.backdrop_scale.insert(write_to, k);
        let bd_view = self.surfaces[&write_to].view.clone();
        let scoped = read_from.iter().any(|r| matches!(r.role, SurfaceRole::ScopeOf(_)));
        let clear = if scoped {
            match tile_mode {
                TileMode::Decal | TileMode::Clamp => [0.0, 0.0, 0.0, 0.0],
                TileMode::Black => [0.0, 0.0, 0.0, 1.0],
            }
        } else {
            let bg = crate::vello::abi::background().components;
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])]
        };
        Compositor::clear(enc, &bd_view, clear, None);
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        let kf = k as f32;
        for src_ref in read_from {
            let Some(tile) = src_ref.tile else { continue };
            let Some(src_view) = self.backdrop_source(src_ref) else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            let x0 = (((ox - bdx) as f32) * kf).round();
            let y0 = (((oy - bdy) as f32) * kf).round();
            let x1 = (((ox - bdx) as f32 + ts) * kf).round();
            let y1 = (((oy - bdy) as f32 + ts) * kf).round();
            self.compositor.blit(
                device,
                enc,
                &bd_view,
                (w as f32, h as f32),
                &Blit {
                    src: &src_view,
                    dst: (x0, y0, x1 - x0, y1 - y0),
                    src_rect: (m, m, ts, ts),
                    src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                    alpha: 1.0,
                },
            );
        }

        if scoped && matches!(tile_mode, TileMode::Clamp) {
            let scope_id = read_from.iter().find_map(|r| match r.role {
                SurfaceRole::ScopeOf(sid) => Some(sid),
                _ => None,
            });
            let content_page = scope_id.and_then(|sid| {
                crate::vello::abi::with_scene(|live, _, mods| {
                    live.get(sid).map(|n| {
                        let m = mods.get(&sid).copied().unwrap_or(Affine::IDENTITY);
                        crate::schedule::page_bounds(n, m)
                    })
                })
            });
            if let Some(cr) = content_page {
                let (cx, cy, cw, ch) = tiling::device_rect(full_view, cr);
                let to_u = |dx: f64| (((dx - bdx) * k) / f64::from(w)) as f32;
                let to_v = |dy: f64| (((dy - bdy) * k) / f64::from(h)) as f32;
                let inset_u = (4.0 * k / f64::from(w)) as f32;
                let inset_v = (4.0 * k / f64::from(h)) as f32;
                let rect = [
                    to_u(cx) + inset_u,
                    to_v(cy) + inset_v,
                    to_u(cx + cw) - inset_u,
                    to_v(cy + ch) - inset_v,
                ];
                if rect[0] < rect[2] && rect[1] < rect[3] {
                    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC
                        | self.raster_usage;
                    let filled = self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "clamp fill");
                    let filled_view = filled.create_view(&wgpu::TextureViewDescriptor::default());
                    self.unit_pipeline.clamp_fill(device, enc, &filled_view, &bd_view, (w as f32, h as f32), rect);
                    if let Some(old) = self.surfaces.insert(write_to, Surface { texture: filled, view: filled_view, width: w, height: h }) {
                        self.frame_transient.push(old.texture);
                    }
                }
            }
        }
    }

    /// Assemble a gather effect's result once (cached under the bumped ref) via [`run_graph`], then
    /// stamp it into `write_to`'s tile — through the shape's silhouette mask for background blur, or
    /// its device rect for lens (whose SDF mask is baked into the composite). The shape's own body
    /// paints on top afterward.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_gather<B: RasterBackend>(
        &mut self,
        backdrop: SurfaceRef,
        clip: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let SurfaceRole::Backdrop(id) = backdrop.role else { return };
        let Some(bd) = self.surfaces.get(&backdrop) else { return };
        let (bw, bh) = (bd.width, bd.height);
        let Some(&(bdx, bdy)) = self.backdrop_origin.get(&backdrop) else { return };
        let k = self.backdrop_scale.get(&backdrop).copied().unwrap_or(1.0);

        let self_clips = Self::wv_gather_self_clips(id);

        let result_ref = backdrop.bump();
        let mask_ref = backdrop.bump().bump();
        if !self.surfaces.contains_key(&result_ref) {
            let passes = self.wv_gather_graph(id, bw, bh, bdx, bdy, full_view, k, device, format);
            let Some(passes) = passes else { return };
            Self::submit_batch(enc, device, queue, backend);
            let backdrop_view = self.surfaces[&backdrop].view.clone();
            let mut genc = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("inline gather graph") });
            let out = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, &mut genc, &[&backdrop_view], &passes, bw, bh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            queue.submit([genc.finish()]);
                let Some((tex, view)) = out else { return };
            self.surfaces.insert(result_ref, Surface { texture: tex, view, width: bw, height: bh });

            if !self_clips {
                let mask = new_target_with_usage(device, bw, bh, format, self.raster_usage);
                let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
                let root_for_mask = Affine::scale(k) * Affine::translate((-bdx, -bdy)) * root;
                rasterize_masks(backend, device, queue, enc, &mask_view, bw, bh, CLEAR, [(id, root_for_mask)]);
                self.surfaces.insert(mask_ref, Surface { texture: mask, view: mask_view, width: bw, height: bh });
            }
        }
        let result_view = self.surfaces[&result_ref].view.clone();

        let Some(tile) = write_to.tile else { return };
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let (sdx, sdy, sdw, sdh) = tiling::device_rect(full_view, clip);
        let ts = f64::from(TILE_SIZE);
        let ix0 = sdx.max(ox);
        let iy0 = sdy.max(oy);
        let ix1 = (sdx + sdw).min(ox + ts);
        let iy1 = (sdy + sdh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_rect = (((ix0 - bdx) * k) as f32, ((iy0 - bdy) * k) as f32, ((ix1 - ix0) * k) as f32, ((iy1 - iy0) * k) as f32);
        let src_size = (bw as f32, bh as f32);
        if self_clips {
            let b = Blit { src: &result_view, dst, src_rect, src_size, alpha: 1.0 };
            if k < 0.999 {
                self.compositor.blit_sharp(device, enc, &to_view, buf, &b);
            } else {
                self.compositor.blit(device, enc, &to_view, buf, &b);
            }
        } else {
            let mask_view = self.surfaces[&mask_ref].view.clone();
            let mb = MaskedBlit { src: &result_view, mask: &mask_view, dst, src_rect, src_size, alpha: 1.0 };
            if k < 0.999 {
                self.compositor.blit_masked_sharp(device, enc, &to_view, buf, &mb);
            } else {
                self.compositor.blit_masked(device, enc, &to_view, buf, &mb);
            }
        }
    }

    /// Draw one non-inset drop shadow of a **path** shape as a blurred silhouette, composited (SrcOver)
    /// into the tile scope behind the body. Classic vello has no inline arbitrary-silhouette blur, so:
    /// render the offset silhouette (in the shadow's colour) sharp into an extent-sized surface, blur it
    /// with the same `run_graph` Gaussian a background blur uses, then blit the result into the tile.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_path_shadow<B: RasterBackend>(
        &mut self,
        shape: u128,
        shadow: usize,
        sigma: f32,
        extent: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(tile) = write_to.tile else { return };
        let (edx, edy, edw, edh) = tiling::device_rect(full_view, extent);
        let w = edw.ceil().max(1.0) as u32;
        let h = edh.ceil().max(1.0) as u32;
        const MAX_SHADOW: u32 = 4096;
        if w > MAX_SHADOW || h > MAX_SHADOW {
            return;
        }

        let sil = self.pool.acquire_target(device, w, h, format, self.raster_usage, "path shadow silhouette");
        let sil_view = sil.create_view(&wgpu::TextureViewDescriptor::default());
        let root_for_sil = Affine::translate((-edx, -edy)) * root;
        let mut sscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut sscene, root_for_sil, shape, shadow, false, true, true);
        backend.rasterize(&sscene, device, queue, enc, &sil_view, w, h, TRANSPARENT);

        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        let blurred_view = if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma), None);
            let Some((_tex, view)) = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, enc, &[&sil_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            ) else {
                self.frame_transient.push(sil);
                return;
            };
            view
        } else {
            sil_view.clone()
        };
        self.frame_transient.push(sil);
        self.frame_transient_views.push(sil_view);

        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let ts = f64::from(TILE_SIZE);
        let ix0 = edx.max(ox);
        let iy0 = edy.max(oy);
        let ix1 = (edx + edw).min(ox + ts);
        let iy1 = (edy + edh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_rect = ((ix0 - edx) as f32, (iy0 - edy) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_size = (w as f32, h as f32);
        self.compositor.blit(device, enc, &to_view, buf, &Blit { src: &blurred_view, dst, src_rect, src_size, alpha: 1.0 });
    }

    /// Draw one **inner** (inset) shadow of a non-box shape as a blurred-silhouette band, composited
    /// (SrcOver) into the tile scope OVER the body (this step is scheduled after the body). Build the band
    /// in textures: flood the shape's silhouette in the shadow colour, render the same silhouette OFFSET
    /// and blur it, then punch that out of the flood with a Porter-Duff `DestOut` — colour survives only
    /// in the inner band on the offset side. The non-box analogue of the inline `draw_box_inner_shadows`.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_inner_shadow<B: RasterBackend>(
        &mut self,
        shape: u128,
        shadow: usize,
        sigma: f32,
        extent: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(tile) = write_to.tile else { return };
        let (edx, edy, edw, edh) = tiling::device_rect(full_view, extent);
        let w = edw.ceil().max(1.0) as u32;
        let h = edh.ceil().max(1.0) as u32;
        const MAX_SHADOW: u32 = 4096;
        if w > MAX_SHADOW || h > MAX_SHADOW {
            return;
        }
        let root_for_sil = Affine::translate((-edx, -edy)) * root;
        let full = (w as f32, h as f32);

        let flood = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow flood");
        let flood_view = flood.create_view(&wgpu::TextureViewDescriptor::default());
        let mut fscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut fscene, root_for_sil, shape, shadow, true, false, true);
        backend.rasterize(&fscene, device, queue, enc, &flood_view, w, h, TRANSPARENT);

        let punch = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow punch");
        let punch_view = punch.create_view(&wgpu::TextureViewDescriptor::default());
        let mut pscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut pscene, root_for_sil, shape, shadow, true, true, true);
        backend.rasterize(&pscene, device, queue, enc, &punch_view, w, h, TRANSPARENT);

        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma), None);
            let Some((ptex, pview)) = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, enc, &[&punch_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            ) else {
                self.frame_transient.push(flood);
                self.frame_transient.push(punch);
                return;
            };
            self.compositor.blit_dstout(device, enc, &flood_view, full, &Blit {
                src: &pview, dst: (0.0, 0.0, full.0, full.1), src_rect: (0.0, 0.0, full.0, full.1), src_size: full, alpha: 1.0,
            });
            self.frame_transient.push(ptex);
            self.frame_transient_views.push(pview);
        } else {
            self.compositor.blit_dstout(device, enc, &flood_view, full, &Blit {
                src: &punch_view, dst: (0.0, 0.0, full.0, full.1), src_rect: (0.0, 0.0, full.0, full.1), src_size: full, alpha: 1.0,
            });
        }
        self.frame_transient.push(punch);
        self.frame_transient_views.push(punch_view);

        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let ts = f64::from(TILE_SIZE);
        let ix0 = edx.max(ox);
        let iy0 = edy.max(oy);
        let ix1 = (edx + edw).min(ox + ts);
        let iy1 = (edy + edh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            self.frame_transient.push(flood);
            self.frame_transient_views.push(flood_view);
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_rect = ((ix0 - edx) as f32, (iy0 - edy) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_size = (w as f32, h as f32);
        self.compositor.blit(device, enc, &to_view, buf, &Blit { src: &flood_view, dst, src_rect, src_size, alpha: 1.0 });
        self.frame_transient.push(flood);
        self.frame_transient_views.push(flood_view);
    }

    /// Device-space Gaussian sigma for a background blur (render-core's [`effect_graph::background_blur_sigma`]):
    /// the shape's page-space radius mapped through the *effective* view scale (`zoom · k`). Using the
    /// capped scale is what makes the reduced-res backdrop's blur reach fit one tile —
    /// `3σ_device ≤ TILE_SIZE` by construction of `k`.
    fn gather_sigma(&self, id: u128, full_view: Affine, k: f64) -> f32 {
        let radius = crate::vello::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.background_blur));
        let c = full_view.as_coeffs();
        let scale = ((c[0] * c[0] + c[1] * c[1]).sqrt() * k) as f32;
        effect_graph::background_blur_sigma(radius.unwrap_or(0.0), scale)
    }

    /// The node's single backdrop-reading effect, if any — the one a gather runs. The stack holds at
    /// most one ([`crate::effect::effect_stack`]'s `else if` chain), so `find` is the whole answer.
    fn wv_backdrop_effect(id: u128) -> Option<crate::effect::Effect> {
        crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .and_then(|n| crate::effect::effect_stack(n).into_iter().find(crate::effect::Effect::reads_backdrop))
        })
    }

    /// Lower a gather's chain by asking the effect what its head op is, not by asking whether the node
    /// is a lens. `Lens` carries its own SDF clip (composite blits whole); `Blur`/`Shader` are clipped
    /// by an external silhouette mask — [`Self::wv_gather_self_clips`] states which.
    fn wv_gather_graph(
        &mut self,
        id: u128,
        bw: u32,
        bh: u32,
        bdx: f64,
        bdy: f64,
        full_view: Affine,
        k: f64,
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
    ) -> Option<Vec<Pass>> {
        use crate::effect::Op;
        match Self::wv_backdrop_effect(id)?.ops.first()? {
            Op::Lens(_) => self.lens_graph(id, bw, bh, bdx, bdy, full_view, k),
            Op::Shader(_) => self.custom_graph(id, bw, bh, device, format),
            Op::Blur { .. } => {
                Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, k)), None))
            }
            _ => None,
        }
    }

    /// Whether a gather's chain clips itself — true only for a `Lens` head, whose composite carries an
    /// SDF mask. Everything else needs the shape silhouette masked in after the chain runs.
    fn wv_gather_self_clips(id: u128) -> bool {
        Self::wv_backdrop_effect(id)
            .is_some_and(|e| matches!(e.ops.first(), Some(crate::effect::Op::Lens(_))))
    }

    /// Build the lens pass-graph over the assembled backdrop (input 0). The geometry→uniform math is
    /// render-core's [`effect_graph::lens_graph`]; this only reads the shape's lens params/box off
    /// the live scene and lowers the neutral graph (no custom pass, so no pipeline to resolve). Lens
    /// geometry is the shape's rounded box (axis-aligned; rotation is a gap); the composite's own SDF
    /// mask does the clip, so no silhouette mask is needed.
    /// The glass params and its device-independent [`LensGeometry`] for `id`, shared by the batched
    /// lens graph and the effects-in-fine frosted chain.
    fn lens_geom(&self, id: u128) -> Option<(crate::model::Glass, LensGeometry)> {
        crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            crate::effect_graph::lens_geometry(n, m)
        })
    }

    fn lens_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, geom) = self.lens_geom(id)?;
        let graph = effect_graph::lens_graph_scaled(&g, geom, (bw, bh), (bdx, bdy), full_view, k);
        Some(lower_graph(&graph, None))
    }

    /// The inline marker PLAN for every shadow on a Path/Text stack — the unified planner that retires the
    /// `wv_shadow_fine`/`wv_blur_texture_fine` PRE-PASS by running each shadow in the MAIN round loop. Walks
    /// the effect stack in z-order emitting a [`ShadowMarker::SharpDrop`] per sharp (σ<0.5) non-inset shadow
    /// (one `SPREAD|SCRATCH_COV` composite of the offset silhouette), a [`ShadowMarker::SoftDrop`] per soft
    /// non-inset shadow (H `BLUR|MATERIALIZE` → draft, V `BLUR|SPREAD` under the body), and a
    /// [`ShadowMarker::SoftInner`] per soft inset shadow (H, V materialise the punch, band over the body).
    /// Shadow coverage is a pure alpha field so the blur is LINEAR (no sRGB bit 1024). `None` (defer to the
    /// pre-pass) unless EVERY effect is a supported shadow or the body — a SHARP INNER keeps the pre-pass, a
    /// backdrop gather or non-Path/Text node too, and a shadow whose gate is off.
    fn wv_shadow_plan(&self, gid: u128, full_view: Affine, _w: u32, _h: u32) -> Option<Vec<ShadowMarker>> {
        crate::vello::abi::with_scene(|live, _, _| {
            let n = live.get(gid)?;
            // Path and Text both ride fine: `build_shadow_silhouette` rasterises each (a Text draws its
            // glyphs). A DROP's coverage is the blurred/offset silhouette; a Text INNER recovers its flood by
            // sampling that offset silhouette shifted back by the shadow offset (FLOOD_ERASE), so neither
            // needs per-glyph `area[i]` coverage.
            if !matches!(n.kind, crate::model::ShapeKind::Path | crate::model::ShapeKind::Text) {
                return None;
            }
            let stack = crate::effect::effect_stack(n);
            if stack.is_empty() {
                return None;
            }
            let cs = full_view.as_coeffs();
            let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
            let tint = |e: &crate::effect::Effect| {
                e.ops.iter().find_map(|op| match op {
                    crate::effect::Op::Tint(c) => Some(*c),
                    _ => None,
                })
            };
            let (mut drop_slot, mut inner_slot) = (0usize, 0usize);
            let mut plan = Vec::new();
            for e in &stack {
                match (&e.source, e.compose) {
                    (crate::effect::Source::Coverage { .. }, crate::effect::Compose::Under) => {
                        let sigma =
                            e.governing_blur().map_or(0.0, |r| crate::blur::radius_to_sigma(r) * scale);
                        if sigma < 0.5 {
                            // SHARP drop: one marker composites the offset silhouette (no blur) under the
                            // body. SPREAD|SCRATCH_COV lays the shadow colour at the silhouette scratch's
                            // alpha — the sink-rasterised offset coverage (slot-native, Path or Text).
                            if !wv_spread_fine() {
                                return None; // sharp drops A/B'd off — whole shape defers to the pre-pass
                            }
                            // One SPREAD composite of the sink-rasterised offset silhouette (SCRATCH_COV).
                            let desc = crate::vello::bake::spread_arm(crate::vello::bake::bits::SCRATCH_COV, tint(e)?.components);
                            plan.push(ShadowMarker::SharpDrop { desc, slot: drop_slot });
                            drop_slot += 1;
                            continue;
                        }
                        if !wv_dropblur_fine() {
                            return None; // soft drops A/B'd off — whole shape defers to the pre-pass
                        }
                        use crate::vello::bake::{blur_arm, Policy};
                        // Shadow coverage is a pure alpha field → LINEAR blur (no sRGB). H materializes a
                        // draft; V spreads the straight colour under the body. Both SHADOW_EDGE (OOB → 0).
                        let h = blur_arm(sigma, true, false, Policy { materialize: true, shadow_edge: true, ..Policy::default() }, None);
                        let v = blur_arm(sigma, true, true, Policy { spread: true, shadow_edge: true, ..Policy::default() }, Some(tint(e)?.components));
                        plan.push(ShadowMarker::SoftDrop { h, v, slot: drop_slot });
                        drop_slot += 1;
                    }
                    (crate::effect::Source::Coverage { .. }, crate::effect::Compose::Over) => {
                        if !wv_innerblur_fine() {
                            return None; // soft inners A/B'd off — whole shape defers to the pre-pass
                        }
                        let is_text = n.kind == crate::model::ShapeKind::Text;
                        // An inner shadow's blur rides on its EraseBy op (the punch's own radius).
                        let blur = e.ops.iter().find_map(|op| match op {
                            crate::effect::Op::EraseBy { blur, .. } => Some(*blur),
                            _ => None,
                        });
                        let sigma = blur.map_or(0.0, |r| crate::blur::radius_to_sigma(r) * scale);
                        if sigma < 0.5 {
                            // SHARP inner: no blur — the punch is the raw offset inset silhouette, so ONE band
                            // marker (SPREAD|ERASE, flood=area[i] minus that silhouette) reads it directly.
                            // Text has no glyph coverage in area[i], so a text sharp inner keeps the pre-pass.
                            if is_text {
                                return None;
                            }
                            // ONE band marker: flood (area[i]) minus the raw offset inset silhouette.
                            let band = crate::vello::bake::spread_arm(crate::vello::bake::bits::ERASE, tint(e)?.components);
                            plan.push(ShadowMarker::SharpInner { band, slot: inner_slot });
                            inner_slot += 1;
                            continue;
                        }
                        use crate::vello::bake::{blur_arm, bits, spread_arm, Policy};
                        // Both axis passes materialize (the 2D punch → scratch); linear silhouette blur,
                        // fade OOB to 0. The band composites flood minus punch, over the body.
                        let mat = Policy { materialize: true, shadow_edge: true, ..Policy::default() };
                        let colour = tint(e)?.components;
                        let h = blur_arm(sigma, true, false, mat, None);
                        let mut v = blur_arm(sigma, true, true, mat, None);
                        let mut band = spread_arm(bits::ERASE, colour);
                        if is_text {
                            // Text has no glyph coverage in `area[i]` (its outline is the bounds rect), so the
                            // band's FLOOD is recovered by sampling the OFFSET silhouette shifted BACK by the
                            // shadow offset. The V pass folds flood*(1 - alpha*punch) into its scratch alpha
                            // (FLOOD_ERASE, offset in u[1].xy device px, alpha in u[3].w), and the band reads
                            // that precomputed coverage directly (SCRATCH_COV) — no area[i]/erase.
                            let sh = n.shadows.iter().filter(|s| s.inset).nth(inner_slot)?;
                            v[0] += bits::FLOOD_ERASE as f32;
                            v[6] = sh.offset.x as f32 * scale; // u[1].x = device offset x
                            v[7] = sh.offset.y as f32 * scale; // u[1].y = device offset y
                            v[17] = colour[3]; // u[3].w = shadow alpha (erase fold)
                            band = spread_arm(bits::SCRATCH_COV, colour);
                        }
                        plan.push(ShadowMarker::SoftInner { h, v, band, slot: inner_slot });
                        inner_slot += 1;
                    }
                    (crate::effect::Source::Body, _) => {}
                    _ => return None,
                }
            }
            (!plan.is_empty()).then_some(plan)
        })
    }

    /// The DAG-sourced shadow plan for `gid` — the same `Vec<ShadowMarker>` `wv_shadow_plan` builds, but
    /// read straight from the filled whole-frame DAG instead of re-walking the effect stack. The
    /// beachhead of the stack-path swap: it handles an ALL-SOFT-DROP shape (every effect slot a soft drop,
    /// σ≥0.5) and returns `None` for anything else (a sharp drop, an inner, a non-shadow) so that shape
    /// falls back to `wv_shadow_plan`. Downstream (`schedule_shadows`, the window/dispatch machine) is
    /// untouched — only the SOURCE of the marker vec moves to the DAG. Each slot's `SoftDrop` H/V comes
    /// from `bake::blur_arm` over the slot's filled `Blur` sigma + `Tint` colour, matching `wv_shadow_plan`
    /// byte-for-byte.
    fn wv_shadow_plan_dag(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag) -> Option<Vec<ShadowMarker>> {
        use crate::vello::bake::{blur_arm, Policy};
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        use std::collections::BTreeMap;
        // Group this shape's effect nodes by slot, in slot order.
        let mut slots: BTreeMap<usize, Vec<&UnitOp>> = BTreeMap::new();
        for n in &dag.nodes {
            if let Source::Effect { shape, slot } = n.source {
                if shape == gid {
                    slots.entry(slot).or_default().push(&n.op);
                }
            }
        }
        if slots.is_empty() {
            return None;
        }
        let mut plan = Vec::new();
        for (drop_slot, ops) in slots.values().enumerate() {
            // A soft drop is a Tint + a filled Blur (σ≥0.5), with NO EraseBy (an inner) and no head (glass).
            let has_erase = ops.iter().any(|o| matches!(o, UnitOp::EraseBy(_)));
            let has_head = ops.iter().any(|o| matches!(o, UnitOp::Warp(_) | UnitOp::Scatter(_)));
            let sigma = ops.iter().find_map(|o| match o {
                UnitOp::Blur { sigma, .. } => Some(*sigma),
                _ => None,
            });
            let colour = ops.iter().find_map(|o| match o {
                UnitOp::Tint(u) if u.len() >= 4 => Some([u[0], u[1], u[2], u[3]]),
                _ => None,
            });
            match (has_erase, has_head, sigma, colour) {
                (false, false, Some(s), Some(c)) if s >= 0.5 => {
                    let mat = Policy { materialize: true, shadow_edge: true, ..Policy::default() };
                    let spr = Policy { spread: true, shadow_edge: true, ..Policy::default() };
                    let h = blur_arm(s, true, false, mat, None);
                    let v = blur_arm(s, true, true, spr, Some(c));
                    plan.push(ShadowMarker::SoftDrop { h, v, slot: drop_slot });
                }
                // A sharp drop, an inner, or a non-shadow slot — out of the beachhead's scope, so the whole
                // shape falls back to the effect-stack planner.
                _ => return None,
            }
        }
        if std::env::var("WV_TRACE").is_ok() {
            eprintln!("  WV_DAG: {} soft-drop shadow marker(s) for gid {gid:x} from the DAG", plan.len());
        }
        (!plan.is_empty()).then_some(plan)
    }

    /// The edge-driven dispatch plan for an all-soft-drop shape — the DAG nodes the executor binds by
    /// EDGE, not by role/round. `sils` = each drop's silhouette `Rasterize` node (+ its slot) to
    /// rasterise into `node_scratch[node]`; `blurs` = each axis `Blur` node with its packer round and
    /// whether it MATERIALISES (H, writes its own node scratch that the V reads) or composites (V, SPREAD
    /// over the accumulator). The dispatch reads `node.inputs[0]` to find its source scratch — the H's is
    /// the silhouette node, the V's is the H node — so `punch_key`/`window_lo-1` round-keying is gone.
    /// `None` for any sharp/inner/non-soft-drop shape (stays on the role dispatch).
    fn wv_dag_shadow(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag, sched: &[ShadowMk]) -> Option<DagShadow> {
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        use std::collections::{BTreeMap, HashSet};
        let mut slots: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for (i, n) in dag.nodes.iter().enumerate() {
            if let Source::Effect { shape, slot } = n.source {
                if shape == gid {
                    slots.entry(slot).or_default().push(i);
                }
            }
        }
        let op = |i: usize| &dag.nodes[i].op;
        let is_raster = |i: usize| matches!(op(i), UnitOp::Rasterize);
        // The H blur reads a `Rasterize` silhouette; the V blur reads another `Blur`; the band is the
        // `EraseBy`. Each is unique within a slot.
        let blur_h = |s: usize| slots.get(&s)?.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && is_raster(dag.nodes[i].inputs[0]));
        let blur_v = |s: usize| slots.get(&s)?.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && !is_raster(dag.nodes[i].inputs[0]));
        let erase = |s: usize| slots.get(&s)?.iter().copied().find(|&i| matches!(op(i), UnitOp::EraseBy(_)));
        let is_inner = |s: usize| slots.get(&s).is_some_and(|v| v.iter().any(|&i| matches!(op(i), UnitOp::EraseBy(_))));
        // After `elide_negligible_blurs`, a SHARP drop's `Tint` reads the silhouette `Rasterize` directly
        // (its blurs are gone) and a SHARP inner's `EraseBy` reads a raw `Rasterize` punch — the same
        // nodes, just with a silhouette edge instead of a blur edge, so no separate lane.
        let tint_sil = |s: usize| slots.get(&s)?.iter().copied().find(|&i| matches!(op(i), UnitOp::Tint(_)) && is_raster(dag.nodes[i].inputs[0]));
        let mut passes = Vec::new();
        for mk in sched {
            // Map the scheduled marker to the DAG node it runs — the executor then binds it by op + edges.
            let node = match mk.role {
                ShadowRole::BlurH => blur_h(mk.slot)?,
                ShadowRole::DropV | ShadowRole::InnerV => blur_v(mk.slot)?,
                ShadowRole::InnerBand | ShadowRole::SharpInnerBand => erase(mk.slot)?,
                ShadowRole::SharpDrop => tint_sil(mk.slot)?,
            };
            passes.push((mk.round, node));
        }
        // The silhouettes a pass BINDS (a blur/Tint's source edge inputs[0], or an EraseBy's punch edge
        // inputs[1]) — the ones rasterised into node_scratch. The inner flood (EraseBy inputs[0]) is
        // area[i], never a scratch, so it is excluded.
        let (mut sils, mut seen) = (Vec::new(), HashSet::new());
        for &(_, node) in &passes {
            let bound = match op(node) {
                UnitOp::Blur { .. } | UnitOp::Tint(_) => dag.nodes[node].inputs[0],
                UnitOp::EraseBy(_) => dag.nodes[node].inputs[1],
                _ => continue,
            };
            if is_raster(bound) && seen.insert(bound) {
                let Source::Effect { slot, .. } = dag.nodes[bound].source else { continue };
                sils.push((bound, slot, is_inner(slot)));
            }
        }
        (!passes.is_empty()).then_some(DagShadow { sils, passes })
    }

    /// The sharp-stack lens's warp node + its SDF source node (`WV_DAG_EXEC`). The warp is the head of the
    /// fused `[Warp, Shade, MaskMix]` glass arm (its consumer is a `Shade`, no frost blur between); its
    /// second input, if present, is the SDF `Rasterize` source of a shape-following (sampled) lens.
    fn wv_dag_glass(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag) -> Option<(usize, Option<usize>)> {
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        let warp = dag.nodes.iter().enumerate().find_map(|(i, n)| {
            let is_mine = matches!(n.source, Source::Effect { shape, .. } if shape == gid);
            let is_glass_warp = matches!(n.op, UnitOp::Warp(_))
                && dag.nodes.iter().any(|m| m.inputs.contains(&i) && matches!(m.op, UnitOp::Shade(_)));
            (is_mine && is_glass_warp).then_some(i)
        })?;
        Some((warp, dag.nodes[warp].inputs.get(1).copied()))
    }

    /// The two axis `Blur` nodes of a pure background blur (`WV_DAG_EXEC`): H reads the `Reload`
    /// backdrop, V reads H. `None` if the shape is not a bg blur (a lens/frost has a `Warp` head).
    fn wv_dag_bg_blur(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag) -> Option<(usize, usize)> {
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        let mine: Vec<usize> = dag
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| matches!(n.source, Source::Effect { shape, .. } if shape == gid))
            .map(|(i, _)| i)
            .collect();
        if mine.iter().any(|&i| matches!(dag.nodes[i].op, UnitOp::Warp(_) | UnitOp::Scatter(_))) {
            return None; // a lens/frost, not a background blur
        }
        let op = |i: usize| &dag.nodes[i].op;
        let h = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && matches!(op(dag.nodes[i].inputs[0]), UnitOp::Reload))?;
        let v = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && dag.nodes[i].inputs[0] == h)?;
        Some((h, v))
    }

    /// The five frost-chain nodes of a lens `gid` (`WV_DAG_EXEC`), in stage order: warp, blur-H, blur-V,
    /// scatter, tail (the `Shade` — its `MaskMix` fuses into the same descriptor). `None` unless the lens
    /// is frosted (has the full warp→blur→scatter chain).
    fn wv_dag_frost(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag) -> Option<[usize; 5]> {
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        let mine: Vec<usize> = dag
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| matches!(n.source, Source::Effect { shape, .. } if shape == gid))
            .map(|(i, _)| i)
            .collect();
        let op = |i: usize| &dag.nodes[i].op;
        let warp = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Warp(_)))?;
        let blur_h = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && dag.nodes[i].inputs[0] == warp)?;
        let blur_v = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Blur { .. }) && dag.nodes[i].inputs[0] == blur_h)?;
        let scatter = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Scatter(_)))?;
        let shade = mine.iter().copied().find(|&i| matches!(op(i), UnitOp::Shade(_)) && dag.nodes[i].inputs[0] == scatter)?;
        Some([warp, blur_h, blur_v, scatter, shade])
    }

    /// The DAG-sourced SCHEDULE for `gid` — the `Vec<ShadowMk>` (round + role + descriptor) that
    /// `schedule_shadows` produces, derived straight from the filled DAG instead of the `ShadowMarker`
    /// plan + the hand-rolled round math. Stage 1 of the DAG-edge executor (`WV_DAG_EXEC`): for an
    /// ALL-SOFT-DROP shape it lays each drop's H (`base+2k`) and V (`base+2k+1`) exactly as
    /// `schedule_shadows` does, so the whole downstream machine is byte-identical; returns `None` for any
    /// sharp/inner/non-shadow slot so that shape stays on `schedule_shadows`. This retires the scheduling
    /// layer (`ShadowMarker` → `schedule_shadows` → `ShadowMk`) for the soft-drop path.
    fn wv_shadow_sched_dag(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag, base: u32) -> Option<Vec<ShadowMk>> {
        use crate::vello::bake::{blur_arm, Policy};
        use crate::vello::frame_dag::Source;
        use crate::vello::units::UnitOp;
        use std::collections::BTreeMap;
        let mut slots: BTreeMap<usize, Vec<&UnitOp>> = BTreeMap::new();
        for n in &dag.nodes {
            if let Source::Effect { shape, slot } = n.source {
                if shape == gid {
                    slots.entry(slot).or_default().push(&n.op);
                }
            }
        }
        if slots.is_empty() {
            return None;
        }
        let mut mks = Vec::new();
        let mut cursor = base;
        for (drop_slot, ops) in slots.values().enumerate() {
            let has_erase = ops.iter().any(|o| matches!(o, UnitOp::EraseBy(_)));
            let has_head = ops.iter().any(|o| matches!(o, UnitOp::Warp(_) | UnitOp::Scatter(_)));
            let sigma = ops.iter().find_map(|o| match o {
                UnitOp::Blur { sigma, .. } => Some(*sigma),
                _ => None,
            });
            let colour = ops.iter().find_map(|o| match o {
                UnitOp::Tint(u) if u.len() >= 4 => Some([u[0], u[1], u[2], u[3]]),
                _ => None,
            });
            match (has_erase, has_head, sigma, colour) {
                (false, false, Some(s), Some(c)) if s >= 0.5 => {
                    let h = blur_arm(s, true, false, Policy { materialize: true, shadow_edge: true, ..Policy::default() }, None);
                    let v = blur_arm(s, true, true, Policy { spread: true, shadow_edge: true, ..Policy::default() }, Some(c));
                    mks.push(ShadowMk { round: cursor, desc: h, role: ShadowRole::BlurH, slot: drop_slot, inset: false, punch_key: 0 });
                    mks.push(ShadowMk { round: cursor + 1, desc: v, role: ShadowRole::DropV, slot: drop_slot, inset: false, punch_key: 0 });
                    cursor += 2;
                }
                _ => return None,
            }
        }
        (!mks.is_empty()).then_some(mks)
    }

    /// The device-space 24-float lens field uniform for glass `gid`, for the effects-in-fine WARP path
    /// (`fx_computeField_lens` in fine.wgsl). Built like the batched lens but at DEVICE resolution —
    /// backdrop origin `(0,0)`, `k = 1` — so `fine` evaluates the field in global pixel coordinates and
    /// samples `base_in` there. `None` unless the glass is SHARP (no frost/blur): a blurred lens is a
    /// barrier `fine` cannot run inline (a neighbourhood, not a single displaced tap).
    fn wv_lens_fine_uniform(&self, gid: u128, full_view: Affine, w: u32, h: u32) -> Option<[f32; 24]> {
        let sharp = crate::vello::abi::with_scene(|live, _, _| {
            live.get(gid).and_then(|n| n.glass).is_some_and(|g| g.total_blur_sigma() <= 0.5)
        });
        if !sharp {
            return None;
        }
        let passes = self.lens_graph(gid, w, h, 0.0, 0.0, full_view, 1.0)?;
        match batch_admit(&passes) {
            Some(BatchShape::Lens { head, tail, .. }) => {
                let mut ops = vec![head];
                ops.extend(tail);
                Some(crate::vello::units::units_uniform(&ops))
            }
            _ => None,
        }
    }

    /// The effects-in-fine chain for a FROSTED lens (`total_blur_sigma > 0.5`): five markers —
    /// warp → blur H → blur V → scatter → tail (shade+maskmix) — each a 26-float descriptor, run one
    /// per round of a reserved 5-round block. `None` for a sharp lens (handled by
    /// [`Self::wv_lens_fine_uniform`]) or a non-glass gather.
    ///
    /// The four field units (warp/scatter/shade/maskmix) share ONE merged 24-float lens uniform — each
    /// fine arm reads only its own slots (warp's chromatic aberration, scatter's frost, shade's
    /// specular), so `units_uniform`'s first-non-zero merge is exactly the union. The two blur markers
    /// instead carry their axis + device sigma in `u[0]` and blur in sRGB (bit 1024), matching the
    /// batched lens `Blur { linear: false }`. The intermediate links set MATERIALIZE (512) so they write
    /// their scratch UNMASKED; the tail composites masked (`area[i]`).
    fn wv_frost_passes(&self, gid: u128, full_view: Affine, w: u32, h: u32) -> Option<Vec<[f32; 26]>> {
        use crate::effect_graph::EffectPass;
        let (g, geom) = self.lens_geom(gid)?;
        let zoom = {
            let c = full_view.as_coeffs();
            (c[0] * c[0] + c[1] * c[1]).sqrt()
        };
        let sigma = g.total_blur_sigma() * zoom as f32;
        if sigma <= 0.5 {
            return None;
        }
        // Device-scale (k = 1) lens graph; merge the field units' uniforms first-non-zero per slot.
        let graph = crate::effect_graph::lens_graph(&g, geom, (w, h), (0.0, 0.0), full_view, 1.0);
        let mut u = [0.0f32; 24];
        for p in &graph {
            if let EffectPass::Unit { u: pu, .. } = &p.pass {
                for (i, v) in pu.iter().enumerate().take(24) {
                    if u[i] == 0.0 {
                        u[i] = *v;
                    }
                }
            }
        }
        let lens = |bits: f32| {
            let mut d = [0.0f32; 26];
            d[0] = bits;
            d[1] = 1.0; // program = lens
            d[2..26].copy_from_slice(&u);
            d
        };
        let blur = |ax: f32, ay: f32| {
            let mut d = [0.0f32; 26];
            d[0] = 64.0 + 512.0 + 1024.0; // BLUR | MATERIALIZE | sRGB
            d[2] = ax; // u[0].x = axis.x
            d[3] = ay; // u[0].y = axis.y
            d[4] = sigma; // u[0].z = device sigma
            d
        };
        Some(vec![
            lens(32.0 + 512.0),   // warp → scratchA (materialize)
            blur(1.0, 0.0),       // blur H (input = warp) → scratchB
            blur(0.0, 1.0),       // blur V (draft = H) → scratchC
            lens(256.0 + 512.0),  // scatter (input = blurred) → scratchA
            lens(8.0 + 16.0),     // tail: shade | maskmix (input = scattered) → accumulator
        ])
    }

    /// The effects-in-fine PASSES for a gather that rides fine, each a full 26-float descriptor
    /// `[bits, program, 6×vec4 u]`; `None` if it does not ride fine. One pass per marker the planner
    /// emits, in round order: a sharp glass → one WARP|SHADE|MASKMIX pass over the lens field (program
    /// 1); a background blur → two BLUR passes, H then V, each carrying its axis in `u[0].xy` (the
    /// separable blur, one marker each). Gated per kind by `WV_GLASS_FINE` / `WV_BLUR_FINE`.
    /// The DAG-driven descriptors for `gid`, straight from the schedule via
    /// [`crate::vello::frame_dag::FrameDag::arms_for`] — the scheduler's round-partition, serialized by
    /// `bake`, with no per-effect planner. `arms_for` returns `None` for any shape not yet fully
    /// DAG-drivable (a unit the scheduler has not stamped, or a `Blur`/`Custom` arm), so the caller
    /// falls back to the planner for it. Today SHARP glass flows through here byte-identically; the seam
    /// widens as `fill_lens_uniforms` fills more units.
    fn wv_dag_glass_passes(&self, gid: u128, dag: &crate::vello::frame_dag::FrameDag) -> Option<Vec<[f32; 26]>> {
        let passes = dag.arms_for(gid, crate::vello::frame_dag::TILE_PX)?;
        if std::env::var("WV_TRACE").is_ok() {
            eprintln!("  WV_DAG: {} baked arm(s) for gid {gid:x} from the schedule", passes.len());
        }
        Some(passes)
    }

    fn wv_fine_passes(&self, gid: u128, full_view: Affine, w: u32, h: u32) -> Option<Vec<[f32; 26]>> {
        if wv_glass_fine() {
            if let Some(u) = self.wv_lens_fine_uniform(gid, full_view, w, h) {
                let mut d = [0.0f32; 26];
                d[0] = 56.0; // bits = SHADE(8) | MASKMIX(16) | WARP(32)
                d[1] = 1.0; // program = lens
                d[2..26].copy_from_slice(&u);
                return Some(vec![d]);
            }
        }
        // A frosted lens is not a single fused marker (`wv_lens_fine_uniform` returns None) — it rides
        // fine as the five-marker chained gather when `WV_FROST_FINE` is on.
        if wv_frost_fine() {
            if let Some(chain) = self.wv_frost_passes(gid, full_view, w, h) {
                return Some(chain);
            }
        }
        if wv_blur_fine() {
            let has_blur =
                crate::vello::abi::with_scene(|live, _, _| live.get(gid).and_then(|n| n.background_blur)).is_some();
            if has_blur {
                let sigma = self.gather_sigma(gid, full_view, 1.0);
                // SEPARABLE — two markers, O(r). The H pass (axis (1,0)) blurs `base_in` and writes its
                // result UNMASKED to a draft (the driver points its `out` at the draft); the V pass
                // (axis (0,1)) blurs that draft and composites masked ONCE. Splitting the mask off the
                // first pass is what keeps a masked blur correct: an in-place separable blur clips its
                // intermediate to the silhouette and the second pass reads holes.
                let pass = |ax: f32, ay: f32| {
                    let mut d = [0.0f32; 26];
                    d[0] = 64.0; // bits = BLUR
                    d[2] = ax; // u[0].x = axis.x
                    d[3] = ay; // u[0].y = axis.y
                    d[4] = sigma; // u[0].z = device sigma
                    d
                };
                return Some(vec![pass(1.0, 0.0), pass(0.0, 1.0)]);
            }
        }
        None
    }

    /// Build the custom-shader graph: one custom pass over the assembled backdrop (input 0). The
    /// neutral graph is render-core's [`effect_graph::custom_graph`]; this resolves the shape's
    /// pipeline (compiled once per distinct WGSL source, cached by hash) and lowers with it. The
    /// uniform is the backdrop resolution followed by the shader's declared params.
    fn custom_graph(&mut self, id: u128, bw: u32, bh: u32, device: &wgpu::Device, format: wgpu::TextureFormat) -> Option<Vec<Pass>> {
        let (wgsl, params, param_vec4s, reach) = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .and_then(|n| n.gather_shader().map(|c| (c.wgsl.clone(), c.params.clone(), c.param_vec4s, c.reach)))
        })?;
        let n_inputs = 1;
        let mut hasher = DefaultHasher::new();
        wgsl.hash(&mut hasher);
        n_inputs.hash(&mut hasher);
        let key = hasher.finish();
        self.cap_custom_pipelines(key);
        let pipeline = self
            .custom_pipelines
            .entry(key)
            .or_insert_with(|| build_custom_pipeline(device, &wgsl, n_inputs, format))
            .clone();
        let mut u = vec![bw as f32, bh as f32];
        u.extend_from_slice(&params);
        // A gather by construction (`gather_shader` = the `reads_backdrop` custom); its declared reach
        // sizes the backdrop surface it reads.
        Some(lower_graph(&effect_graph::custom_graph(u, param_vec4s, reach, true), Some(&pipeline)))
    }
}

#[cfg(test)]
mod batch_admission_tests {
    use super::{batch_admit, BatchShape};
    use crate::effect_graph::{drop_shadow_graph, inner_shadow_graph, tint_graph, GraphPass};
    use crate::vello::graph::lower_graph;

    const C: [f32; 4] = [0.1, 0.2, 0.3, 0.8];

    fn admit(g: &[GraphPass]) -> Option<BatchShape> {
        batch_admit(&lower_graph(g, None))
    }

    /// Admission is what decides whether shadows batch at all, and pixels cannot prove it: a
    /// rejected chain falls back to the per-shape path, which renders the same image.
    #[test]
    fn the_shadow_chains_admit_as_stamps() {
        for g in [
            drop_shadow_graph(64.0, 64.0, C, 4.0),
            drop_shadow_graph(64.0, 64.0, C, 0.0),
            tint_graph(64.0, 64.0, C),
            inner_shadow_graph(64.0, 64.0, C, 4.0),
        ] {
            assert!(matches!(admit(&g), Some(BatchShape::Stamp { .. })), "expected a stamp");
        }
    }

    /// One blur per cell is what the H/V stage pair expresses; a second would need a round trip the
    /// plan does not allocate.
    #[test]
    fn two_blurs_in_one_cell_are_refused() {
        let mut g = drop_shadow_graph(64.0, 64.0, C, 4.0);
        let blur = g
            .iter()
            .find(|p| matches!(p.pass, crate::effect_graph::EffectPass::Blur { .. }))
            .expect("a blurred drop shadow has a blur")
            .clone();
        g.push(blur);
        assert_eq!(admit(&g), None);
    }

    /// A sigma past the separable cap still belongs on the per-shape path.
    #[test]
    fn a_blur_past_the_cap_is_refused() {
        let big = crate::vello::graph::BLUR_MAX_SIGMA + 1.0;
        assert_eq!(admit(&drop_shadow_graph(64.0, 64.0, C, big)), None);
    }

    /// The head is what separates the two stage families: a sampling unit is a lens, everything
    /// pointwise is a stamp. This is the distinction the two old predicates encoded separately, and
    /// the reason a chain could previously belong to neither.
    #[test]
    fn a_sampling_head_admits_as_a_lens_not_a_stamp() {
        use crate::vello::units::UnitOp;
        use crate::vello::graph::Pass;
        let units = |ops: Vec<UnitOp>| Pass {
            units: ops,
            field: Some(std::rc::Rc::new(crate::field::FieldProgram {
                nodes: Vec::new(),
                outputs: Vec::new(),
            })),
            custom: None,
            inputs: Vec::new(),
            scale: 1.0,
        };
        let u = || vec![0.0_f32; 24];

        let lens = units(vec![UnitOp::Warp(u()), UnitOp::MaskMix(u())]);
        match batch_admit(&[lens]) {
            Some(BatchShape::Lens { tail, sigma, .. }) => {
                assert_eq!(tail.len(), 1, "the tail is everything after the head");
                assert_eq!(sigma, 0.0, "a sharp lens has no blur");
            }
            other => panic!("a sampling head is a lens, got {other:?}"),
        }

        // Pointwise units the stamp stages do not implement are refused outright rather than
        // silently falling into the wrong family.
        assert_eq!(batch_admit(&[units(vec![UnitOp::MaskMix(u())])]), None);
    }
}
