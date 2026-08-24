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

/// The frame's instanced-batch plan: which FX_STACK shapes run through the per-stage passes, and the
/// instances each stage draws. `h`/`v` cover every batched cell once; `c` is ordered by round, then
/// by the shape's own stack order (shadows before body — instance order IS composite order), with
/// `c_ranges` naming each round's slice.
struct WvBatchPlan {
    h: Vec<crate::vello::batch::Inst>,
    v: Vec<crate::vello::batch::Inst>,
    /// EraseBy band materialisations, one per inner shadow, drawn in ONE combine pass.
    combine: Vec<crate::vello::batch::Inst>,
    /// The erase draw's unit uniforms, one per instance — where `EraseBy` reads its strength.
    combine_f: Vec<crate::vello::batch::FieldUniform>,
    /// The frame's stages in dependency order — the blur pair and the combine hoisted out of the
    /// round loop, one composite pinned to each round that has work. Which atlas each one writes is
    /// the planner's answer, not a constant here ([`crate::vello::plan::colour_stages`]).
    stages: Vec<crate::vello::batch::Stage>,
    /// How many scratch atlases the colouring needs — A4's chromatic number, which is what the
    /// executor has to pool. Two for today's chains; a stage reading two live atlases would raise it
    /// without anything else changing.
    atlases: usize,
    /// The CELLS the batch composites. Admission is per entry, not per shape: a stack with one
    /// custom-shader body used to send its plain drop shadows down the per-shape path too, which is
    /// why the 4K stress scene batched nothing at all.
    taken: HashSet<(u128, u8, usize)>,
    /// For a cell the batch declined, which of its shape's rounds the per-shape painter draws it in.
    /// Absent means round offset zero, which is every shape the batch never looked at.
    legacy_sub: HashMap<(u128, u8, usize), u32>,
    /// Extra rounds a shape needs beyond its own, because the batch had to step over a declined
    /// entry. Zero for a shape the batch took whole.
    extra: HashMap<u128, u32>,
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

/// [`batch_admit`] for one cell, lowering the cell's OWN chain the way the executor will. Nothing
/// is reconstructed here: a chain the stages cannot run declines because of what it is.
fn wv_batch_cell_shape(c: &Cell) -> Option<BatchShape> {
    batch_admit(&c.passes)
}

/// One cell's unit uniform — the same 24 floats the per-shape pipeline binds, which is now what the
/// batch binds too.
///
/// A chain with no `Tint` gets the disabling sentinel (alpha below zero) rather than a zero colour,
/// because the pointwise arms carry `Tint` unconditionally so that a coloured silhouette and an
/// uncoloured body can ride the same draw. Zero would multiply the body away.
fn wv_stamp_uniform(ops: &[crate::vello::units::UnitOp]) -> crate::vello::batch::FieldUniform {
    let mut u = crate::vello::units::units_uniform(ops);
    if !ops.iter().any(|o| matches!(o, crate::vello::units::UnitOp::Tint(_))) {
        u[12..16].copy_from_slice(&[0.0, 0.0, 0.0, -1.0]);
    }
    crate::vello::batch::FieldUniform { u }
}

/// Which pointwise arm a composite draw of `ops` runs. `Tint` is always in it (self-disabling), and
/// every other pointwise unit the tail carries adds its bit — so a unit the admission accepted is
/// automatically reachable in the shader, with no second list to keep in step.
fn wv_composite_bits(ops: &[crate::vello::units::UnitOp]) -> u32 {
    use crate::vello::batch::pointwise;
    use crate::vello::units::UnitOp;
    let mut bits = pointwise::TINT;
    for op in ops {
        if matches!(op, UnitOp::ClipToSource(_)) {
            bits |= pointwise::CLIP;
        }
    }
    bits
}

/// Build the batch plan for this frame, or `None` when batching is off or nothing qualifies.
///
/// Each candidate cell carries its own lowered chain ([`Cell::graph`]) and is admitted iff
/// [`wv_batch_supported`] — so the batch executes the same IR the per-shape path executes, through
/// instanced stages instead of private pass chains. Shapes stay per-shape when their stack composes
/// mid-backdrop (lens), carries custom `Shader` ops, or blurs past what the instanced stage
/// expresses; inner shadows batch through the combine (`EraseBy`) stage.
fn wv_batch_plan(
    gathers: &[(usize, u128, u8)],
    rounds: &[u32],
    packing: &crate::atlas::Packing,
    cells: &[(Cell, usize)],
    strip_y: u32,
    acc_size: (f32, f32),
) -> Option<WvBatchPlan> {
    let atlas_size = (packing.width as f32, packing.height as f32);
    let mut place: HashMap<(u128, u8, usize), (u32, u32)> = HashMap::new();
    for pl in &packing.cells {
        place.insert(cells[pl.index].0.key, (pl.x, pl.y));
    }
    let mut plan = WvBatchPlan {
        h: Vec::new(),
        v: Vec::new(),
        combine: Vec::new(),
        combine_f: Vec::new(),
        stages: Vec::new(),
        atlases: 0,
        taken: HashSet::new(),
        legacy_sub: HashMap::new(),
        extra: HashMap::new(),
    };
    // Keyed by round AND by the arm the draw runs: instances of one round that compose differently
    // are different draws, because an arm is per-pipeline-invocation and not per-instance. Today
    // every stamp composes the same way and this is one group per round, exactly as before.
    type Group = (Vec<crate::vello::batch::Inst>, Vec<crate::vello::batch::FieldUniform>);
    let mut by_round: std::collections::BTreeMap<(u32, u32), Group> =
        std::collections::BTreeMap::new();
    for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
        if kind != FX_STACK {
            continue;
        }
        let stack = crate::vello::abi::with_scene(|live, _, _| {
            live.get(gid).map(crate::effect::effect_stack).unwrap_or_default()
        });
        let shape_cells: Vec<&Cell> =
            cells.iter().map(|(c, _)| c).filter(|c| c.key.0 == gid).collect();
        // A scoped backdrop reads the accumulator mid-stack and is composed by `wv_stamp_gather`
        // for the whole shape at once, so it is still all-or-nothing. Everything else is admitted
        // ENTRY BY ENTRY below.
        if stack.iter().any(|e| matches!(e.source, Source::Backdrop)) || shape_cells.is_empty() {
            continue;
        }
        let find = |kind: u8, idx: usize| {
            shape_cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).copied()
        };
        #[derive(Clone, Copy)]
        enum Emit<'a> {
            Cell(&'a Cell),
            Inner { flood: &'a Cell, punch: &'a Cell },
            /// An entry the batch declined. It is not a hole: it holds the position the per-shape
            /// painter has to composite in, which is what the round assignment below reads.
            Legacy(Option<(u128, u8, usize)>),
        }
        let placed = |c: &Cell| place.contains_key(&c.key);
        let stampable = |c: &Cell| {
            placed(c) && matches!(wv_batch_cell_shape(c), Some(BatchShape::Stamp { .. }))
        };
        let mut emit: Vec<Emit> = Vec::new();
        let (mut drop_i, mut inner_i, mut body_done) = (0usize, 0usize, false);
        // The body appears at most once, so its verdict is a value rather than something recomputed
        // at each of the three places the stack can reach it. A shaded body declines inside
        // `stampable` now: its chain carries the `Custom` pass, and no stamp stage runs one.
        let body = match find(1, 0) {
            Some(c) if stampable(c) => Emit::Cell(c),
            Some(c) => Emit::Legacy(Some(c.key)),
            None => Emit::Legacy(None),
        };
        for e in &stack {
            match (&e.source, e.compose) {
                (Source::Coverage { .. }, Compose::Under) => {
                    match find(0, drop_i) {
                        Some(c) if stampable(c) => emit.push(Emit::Cell(c)),
                        Some(c) => emit.push(Emit::Legacy(Some(c.key))),
                        None => {}
                    }
                    drop_i += 1;
                }
                (Source::Body, _) => {
                    if !body_done {
                        emit.push(body);
                        body_done = true;
                    }
                }
                (Source::Coverage { .. }, Compose::Over) => {
                    // The per-shape path paints the body before its first inner shadow; the batch
                    // preserves that by emitting it here in the same position.
                    if !body_done {
                        emit.push(body);
                        body_done = true;
                    }
                    match (find(2, inner_i), find(3, inner_i)) {
                        (Some(flood), Some(punch)) if stampable(flood) && stampable(punch) => {
                            emit.push(Emit::Inner { flood, punch });
                        }
                        // A planned inner shadow the batch cannot express keeps its position and
                        // goes back to the per-shape painter — dropping it would change pixels.
                        (Some(flood), _) => emit.push(Emit::Legacy(Some(flood.key))),
                        _ => emit.push(Emit::Legacy(None)),
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        if !body_done {
            emit.push(body);
        }
        if !emit.iter().any(|e| !matches!(e, Emit::Legacy(_))) {
            continue;
        }
        let rects = |c: &Cell| {
            let (px, py) = place[&c.key];
            let (kwf, khf) = (c.kw as f32, c.kh as f32);
            (
                (px as f32, (strip_y + py) as f32, kwf, khf),
                (px as f32, py as f32, kwf, khf),
                (c.geom.bx(), c.geom.by(), c.geom.bw(), c.geom.bh()),
            )
        };
        // The cell's parameters come from its lowered graph, not from the cell fields — the builder
        // owns the sigma/linear semantics for BOTH paths. An empty graph is the identity: the cell
        // rides the blur stages as a sigma-0 copy so every batched cell lands in the surface the
        // later stages sample.
        let params = |c: &Cell| match wv_batch_cell_shape(c) {
            Some(BatchShape::Stamp { sigma, linear, .. }) => (sigma, linear),
            _ => (0.0, false),
        };
        let cell_units = |c: &Cell| match wv_batch_cell_shape(c) {
            Some(BatchShape::Stamp { ops, .. }) => ops,
            _ => Vec::new(),
        };
        let mut blur = |plan: &mut WvBatchPlan, c: &Cell| {
            let (strip_rect, atlas_rect, _) = rects(c);
            let (sigma_dev, linear) = params(c);
            plan.h.push(crate::vello::batch::Inst::new(
                atlas_rect, atlas_size, strip_rect, acc_size, (1.0, 0.0), sigma_dev, linear,
            ));
            plan.v.push(crate::vello::batch::Inst::new(
                atlas_rect, atlas_size, atlas_rect, atlas_size, (0.0, 1.0), sigma_dev, linear,
            ));
        };
        // Slot order inside a round is fixed by the executor: the batch stages run first, then the
        // per-shape painters. So an entry the batch takes that FOLLOWS one it declined cannot sit in
        // the same round — it would composite underneath what should be beneath it. Moving it to the
        // next round is the whole of the fix, and it is the only reason the batch splits a shape.
        //
        // Stepping over a round is safe because of what [`wv_rounds`] guarantees. The extra round
        // flushes the fine window that holds every marker at this shape's own round, and shapes that
        // SHARE a round are reach-disjoint by construction — so nothing that window materialises can
        // overlap the pixels this suffix writes. Markers below the shape were already beneath it,
        // and markers above it flush a round later, exactly as before. Instances inside one round
        // keep gather order, which is z order, so a suffix never overtakes a shape above it.
        let mut sub = 0u32;
        let mut after_legacy = false;
        for e in &emit {
            match e {
                Emit::Legacy(key) => {
                    after_legacy = true;
                    if let Some(k) = key {
                        plan.legacy_sub.insert(*k, sub);
                    }
                }
                _ if after_legacy => {
                    sub += 1;
                    after_legacy = false;
                }
                _ => {}
            }
        }
        let extra = sub;
        let mut sub = 0u32;
        let mut after_legacy = false;
        for e in emit {
            if matches!(e, Emit::Legacy(_)) {
                after_legacy = true;
            } else if after_legacy {
                sub += 1;
                after_legacy = false;
            }
            let round = rounds[j] + sub;
            match e {
                Emit::Legacy(_) => {}
                Emit::Cell(c) => {
                    plan.taken.insert(c.key);
                    blur(&mut plan, c);
                    let (_, atlas_rect, frame_rect) = rects(c);
                    let ops = cell_units(c);
                    let g = by_round.entry((round, wv_composite_bits(&ops))).or_default();
                    g.0.push(
                        crate::vello::batch::Inst::new(
                            frame_rect, acc_size, atlas_rect, atlas_size, (0.0, 0.0), 0.0, false,
                        )
                        .with_units(g.1.len()),
                    );
                    g.1.push(wv_stamp_uniform(&ops));
                }
                Emit::Inner { flood, punch } => {
                    blur(&mut plan, flood);
                    blur(&mut plan, punch);
                    let (_, flood_rect, frame_rect) = rects(flood);
                    let (_, punch_rect, _) = rects(punch);
                    // Materialise the band in atlas A at the flood's own rect (both reads from B),
                    // then composite it from A — `mode` 1 selects the second texture. The two draws
                    // run different halves of the same chain: the erase materialises the band, the
                    // composite colours it, and each reads its parameters out of the flood's own
                    // uniform.
                    let ops = cell_units(flood);
                    plan.combine.push(
                        crate::vello::batch::Inst::new(
                            flood_rect, atlas_size, flood_rect, atlas_size, (0.0, 0.0), 0.0, false,
                        )
                        .with_src2(punch_rect, atlas_size, 0.0)
                        .with_units(plan.combine_f.len()),
                    );
                    plan.combine_f.push(wv_stamp_uniform(&ops));
                    plan.taken.insert(flood.key);
                    plan.taken.insert(punch.key);
                    let g = by_round.entry((round, wv_composite_bits(&ops))).or_default();
                    g.0.push(
                        crate::vello::batch::Inst::new(
                            frame_rect, acc_size, flood_rect, atlas_size, (0.0, 0.0), 0.0, false,
                        )
                        .with_src2(punch_rect, atlas_size, 1.0)
                        .with_units(g.1.len()),
                    );
                    g.1.push(wv_stamp_uniform(&ops));
                }
            }
        }
        if extra > 0 {
            plan.extra.insert(gid, extra);
        }
    }
    if plan.taken.is_empty() {
        return None;
    }
    {
        use crate::vello::batch::{stage, Stage, Surface};
        use crate::vello::plan::{atlases_needed, colour_stages, Input, StageSpec, Target, ValueId};
        // The surfaces are not chosen here. Each stage declares what it READS, and A3 — never write
        // an atlas you read in the same draw — decides where it writes. The ping-pong, and the fact
        // that the erase can land back in the first atlas, are consequences of that rule rather than
        // constants this function has to keep consistent with the executor.
        let spec = [
            StageSpec { reads: vec![Input::External(0)], target: Target::Atlas },
            StageSpec { reads: vec![Input::Value(ValueId(0))], target: Target::Atlas },
            StageSpec {
                reads: vec![Input::Value(ValueId(1)), Input::Value(ValueId(1))],
                target: Target::Atlas,
            },
            StageSpec {
                reads: vec![Input::Value(ValueId(1)), Input::Value(ValueId(2))],
                target: Target::Accumulator,
            },
        ];
        let colour = colour_stages(&spec);
        let at = |i: usize| Surface::Atlas(colour[i].expect("an atlas stage was coloured"));
        plan.atlases = atlases_needed(&colour);
        plan.stages
            .push(Stage::new(stage::BLUR, at(0), Surface::Acc, std::mem::take(&mut plan.h)).cleared());
        plan.stages
            .push(Stage::new(stage::BLUR, at(1), at(0), std::mem::take(&mut plan.v)).cleared());
        plan.stages.push(
            Stage::new(
                crate::vello::batch::arm_tag(crate::vello::batch::pw_key(crate::vello::batch::pointwise::ERASE)),
                at(2),
                at(1),
                std::mem::take(&mut plan.combine),
            )
            .with_fields(std::mem::take(&mut plan.combine_f)),
        );
        for ((r, bits), (insts, fields)) in by_round {
            plan.stages.push(
                Stage::new(crate::vello::batch::arm_tag(crate::vello::batch::pw_key(bits)), Surface::Acc, at(1), insts)
                    .with_src2(at(2))
                    .with_fields(fields)
                    .composited()
                    .with_round(r),
            );
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("WV_BATCH_STATS").is_ok() {
        eprintln!(
            "wv batch: cells={} declined={} split={} stages={} instances={}",
            plan.taken.len(),
            plan.legacy_sub.len(),
            plan.extra.len(),
            plan.stages.len(),
            plan.stages.iter().map(|s| s.insts.len()).sum::<usize>(),
        );
    }
    Some(plan)
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

/// Native A/B hook for the batched lens stages (default on): `WV_LENS=0` forces every lens back
/// through its own pass chain, which is how the batched output is pixel-compared against the
/// per-shape one. No browser gate — the batch is the production path.
fn wv_lens_batch() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_LENS").is_ok_and(|v| v != "0") || std::env::var("WV_LENS").is_err();
    }
    #[cfg(target_arch = "wasm32")]
    true
}

/// Linchpin A/B gate for effects-in-fine gathers (default OFF): `WV_GLASS_FINE=1` routes a SHARP
/// glass gather through `fine` — a WARP inline effect that samples the materialized backdrop
/// (`base_in`) at the lens field's displacement in a reload round — instead of the batched lens
/// stages. The batched path stays the oracle; this proves a barrier can ride `fine` at all.
fn wv_glass_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_GLASS_FINE").is_ok_and(|v| v == "1");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// Sibling of [`wv_glass_fine`] for a background BLUR: `WV_BLUR_FINE=1` routes it through fine as a
/// BLUR arm (a Gaussian tap loop over `base_in`) instead of the dedicated `blur_px` pipeline — testing
/// "the blur is just another fine arm" end to end.
fn wv_blur_fine() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_BLUR_FINE").is_ok_and(|v| v == "1");
    }
    #[cfg(target_arch = "wasm32")]
    false
}

/// The four surfaces the batched lens stages ping-pong through, all packed with the same cell
/// layout: `a` the cropped backdrops (kept — the mask-mix reads it as the original), `b` the warp
/// then the blurred warp, `d` the horizontal-blur scratch, `c` the finished lenses awaiting the
/// stamp. Held for the whole frame so every round reuses them.
struct WvLensAtlas {
    w: u32,
    h: u32,
    a_view: wgpu::TextureView,
    b_view: wgpu::TextureView,
    c_view: wgpu::TextureView,
    d_view: wgpu::TextureView,
    /// The **mask** atlas: every gather's silhouette rasterised once at device size, bound as the
    /// masked composite's second texture (`Surface::Atlas(4)`). `mw`/`mh` are its own dimensions
    /// (device-size cells, packed separately from the reduced effect cells), `0` when no gather rides
    /// this frame. Held with the rest for the whole round loop.
    mw: u32,
    mh: u32,
    m_view: wgpu::TextureView,
    /// The atlas textures themselves, returned to the pool once the last round has run.
    keep: Vec<wgpu::Texture>,
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
    /// punch for a spread, and [`GATHER_KIND`] for a gather (whose index disambiguates siblings).
    key: (u128, u8, usize),
    /// The round this cell composites in, assigned by [`wv_rounds`]. Set for a gather (the round loop
    /// filters on it); a spread's round is applied by [`wv_batch_plan`]/[`Sink::wv_paint_stack`] from
    /// the shared `rounds` array, so this stays `0` on a spread cell.
    round: u32,
    /// Device box, render scale `k`, device sigma and the `k < 1` sharp flag — the shared geometry.
    /// (`geom.sharp` is always `false` for a spread: a stamp never Catmull-Rom-upscales.)
    geom: CellGeom,
    /// This cell's effect, LOWERED once to runnable [`Pass`]es — the shared units-IR chain both the
    /// batch (`batch_admit`) and the per-shape executor (`wv_effect_blit`) consume. A self-clipping
    /// lens carries its lowered chain here too; the round re-derives its head + tail via
    /// [`batch_admit`] (no separate `warp`/`tail` fields). A plain blur/custom gather leaves this
    /// empty and re-derives from the node (`wv_gather_graph`).
    passes: std::rc::Rc<Vec<Pass>>,
    /// The straight RGBA tint a spread chain applies, pre-extracted when the cell is built.
    tint: Option<[f32; 4]>,
    /// Spread reduced surface size (its atlas slot is assigned by an external [`crate::atlas::Packing`]
    /// keyed on `key`). A gather leaves these `0` and carries its slot in `cell`/`red` instead.
    kw: u32,
    kh: u32,
    /// A gather's own atlas slot rect (`cell`) and the reduced sub-rect its warp/blur render into
    /// (`red`, nested inside `cell`). Both `(0,0,0,0)` on a spread.
    cell: (f32, f32, f32, f32),
    red: (f32, f32, f32, f32),
    /// How this cell's source pixels are obtained — the one spread/gather axis (see [`CellSource`]).
    source: CellSource,
    /// A custom-shader gather (a `Custom` head), run per-cell then joined to the shared masked
    /// composite. `false` for spreads, glass and blur gathers.
    custom: bool,
}

/// The one irreducible spread/gather axis: how a cell's source pixels are obtained. This is NOT
/// derivable from the effect chain, which is why it is a field. Everything else about a cell — glass
/// vs blur vs custom, tint, self-clip vs mask-composite — is read off the chain.
#[derive(Clone)]
enum CellSource {
    /// Spread: rasterise the shape's silhouette into the cell and run the chain over it. `offset` is
    /// the device translation the chain applies (a filter graph's `Offset`); `(0, 0)` for most.
    Silhouette { offset: (f32, f32) },
    /// Gather: crop the backdrop region out of the accumulator and run the chain over it. A chain with
    /// a sampling head (a lens) self-clips via its SDF (`mask: None`); a headless chain (blur/custom)
    /// composites through a rasterised silhouette placed at `mask` (the packer writes the rect;
    /// `None` until it does).
    Crop { mask: Option<(f32, f32, f32, f32)> },
}

/// The `key.1` a gather cell carries — distinct from the spread kinds `0..=3`.
const GATHER_KIND: u8 = 9;

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
    batch_pipes: Option<crate::vello::batch::BatchPipelines>,
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
}

impl Sink {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            unit_pipeline: UnitPipeline::new(device, format),
            batch_pipes: None,
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
        let rounds: Vec<u32> = rounds
            .iter()
            .zip(&blur_gather)
            .map(|(&r, &b)| if b { (2 * r).saturating_sub(1) } else { 2 * r })
            .collect();
        let mut max_round = rounds.iter().copied().max().unwrap_or(0);
        let batch_plan = strip.as_ref().and_then(|(packing, cells)| {
            wv_batch_plan(&gathers, &rounds, packing, cells, strip_y, (width as f32, acc_h as f32))
        });
        // A shape the batch had to split occupies rounds beyond its own, so the loop has to reach
        // them. Rounds with no draws open no fine segment, so the only cost is the split shape's
        // second composite.
        if let Some(plan) = batch_plan.as_ref() {
            for (j, (_, gid, _)) in gathers.iter().enumerate() {
                if let Some(extra) = plan.extra.get(gid) {
                    max_round = max_round.max(rounds[j] + extra);
                }
            }
        }
        // Effects-in-fine WARP gathers (linchpin, gated `WV_GLASS_FINE=1`): a sharp glass routed
        // through `fine` instead of the batched lens stages. Each needs a RELOAD round after its
        // backdrop materialises (so `base_in` holds it) — hence `max_round >= its round + 1` — and its
        // device-space lens uniform, keyed by gid. Excluded from `wv_lens_plan` below so it renders
        // once, and it forces the ping-pong path (`base_in` is unbound in the rw accumulator).
        let fx_fine: std::collections::HashMap<u128, Vec<[f32; 26]>> = if wv_glass_fine() || wv_blur_fine() {
            gathers
                .iter()
                .enumerate()
                .filter(|(_, g)| g.2 != FX_STACK)
                .filter_map(|(j, &(_, gid, _))| {
                    self.wv_fine_passes(gid, full_view, width, height).map(|passes| {
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
        let mut batch_rt: Option<(Vec<wgpu::Texture>, Vec<wgpu::TextureView>)> = None;
        let (lens_gathers, lens_rounds): (Vec<(usize, u128, u8)>, Vec<u32>) = gathers
            .iter()
            .zip(rounds.iter())
            .filter(|(g, _)| !fx_fine.contains_key(&g.1))
            .map(|(&g, &r)| (g, r))
            .unzip();
        let lens_plan = self
            .wv_lens_plan(&lens_gathers, &lens_rounds, full_view, width, height, device.limits().max_texture_dimension_2d)
            .filter(|_| wv_lens_batch());
        let (lens_cells, lens_atlas) = match lens_plan {
            Some((packing, cells, (mw, mh))) => {
                let _ = self
                    .batch_pipes
                    .get_or_insert_with(|| crate::vello::batch::BatchPipelines::new(device, format));
                let (aw, ah) = (packing.width, packing.height);
                let mut mk = |label| self.pool.acquire_target(device, aw, ah, format, wgpu::TextureUsages::empty(), label);
                let (a, b, c, d) = (mk("wv lens a"), mk("wv lens b"), mk("wv lens c"), mk("wv lens d"));
                let vd = wgpu::TextureViewDescriptor::default();
                // The mask atlas: every gather silhouette rasterised once at device size into one
                // texture, at each gather cell's packed mask rect. Bound as the masked composite's
                // second texture. Allocated 1x1 when no gather rides this frame (still a valid bind).
                let (mtw, mth) = (mw.max(1), mh.max(1));
                let mask_tex = self.pool.acquire_target(device, mtw, mth, format, self.raster_usage, "wv lens mask");
                let m_view = mask_tex.create_view(&vd);
                if mw > 0 {
                    let masks = cells.iter().filter(|c| c.passes.first().and_then(units_head).is_none()).filter_map(|gc| {
                        match &gc.source {
                            CellSource::Crop { mask: Some((mx, my, _, _)) } => {
                                let m = Affine::translate((
                                    f64::from(*mx) - f64::from(gc.geom.dev.0),
                                    f64::from(*my) - f64::from(gc.geom.dev.1),
                                )) * root;
                                Some((gc.key.0, m))
                            }
                            _ => None,
                        }
                    });
                    rasterize_masks(backend, device, queue, &mut enc, &m_view, mtw, mth, TRANSPARENT, masks);
                }
                let atlas = WvLensAtlas {
                    w: aw,
                    h: ah,
                    a_view: a.create_view(&vd),
                    b_view: b.create_view(&vd),
                    c_view: c.create_view(&vd),
                    d_view: d.create_view(&vd),
                    mw: mtw,
                    mh: mth,
                    m_view,
                    keep: vec![a, b, c, d, mask_tex],
                };
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_LENS_STATS").is_ok() {
                    let sharp = cells.iter().filter(|c| c.geom.sigma <= 0.0).count();
                    eprintln!(
                        "wv lens batch: {} lenses ({sharp} sharp, {} frosted) in {} rounds, atlas {aw}x{ah}",
                        cells.len(),
                        cells.len() - sharp,
                        cells.iter().map(|c| c.round).collect::<std::collections::BTreeSet<_>>().len()
                    );
                }
                (Some(cells), Some(atlas))
            }
            None => (None, None),
        };

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
        for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
            if kind == FX_STACK {
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
                    // A separable blur is two markers (H then V). The H pass writes the draft and must
                    // cover the REACH so the V pass's taps land on H-blurred pixels; the V pass keeps
                    // the silhouette for its masked composite.
                    let is_blur = markers.len() == 2;
                    for (mi, &(mround, moff)) in markers.iter().enumerate() {
                        z += 1;
                        let eid = if is_blur && mi == 0 { FX_TINT_DILATED_ID } else { FX_TINT_ID };
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
            && fx_fine.is_empty();
        let n_slots: usize = if rw { 1 } else { 2 };
        let texs: Vec<wgpu::Texture> = (0..n_slots)
            .map(|_| self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv phase"))
            .collect();
        let views: Vec<wgpu::TextureView> =
            texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();

        // A separable blur is TWO fine markers (H then V) at consecutive rounds. The H pass writes its
        // UNMASKED result to this draft (a scratch surface, not the accumulator) so the V pass can
        // sample the full blurred field while `base_in` still holds the original backdrop — the mask
        // then applies exactly once, at V. `blur_round_role` names, per round, whether that round's
        // window is a blur's H pass (draft is its `out`) or V pass (draft is its extra input). Only the
        // ping-pong path carries base_in, so blurs already force it off the rw accumulator (fx_fine).
        let mut blur_round_role: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
        for (j, &(_, gid, _)) in gathers.iter().enumerate() {
            if let Some(passes) = fx_fine.get(&gid) {
                if passes.len() == 2 && (passes[0][0] as u32) & 64u32 != 0 {
                    blur_round_role.insert(rounds[j], false); // H
                    blur_round_role.insert(rounds[j] + 1, true); // V
                }
            }
        }
        // A FRESH draft per blur-H round, not one reused texture: the engine orders cross-dispatch
        // reads/writes of an EXTERNAL texture the way the accumulator ping-pong does — by alternating
        // surfaces. One draft written (H), read (V), written (next H), read (next V) is a same-texture
        // hazard the tracking misses, and the second V reads the first H's stale content (its blur
        // never took → the checker's vertical bands survive). Keyed by the H round; the V round looks
        // its H up at `round - 1`. Held for the whole loop, released to the frame-transient list after.
        let mut draft_texs: Vec<wgpu::Texture> = Vec::new();
        let mut draft_views: std::collections::HashMap<u32, wgpu::TextureView> = std::collections::HashMap::new();

        for (_, (tex, _)) in std::mem::take(&mut self.wv_atlas) {
            self.pool.release(tex);
        }
        if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
            Self::submit_batch(&mut enc, device, queue, backend);
            flush_mark = passes_recorded();
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
                (in_window && draws_after(j) > 0) || fine_here
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
                if rw {
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
                } else if let Some(&is_v) = blur_round_role.get(&window_lo) {
                    // A separable blur window. H: read the accumulator (backdrop), write a fresh draft,
                    // and DON'T advance the ping-pong — the accumulator still holds the original
                    // backdrop the V pass needs for its margin. V: read that backdrop as base_in AND the
                    // draft its H wrote (keyed at `round - 1`) as the blur source, composite masked.
                    let c = cur.expect("a blur has a backdrop to read");
                    if is_v {
                        let out = 1 - c;
                        let dv = draft_views.get(&(window_lo - 1)).expect("blur V after its H");
                        backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, r, &views[c], dv, &views[out]);
                        cur = Some(out);
                    } else {
                        let dt = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv blur draft");
                        let dv = dt.create_view(&wgpu::TextureViewDescriptor::default());
                        backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, Some(&views[c]), &dv);
                        draft_views.insert(window_lo, dv);
                        draft_texs.push(dt);
                    }
                } else {
                    let out = cur.map_or(0, |c| 1 - c);
                    let base = cur.map(|c| &views[c]);
                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, r, base, &views[out]);
                    cur = Some(out);
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
                self.wv_atlas_copy_out(
                    device, &mut enc, &texs[ci], packing, cells, 0, strip_y, format,
                    batch_plan.as_ref().map(|p| &p.taken),
                );
                // Batched shapes never materialise per-cell textures at all: TWO instanced passes
                // blur every batched cell in place in a packed pair of atlas surfaces, and the
                // per-round composite draws straight from the second. Stage count is constant in
                // the number of shapes.
                if let Some(plan) = batch_plan.as_ref() {
                    let (aw, ah) = (packing.width, packing.height);
                    let pipes = self
                        .batch_pipes
                        .get_or_insert_with(|| crate::vello::batch::BatchPipelines::new(device, format));
                    let texs: Vec<wgpu::Texture> = (0..plan.atlases)
                        .map(|_| {
                            self.pool.acquire_target(
                                device,
                                aw,
                                ah,
                                format,
                                wgpu::TextureUsages::empty(),
                                "wv batch atlas",
                            )
                        })
                        .collect();
                    let atlas_views: Vec<wgpu::TextureView> =
                        texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();
                    let refs: Vec<&wgpu::TextureView> = atlas_views.iter().collect();
                    pipes.run_stages(device, &mut enc, &plan.stages, None, &views[ci], &refs, self.compositor.sampler());
                    // Held OUTSIDE `frame_transient` on purpose: the per-node recycle point
                    // truncates that list back to its pre-loop checkpoint, and the blurred atlas
                    // must survive every round. It returns to the pool after the final window.
                    batch_rt = Some((texs, atlas_views));
                }
                strip_filled = true;
            }
            if let (Some(plan), Some((_, atlas_views))) = (batch_plan.as_ref(), batch_rt.as_ref()) {
                let pipes = self.batch_pipes.as_ref().expect("batch pipelines built with the plan");
                let refs: Vec<&wgpu::TextureView> = atlas_views.iter().collect();
                pipes.run_stages(device, &mut enc, &plan.stages, Some(r), &views[ci], &refs, self.compositor.sampler());
            }
            // Every batched lens of this round, in one pass per stage. Lenses in a round are
            // disjoint by construction, so they can all read the accumulator and write their own
            // crops concurrently — the per-shape chain is what forced them apart before.
            if let (Some(cells), Some(atlas)) = (lens_cells.as_ref(), lens_atlas.as_ref()) {
                self.wv_lens_round(device, &mut enc, &views[ci], atlas, cells, r, format, acc_sz, full_view);
            }
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                let extra = batch_plan.as_ref().and_then(|p| p.extra.get(&gid).copied()).unwrap_or(0);
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
                let claim = batch_plan.as_ref().map(|p| (&p.taken, &p.legacy_sub));
                match kind {
                    FX_STACK => self.wv_paint_stack(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, gi, width, height, format, acc_sz, claim, sub),
                    _ if sub > 0 => {}
                    // An inline effect ran in fine at its CMD_EFFECT marker(s); no post-fine pass. Pointwise
                    // (tint/field) rides fx_offset; a fine gather (glass/blur) rides fx_markers.
                    _ if fx_offset.contains_key(&gid) || fx_markers.contains_key(&gid) => {}
                    _ if lens_cells.as_ref().is_some_and(|cs| cs.iter().any(|c| c.key.0 == gid)) => {}
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
        if let Some((texs, atlas_views)) = batch_rt.take() {
            self.frame_transient.extend(texs);
            self.frame_transient_views.extend(atlas_views);
        }
        // The blur drafts lived across the whole round loop (like the batch atlases); hand them to the
        // frame-transient list so they return to the pool after the frame, not at a per-node recycle.
        self.frame_transient.extend(draft_texs);
        self.frame_transient_views.extend(draft_views.into_values());
        // Same rule as the batch atlases: held outside `frame_transient` for the whole round loop
        // (the per-node recycle point truncates that list), returned to the pool once it ends.
        if let Some(atlas) = lens_atlas {
            self.frame_transient.extend(atlas.keep);
            self.frame_transient_views.push(atlas.a_view);
            self.frame_transient_views.push(atlas.b_view);
            self.frame_transient_views.push(atlas.c_view);
            self.frame_transient_views.push(atlas.d_view);
            self.frame_transient_views.push(atlas.m_view);
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

    /// Plan the frame's batched lens: every scoped lens whose graph the instanced stages can express
    /// ([`wv_lens_admit`]), packed into one atlas whose cells are grouped by round. Lenses sharing a
    /// round never overlap (that is what [`wv_rounds`] guarantees), so a round's cells can all run in
    /// one pass per stage. `None` when fewer than two lenses qualify — one lens costs the same either
    /// way and only adds a pack.
    fn wv_lens_plan(
        &self,
        gathers: &[(usize, u128, u8)],
        rounds: &[u32],
        full_view: Affine,
        width: u32,
        height: u32,
        max_dim: u32,
    ) -> Option<(crate::atlas::Packing, Vec<Cell>, (u32, u32))> {
        if !crate::vello::abi::wv_scope() {
            return None;
        }
        let mut cells: Vec<Cell> = Vec::new();
        for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
            if kind == FX_STACK {
                continue;
            }
            if !Self::wv_gather_self_clips(gid) {
                continue;
            }
            let Some((bx, by, bw, bh, k)) = self.wv_lens_box(gid, full_view, width, height) else {
                continue;
            };
            // Render the lens at its reduced size (kw×kh) and, for k<1, Catmull-Rom-upscale it at the
            // stamp (stage::SHARP) — the batched twin of the per-shape reduced render + blit_sharp.
            // k>=1 gives kw=bw, so the native path lowers and packs exactly as before. The whole-cell
            // k is threaded into lens_graph the same way wv_gather_graph does per-shape, so the two
            // routes build byte-identical geometry.
            let (kw, kh) = (
                crate::effect_graph::pass_dim(bw, k as f32),
                crate::effect_graph::pass_dim(bh, k as f32),
            );
            if kw > max_dim || kh > max_dim {
                continue;
            }
            let Some(passes) = self.lens_graph(gid, kw, kh, f64::from(bx), f64::from(by), full_view, k) else {
                continue;
            };
            let Some(BatchShape::Lens { sigma, .. }) = batch_admit(&passes) else {
                continue;
            };
            let red_scale = if sigma > 0.0 { passes[0].scale } else { 1.0 };
            let (rw, rh) = (
                crate::effect_graph::pass_dim(kw, red_scale),
                crate::effect_graph::pass_dim(kh, red_scale),
            );
            cells.push(Cell {
                key: (gid, GATHER_KIND, j),
                round: rounds[j],
                geom: CellGeom {
                    dev: (bx as f32, by as f32, bw as f32, bh as f32),
                    k: k as f32,
                    sigma,
                    sharp: k < 0.999,
                },
                passes: std::rc::Rc::new(passes),
                tint: None,
                kw: 0,
                kh: 0,
                cell: (0.0, 0.0, kw as f32, kh as f32),
                red: (0.0, 0.0, rw as f32, rh as f32),
                source: CellSource::Crop { mask: None },
                custom: false,
            });
        }
        // Non-self-clipping BACKDROP gathers — background blurs — batch through the same round: crop
        // the accumulator, blur separably, composite THROUGH a silhouette mask (the batched twin of
        // the per-shape `blit_masked`). Custom-shader gathers are S3; only blur heads admit here. Each
        // gather cell rides two atlases — the effect atlas (reduced, its crop/blur) and the mask atlas
        // (device size, its silhouette) — so its mask size is collected for a second packing.
        let mut mask_sizes: Vec<(u32, u32)> = Vec::new();
        let mut gather_marks: Vec<usize> = Vec::new();
        for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
            if kind == FX_STACK || Self::wv_gather_self_clips(gid) {
                continue;
            }
            // The head decides the fill: a `Blur` head rides the instanced `blur_px`; a `Shader` head
            // is a custom gather, run per-cell (its user pipeline samples its whole input). Both then
            // composite through the mask atlas — the shared masked composite.
            let custom = match Self::wv_backdrop_effect(gid).as_ref().map(|e| e.ops.first()) {
                Some(Some(crate::effect::Op::Blur { .. })) => false,
                Some(Some(crate::effect::Op::Shader(_))) => true,
                _ => continue,
            };
            let Some((bx, by, bw, bh, k)) = self.wv_gather_box(gid, full_view, width, height) else {
                continue;
            };
            let (kw, kh) = (
                crate::effect_graph::pass_dim(bw, k as f32),
                crate::effect_graph::pass_dim(bh, k as f32),
            );
            if kw > max_dim || kh > max_dim || bw > max_dim || bh > max_dim {
                continue;
            }
            let sigma = if custom { 0.0 } else { self.gather_sigma(gid, full_view, k) };
            cells.push(Cell {
                key: (gid, GATHER_KIND, j),
                round: rounds[j],
                geom: CellGeom {
                    dev: (bx as f32, by as f32, bw as f32, bh as f32),
                    k: k as f32,
                    sigma,
                    sharp: k < 0.999,
                },
                passes: std::rc::Rc::new(Vec::new()),
                tint: None,
                kw: 0,
                kh: 0,
                cell: (0.0, 0.0, kw as f32, kh as f32),
                red: (0.0, 0.0, kw as f32, kh as f32),
                source: CellSource::Crop { mask: Some((0.0, 0.0, bw as f32, bh as f32)) },
                custom,
            });
            mask_sizes.push((bw, bh));
            gather_marks.push(cells.len() - 1);
        }
        if cells.len() < 2 {
            return None;
        }
        let sizes: Vec<(u32, u32)> = cells.iter().map(|c| (c.cell.2 as u32, c.cell.3 as u32)).collect();
        let packing = crate::atlas::shelf_pack(&sizes, 4, max_dim.min(4096), max_dim)?;
        for (c, pl) in cells.iter_mut().zip(&packing.cells) {
            c.cell.0 = pl.x as f32;
            c.cell.1 = pl.y as f32;
            c.red.0 = pl.x as f32;
            c.red.1 = pl.y as f32;
        }
        // Second packing: the gather silhouettes, at device size, into the mask atlas. Its rects are
        // written back onto each gather cell so the round's masked composite reads `tex2` at them.
        let (mw, mh) = if mask_sizes.is_empty() {
            (0, 0)
        } else {
            let mpack = crate::atlas::shelf_pack(&mask_sizes, 4, max_dim.min(4096), max_dim)?;
            for (&ci, pl) in gather_marks.iter().zip(&mpack.cells) {
                let (mw2, mh2) = match &cells[ci].source {
                    CellSource::Crop { mask: Some((_, _, w, h)) } => (*w, *h),
                    _ => unreachable!("a gather mark points at a Crop cell with a mask"),
                };
                cells[ci].source = CellSource::Crop { mask: Some((pl.x as f32, pl.y as f32, mw2, mh2)) };
            }
            (mpack.width, mpack.height)
        };
        Some((packing, cells, (mw, mh)))
    }

    /// The device box and render scale one scoped lens reads and writes — the same derivation
    /// [`Self::wv_stamp_gather_scoped`] does, factored out so the batch planner and the per-shape
    /// path can never disagree about a lens's geometry.
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

    /// Run every batched lens of ONE round: crop each lens's backdrop out of the accumulator, run the
    /// unit stages over all of them at once — one pass per stage, not per lens — and composite the
    /// results back. A round's lenses are disjoint, so the whole round is at most six passes
    /// regardless of how many lenses it holds (crop, sharp, warp, blur H, blur V, frost, stamp).
    #[expect(clippy::too_many_arguments, reason = "the GPU context + atlas set travel together")]
    fn wv_lens_round(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        atlas: &WvLensAtlas,
        cells: &[Cell],
        round: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
        full_view: Affine,
    ) {
        use crate::vello::batch::{stage, FieldUniform, Inst};
        if self.batch_pipes.is_none() {
            return;
        }
        let here: Vec<&Cell> = cells.iter().filter(|c| c.round == round).collect();
        if here.is_empty() {
            return;
        }
        let asz = (atlas.w as f32, atlas.h as f32);

        let mut crops: Vec<Inst> = Vec::with_capacity(here.len());
        let (mut sharp, mut sharp_f) = (Vec::new(), Vec::new());
        let (mut warp, mut warp_f) = (Vec::new(), Vec::new());
        let (mut blur_h, mut blur_v) = (Vec::new(), Vec::new());
        let (mut frost, mut frost_f) = (Vec::new(), Vec::new());
        let mut stamp: Vec<Inst> = Vec::with_capacity(here.len());
        // The k<1 cells' stamps, which Catmull-Rom-upscale their reduced cell (stage::SHARP) instead
        // of the plain `Tint` copy — a native cell must NOT take this path, as SHARP's sharpen term
        // would alter an un-scaled cell.
        let mut sharp_stamp: Vec<Inst> = Vec::new();
        // A lens result is already coloured, so its stamp runs the `Tint` arm with the disabling
        // sentinel. Every stamp shares the one entry, which is the index an instance carries by
        // default.
        let mut no_tint = [0.0_f32; 24];
        no_tint[15] = -1.0;
        // A plain gather (no head): its crop is blurred separably and composited THROUGH its mask.
        // Reuses slots C/D — free once every glass composite above has read them — so a round of
        // gathers needs no surfaces of its own.
        let masz = (atlas.mw as f32, atlas.mh as f32);
        let (mut gblur_h, mut gblur_v): (Vec<Inst>, Vec<Inst>) = (Vec::new(), Vec::new());
        let (mut gmasked, mut gsharp_masked): (Vec<Inst>, Vec<Inst>) = (Vec::new(), Vec::new());
        // Custom gathers fill the effect atlas per-cell (their user pipeline samples its whole input),
        // then join the batched masked composite below via the same D→acc instances.
        let mut customs: Vec<&Cell> = Vec::new();
        for c in &here {
            crops.push(Inst::new(c.cell, asz, c.geom.dev, sz, (0.0, 0.0), 0.0, false));
            let lens = match batch_admit(&c.passes) {
                Some(BatchShape::Lens { head, tail, .. }) => Some((head, tail)),
                _ => None,
            };
            let Some((warp_op, tail)) = lens else {
                if c.custom {
                    customs.push(*c);
                } else {
                    gblur_h.push(Inst::new(c.cell, asz, c.cell, asz, (1.0, 0.0), c.geom.sigma, true));
                    gblur_v.push(Inst::new(c.cell, asz, c.cell, asz, (0.0, 1.0), c.geom.sigma, true));
                }
                let mask_rect = match &c.source {
                    CellSource::Crop { mask: Some(m) } => *m,
                    _ => unreachable!("a masked gather cell carries a Crop mask rect"),
                };
                let stamp_inst = Inst::new(c.geom.dev, sz, c.cell, asz, (0.0, 0.0), 0.0, false)
                    .with_src2(mask_rect, masz, 0.0);
                if c.geom.sharp {
                    gsharp_masked.push(stamp_inst);
                } else {
                    gmasked.push(stamp_inst);
                }
                continue;
            };
            let mut ops = vec![warp_op];
            if c.geom.sigma <= 0.0 {
                ops.extend(tail.iter().cloned());
                sharp.push(
                    Inst::new(c.cell, asz, c.cell, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, 0.0)
                        .with_units(sharp_f.len())
                        .at(c.cell),
                );
                sharp_f.push(FieldUniform { u: crate::vello::units::units_uniform(&ops) });
            } else {
                warp.push(
                    Inst::new(c.red, asz, c.cell, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, 0.0)
                        .with_units(warp_f.len())
                        .at(c.red),
                );
                warp_f.push(FieldUniform { u: crate::vello::units::units_uniform(&ops) });
                blur_h.push(Inst::new(c.red, asz, c.red, asz, (1.0, 0.0), c.geom.sigma, false));
                blur_v.push(Inst::new(c.red, asz, c.red, asz, (0.0, 1.0), c.geom.sigma, false));
                frost.push(
                    Inst::new(c.cell, asz, c.red, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, 0.0)
                        .with_units(frost_f.len())
                        .at(c.cell),
                );
                frost_f.push(FieldUniform { u: crate::vello::units::units_uniform(&tail) });
            }
            let stamp_inst = Inst::new(c.geom.dev, sz, c.cell, asz, (0.0, 0.0), 0.0, false);
            if c.geom.sharp {
                sharp_stamp.push(stamp_inst);
            } else {
                stamp.push(stamp_inst);
            }
        }

        // The round's whole schedule, in dependency order — the crop lifts every lens's backdrop
        // into slot A, the unit stages run over all of them, and the stamp puts them back. Emitting
        // stages rather than issuing passes is what makes this a plan the executor runs, identical
        // in kind to the blur-cell plan above.
        use crate::vello::batch::{Stage, Surface};
        const A: Surface = Surface::Atlas(0);
        const B: Surface = Surface::Atlas(1);
        const C: Surface = Surface::Atlas(2);
        const D: Surface = Surface::Atlas(3);
        const M: Surface = Surface::Atlas(4);
        let mut stages = vec![
            Stage::new(stage::BLUR, A, Surface::Acc, crops).cleared(),
            Stage::new(crate::vello::batch::arm_tag(crate::vello::units::UnitKey { head: 1, shade: true, maskmix: true, ..Default::default() }), C, A, sharp).with_fields(sharp_f),
            Stage::new(crate::vello::batch::arm_tag(crate::vello::units::UnitKey { head: 1, ..Default::default() }), B, A, warp).with_fields(warp_f),
            Stage::new(stage::BLUR, D, B, blur_h).cleared(),
            Stage::new(stage::BLUR, B, D, blur_v).cleared(),
            Stage::new(crate::vello::batch::arm_tag(crate::vello::units::UnitKey { head: 2, shade: true, maskmix: true, two_tex: true, ..Default::default() }), C, B, frost).with_src2(A).with_fields(frost_f),
            Stage::new(
                crate::vello::batch::arm_tag(crate::vello::batch::pw_key(crate::vello::batch::pointwise::TINT)),
                Surface::Acc,
                C,
                stamp,
            )
            .with_fields(vec![FieldUniform { u: no_tint }])
            .composited(),
        ];
        // k<1 cells composite through the Catmull-Rom SHARP arm instead of the plain Tint copy — the
        // batched twin of blit_sharp. A separate stage because it is a different arm; it reads the
        // same finished-lens atlas (C) and upscales each reduced cell to its device box.
        if !sharp_stamp.is_empty() {
            stages.push(Stage::new(stage::SHARP, Surface::Acc, C, sharp_stamp).composited());
        }
        // Blur gathers fill D separably (crop A → blur H C → blur V D). Custom gathers fill their own
        // D cells per-cell BELOW (their user pipeline can't share the atlas crop). Both then flow
        // through ONE masked composite reading D, split by k into MASKED / SHARP_MASKED.
        if !gblur_h.is_empty() {
            stages.push(Stage::new(stage::BLUR, C, A, gblur_h).cleared());
            stages.push(Stage::new(stage::BLUR, D, C, gblur_v).cleared());
        }
        // FILL pass — the blur-gather stages + everything glass, run before the per-cell customs so
        // their D cells are not clobbered by the (cleared) blur-V stage.
        {
            let pipes = self.batch_pipes.as_ref().expect("batch pipelines present");
            let sampler = self.compositor.sampler();
            let views = [&atlas.a_view, &atlas.b_view, &atlas.c_view, &atlas.d_view, &atlas.m_view];
            for st in &stages {
                pipes.run_stage(device, enc, st, acc_view, &views, sampler);
            }
        }
        // Each custom gather: crop its backdrop box, run its user pipeline over it (per-cell — the
        // shader samples its whole input), and blit the result into this cell's D slot, where the
        // shared masked composite picks it up exactly like a blurred one.
        for cc in &customs {
            let (kw, kh) = (cc.cell.2 as u32, cc.cell.3 as u32);
            let input = self.pool.acquire_target(
                device, kw, kh, format,
                self.raster_usage | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv gather custom input",
            );
            let input_view = input.create_view(&wgpu::TextureViewDescriptor::default());
            self.compositor.blit(device, enc, &input_view, (kw as f32, kh as f32), &Blit {
                src: acc_view, dst: (0.0, 0.0, kw as f32, kh as f32), src_rect: cc.geom.dev, src_size: sz, alpha: 1.0,
            });
            let passes = self.wv_gather_graph(
                cc.key.0, kw, kh, f64::from(cc.geom.dev.0), f64::from(cc.geom.dev.1), full_view, f64::from(cc.geom.k), device, format,
            );
            let Some(passes) = passes else { continue };
            let Some((rtex, rview)) = self.wv_run_chain(device, enc, &[&input_view], &passes, kw, kh, format) else {
                continue;
            };
            self.compositor.blit(device, enc, &atlas.d_view, asz, &Blit {
                src: &rview, dst: (cc.cell.0, cc.cell.1, kw as f32, kh as f32),
                src_rect: (0.0, 0.0, kw as f32, kh as f32), src_size: (kw as f32, kh as f32), alpha: 1.0,
            });
            self.frame_transient.push(input);
            self.frame_transient_views.push(input_view);
            self.frame_transient.push(rtex);
            self.frame_transient_views.push(rview);
        }
        // COMPOSITE pass — every gather (blur + custom) reads its finished D cell and composites
        // through the mask atlas. `MASKED` at native scale, `SHARP_MASKED` for k<1.
        if !gmasked.is_empty() || !gsharp_masked.is_empty() {
            let mut comp: Vec<Stage> = Vec::new();
            if !gmasked.is_empty() {
                comp.push(Stage::new(stage::MASKED, Surface::Acc, D, gmasked).with_src2(M).composited());
            }
            if !gsharp_masked.is_empty() {
                comp.push(Stage::new(stage::SHARP_MASKED, Surface::Acc, D, gsharp_masked).with_src2(M).composited());
            }
            let pipes = self.batch_pipes.as_ref().expect("batch pipelines present");
            let sampler = self.compositor.sampler();
            let views = [&atlas.a_view, &atlas.b_view, &atlas.c_view, &atlas.d_view, &atlas.m_view];
            for st in &comp {
                pipes.run_stage(device, enc, st, acc_view, &views, sampler);
            }
        }
        let _ = format;
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
                    round: 0,
                    geom: CellGeom { dev: (bx as f32, by as f32, bw as f32, bh as f32), k, sigma, sharp: false },
                    passes: std::rc::Rc::new(lower_graph(&graph, None)),
                    tint: graph_tint(&graph),
                    kw, kh,
                    cell: (0.0, 0.0, 0.0, 0.0),
                    red: (0.0, 0.0, 0.0, 0.0),
                    source: CellSource::Silhouette { offset: dev_offset },
                    custom: false,
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
                    round: 0,
                    geom: CellGeom { dev: (bx as f32, by as f32, bw as f32, bh as f32), k, sigma: 0.0, sharp: false },
                    passes: std::rc::Rc::new(Vec::new()),
                    tint: None,
                    kw, kh,
                    cell: (0.0, 0.0, 0.0, 0.0),
                    red: (0.0, 0.0, 0.0, 0.0),
                    source: CellSource::Silhouette { offset: (0.0, 0.0) },
                    custom: false,
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
            CellSource::Crop { .. } => (0.0, 0.0),
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
            CellSource::Crop { .. } => (0.0, 0.0),
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
        let punch_view = self.wv_cell_source(&punch, backend, device, queue, enc, root, 0, format);
        // The band: the flood silhouette coloured, with its offset+blurred punch erased out. The
        // punch is a second input, blurred only when the erase declares a radius.
        let (w, h, sig) = (flood.kw as f32, flood.kh as f32, flood.geom.sigma * flood.geom.k);
        use crate::effect_graph::{tint_unit, unit_pass, EffectPass, GraphPass, Src, UnitKind};
        let mut graph = Vec::new();
        let punch = if sig > 0.5 {
            graph.push(GraphPass::new(EffectPass::Blur { sigma: sig, linear: true }, vec![Src::Input(1)]));
            Src::Pass(0)
        } else {
            Src::Input(1)
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
        let mine = |key: &(u128, u8, usize)| match claim {
            Some((taken, legacy)) => !taken.contains(key) && legacy.get(key).copied().unwrap_or(0) == sub,
            None => sub == 0,
        };
        let find = |kind: u8, idx: usize| {
            cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).cloned().filter(|c| mine(&c.key))
        };
        // The inner shadow's punch is an INPUT to the flood's chain, never composited on its own, so
        // it is not claimed and not assigned a round — the flood's verdict covers both. Filtering it
        // like a composite would lose it whenever the flood moved to a later round.
        let source = |kind: u8, idx: usize| {
            cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).cloned()
        };

        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut body_done = false;
        for effect in &stack {
            match (&effect.source, effect.compose) {
                (Source::Coverage { .. }, Compose::Under) => {
                    if let Some(c) = find(0, drop_i) {
                        self.wv_paint_path_shadow(c, backend, device, queue, enc, acc_view, root, format, sz);
                    }
                    drop_i += 1;
                }
                (Source::Backdrop, _) => {
                    if sub == 0 {
                        self.wv_stamp_gather(backend, device, queue, enc, acc_view, root, full_view, id, width, height, format, sz);
                    }
                }
                (Source::Body, _) => {
                    if let Some(c) = find(1, 0) {
                        self.wv_composite_body(c, backend, device, queue, enc, acc_view, root, root_index, format, sz);
                    }
                    body_done = true;
                }
                (Source::Coverage { .. }, Compose::Over) => {
                    if !body_done {
                        if let Some(c) = find(1, 0) {
                            self.wv_composite_body(c, backend, device, queue, enc, acc_view, root, root_index, format, sz);
                        }
                        body_done = true;
                    }
                    if let (Some(flood), Some(punch)) = (find(2, inner_i), source(3, inner_i)) {
                        self.wv_paint_inner_shadow(flood, punch, backend, device, queue, enc, acc_view, root, format, sz);
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        if !body_done {
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
    fn lens_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, geom) = crate::vello::abi::with_scene(|live, _, modifiers| {
            live.get(id).and_then(|n| {
                n.glass.map(|g| {
                    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let page = crate::schedule::page_bounds(n, m);
                    let [a, b, c, d, _, _] = (m * n.effective_transform()).as_coeffs();
                    let scale = ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0;
                    let geom = LensGeometry {
                        center: page.center(),
                        width: page.width(),
                        height: page.height(),
                        corner_radius: n.corners.map_or(0.0, |r| r.top_left) * scale,
                        is_circle: n.kind == crate::model::ShapeKind::Circle,
                    };
                    (g, geom)
                })
            })
        })?;
        let graph = effect_graph::lens_graph_scaled(&g, geom, (bw, bh), (bdx, bdy), full_view, k);
        Some(lower_graph(&graph, None))
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

    /// The effects-in-fine PASSES for a gather that rides fine, each a full 26-float descriptor
    /// `[bits, program, 6×vec4 u]`; `None` if it does not ride fine. One pass per marker the planner
    /// emits, in round order: a sharp glass → one WARP|SHADE|MASKMIX pass over the lens field (program
    /// 1); a background blur → two BLUR passes, H then V, each carrying its axis in `u[0].xy` (the
    /// separable blur, one marker each). Gated per kind by `WV_GLASS_FINE` / `WV_BLUR_FINE`.
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

    /// The tail reaches the composite through admission, so a unit's parameters cannot be read one
    /// way by the batch and another way by the fallback.
    #[test]
    fn a_stamp_carries_its_units_out_of_admission() {
        let Some(BatchShape::Stamp { ops, sigma, .. }) = admit(&drop_shadow_graph(64.0, 64.0, C, 4.0))
        else {
            panic!("a drop shadow is a stamp")
        };
        let u = super::wv_stamp_uniform(&ops);
        assert_eq!(&u.u[12..16], &C, "the tint's colour survives into the uniform the batch binds");
        assert!(sigma > 0.0, "a blurred drop shadow keeps its sigma");
    }

    /// An empty chain is still a stamp — the cell rides the blur stages as a sigma-0 copy so every
    /// batched cell lands in the surface the later stages sample — and its uniform disables the
    /// tint rather than zeroing it, or the body would be multiplied away.
    #[test]
    fn an_empty_chain_is_an_untinted_stamp() {
        assert_eq!(admit(&[]), Some(BatchShape::Stamp { sigma: 0.0, linear: false, ops: Vec::new() }));
        assert!(super::wv_stamp_uniform(&[]).u[15] < 0.0);
    }

    /// The tail is not a list of names. A pointwise unit no chain builds today still admits, and
    /// its composition selects an arm that exists — which is what stops the shader's arm set and
    /// the admission rule from drifting apart.
    #[test]
    fn a_pointwise_unit_no_builder_emits_still_admits() {
        use crate::vello::units::UnitOp;
        let clip = crate::vello::graph::Pass {
            units: vec![UnitOp::ClipToSource(vec![0.0; 24])],
            field: Some(std::rc::Rc::new(crate::field::FieldProgram { nodes: Vec::new(), outputs: Vec::new() })),
            custom: None,
            inputs: vec![crate::effect_graph::Src::Input(0)],
            scale: 1.0,
        };
        let Some(BatchShape::Stamp { ops, .. }) = batch_admit(&[clip]) else {
            panic!("a pointwise unit is a stamp")
        };
        let bits = super::wv_composite_bits(&ops);
        assert!(bits & crate::vello::batch::pointwise::CLIP != 0);
        assert!(bits < crate::vello::batch::pointwise::COUNT, "the arm the bits select is generated");
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
