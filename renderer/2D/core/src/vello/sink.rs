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
use crate::vello::glass::GlassPipeline;
use crate::effect_graph::{self, GlassGeometry};

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
    /// The frame's stages in dependency order — the blur pair and the combine hoisted out of the
    /// round loop, one composite pinned to each round that has work. Atlas slot 0 is the first
    /// surface of the pooled pair, slot 1 the second.
    stages: Vec<crate::vello::batch::Stage>,
    gids: HashSet<u128>,
}

/// The straight RGBA of one of a shape's shadows, `None` when the index no longer resolves. The
/// silhouette is rasterised as bare coverage, so this colour is what the Tint applies — the whole
/// reason a shape's shadows can share one rasterisation.
fn shadow_colour(id: u128, inset: bool, idx: usize) -> Option<[f32; 4]> {
    crate::vello::abi::with_scene(|model, _, _| {
        model
            .get(id)
            .and_then(|n| n.shadows.iter().filter(|s| s.inset == inset).nth(idx))
            .map(|s| s.color.components)
    })
}

/// Lower one batched cell to its effect graph — THE SAME builder call the per-shape path executes
/// ([`Sink::wv_paint_path_shadow`] / [`Sink::wv_composite_body`] both run
/// `background_blur_graph(sigma * k)` when the cell blurs, and nothing when it does not). The batch
/// derives its instances from this graph instead of re-deriving sigma by hand, so the two paths
/// cannot drift: a change to the builder changes both.
fn wv_batch_cell_graph(c: &WvCell) -> Vec<crate::effect_graph::GraphPass> {
    let (kwf, khf) = (c.kw as f32, c.kh as f32);
    let sigma = if c.sigma >= 0.5 { c.sigma * c.k } else { 0.0 };
    match c.key.1 {
        // A drop shadow is its colour over its coverage, blurred.
        0 => shadow_colour(c.key.0, false, c.key.2)
            .map(|col| effect_graph::drop_shadow_graph(kwf, khf, col, sigma))
            .unwrap_or_default(),
        // The inner shadow's FLOOD is never blurred — only its punch (kind 3) is — so the flood
        // carries the colour and nothing else. The erase that pairs them is the combine stage.
        2 => shadow_colour(c.key.0, true, c.key.2)
            .map(|col| effect_graph::tint_graph(kwf, khf, col))
            .unwrap_or_default(),
        _ if sigma > 0.0 => effect_graph::background_blur_graph(sigma),
        _ => Vec::new(),
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
/// the glass stages, a pointwise-only chain is a stamp. Splitting that decision across two functions
/// is what let a chain belong to neither.
#[derive(Debug, Clone, PartialEq)]
enum BatchShape {
    /// Coverage through an optional blur, stamped by the composite and optionally tinted: drop
    /// shadows, inner-shadow floods and punches, plain bodies.
    Stamp { sigma: f32, linear: bool, tint: Option<[f32; 4]> },
    /// A sampling head, an optional blur, and a pointwise tail — the glass stages.
    Lens { head: crate::vello::glass::UnitOp, tail: Vec<crate::vello::glass::UnitOp>, sigma: f32 },
}

/// Whether a `Units` pass leads with a sampling head, which is what sends a chain to the glass
/// stages rather than the stamp stages.
fn units_head(p: &Pass) -> Option<&crate::vello::glass::UnitOp> {
    use crate::vello::glass::UnitOp;
    match &p.kind {
        crate::vello::graph::PassKind::Units { ops, .. } => match ops.first() {
            Some(op @ (UnitOp::Warp(_) | UnitOp::Scatter(_))) => Some(op),
            _ => None,
        },
        _ => None,
    }
}

fn batch_admit(passes: &[Pass]) -> Option<BatchShape> {
    use crate::vello::glass::UnitOp;
    use crate::vello::graph::{PassKind, BLUR_MAX_SIGMA};

    // A lens: sampling head, optionally a blur, then the pointwise tail. The head's and the blur's
    // scales must agree — the batch packs one cell that serves both resolutions.
    if let Some(head) = passes.first().and_then(units_head) {
        return match passes {
            [one] => (one.scale >= 0.999).then(|| {
                let PassKind::Units { ops, .. } = &one.kind else { unreachable!() };
                BatchShape::Lens { head: head.clone(), tail: ops[1..].to_vec(), sigma: 0.0 }
            }),
            [w, b, t] => {
                let PassKind::Blur { sigma, linear: false } = b.kind else { return None };
                let PassKind::Units { ops: tail, .. } = &t.kind else { return None };
                if sigma > BLUR_MAX_SIGMA || t.scale < 0.999 || (w.scale - b.scale).abs() > 1e-6 {
                    return None;
                }
                Some(BatchShape::Lens { head: head.clone(), tail: tail.clone(), sigma })
            }
            _ => None,
        };
    }

    // Otherwise a stamp: at most one blur, and any units must be pointwise ones the stamp stages
    // already implement — Tint is the composite instance's colour, EraseBy is the combine stage.
    let (mut sigma, mut linear, mut tint, mut blurs) = (0.0_f32, false, None, 0usize);
    for p in passes {
        if p.scale < 0.999 {
            return None;
        }
        match &p.kind {
            PassKind::Blur { sigma: s, linear: l } => {
                blurs += 1;
                if blurs > 1 || *s > BLUR_MAX_SIGMA {
                    return None;
                }
                sigma = *s;
                linear = *l;
            }
            PassKind::Units { ops, .. } => {
                for op in ops {
                    match op {
                        UnitOp::Tint(u) => tint = Some([u[12], u[13], u[14], u[15]]),
                        UnitOp::EraseBy(_) => {}
                        _ => return None,
                    }
                }
            }
            _ => return None,
        }
    }
    Some(BatchShape::Stamp { sigma, linear, tint })
}

/// [`batch_admit`] for one cell, lowering its graph the way the executor will.
fn wv_batch_cell_shape(c: &WvCell) -> Option<BatchShape> {
    batch_admit(&crate::vello::graph::lower_graph(&wv_batch_cell_graph(c), None))
}

/// Build the batch plan for this frame, or `None` when batching is off or nothing qualifies.
///
/// Each candidate cell is lowered to its effect graph by [`wv_batch_cell_graph`] and admitted iff
/// [`wv_batch_supported`] — so the batch executes the same IR the per-shape path executes, through
/// instanced stages instead of private pass chains. Shapes stay per-shape when their stack composes
/// mid-backdrop (glass), carries custom `Shader` ops, or blurs past what the instanced stage
/// expresses; inner shadows batch through the combine (`EraseBy`) stage.
fn wv_batch_plan(
    gathers: &[(usize, u128, u8)],
    rounds: &[u32],
    packing: &crate::atlas::Packing,
    cells: &[(WvCell, usize)],
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
        stages: Vec::new(),
        gids: HashSet::new(),
    };
    let mut by_round: std::collections::BTreeMap<u32, Vec<crate::vello::batch::Inst>> =
        std::collections::BTreeMap::new();
    for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
        if kind != FX_STACK {
            continue;
        }
        let stack = crate::vello::abi::with_scene(|live, _, _| {
            live.get(gid).map(crate::effect::effect_stack).unwrap_or_default()
        });
        let shape_cells: Vec<&WvCell> =
            cells.iter().map(|(c, _)| c).filter(|c| c.key.0 == gid).collect();
        let expressible = !stack.iter().any(|e| {
            matches!(e.source, Source::Backdrop)
                || (matches!(e.source, Source::Body)
                    && e.ops.iter().any(|op| matches!(op, crate::effect::Op::Shader(_))))
        }) && shape_cells
            .iter()
            .all(|c| matches!(wv_batch_cell_shape(c), Some(BatchShape::Stamp { .. })));
        if !expressible || shape_cells.is_empty() {
            continue;
        }
        let find = |kind: u8, idx: usize| {
            shape_cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).copied()
        };
        enum Emit<'a> {
            Cell(&'a WvCell),
            Inner { flood: &'a WvCell, punch: &'a WvCell },
        }
        let mut emit: Vec<Emit> = Vec::new();
        let (mut drop_i, mut inner_i, mut body_done, mut bail) = (0usize, 0usize, false, false);
        for e in &stack {
            match (&e.source, e.compose) {
                (Source::Coverage { .. }, Compose::Under) => {
                    if let Some(c) = find(0, drop_i) {
                        emit.push(Emit::Cell(c));
                    }
                    drop_i += 1;
                }
                (Source::Body, _) => {
                    if !body_done {
                        if let Some(c) = find(1, 0) {
                            emit.push(Emit::Cell(c));
                        }
                        body_done = true;
                    }
                }
                (Source::Coverage { .. }, Compose::Over) => {
                    // The per-shape path paints the body before its first inner shadow; the batch
                    // preserves that by emitting it here in the same position.
                    if !body_done {
                        if let Some(c) = find(1, 0) {
                            emit.push(Emit::Cell(c));
                        }
                        body_done = true;
                    }
                    match (find(2, inner_i), find(3, inner_i)) {
                        (Some(flood), Some(punch)) => emit.push(Emit::Inner { flood, punch }),
                        // A planned inner shadow whose cells are missing cannot be expressed —
                        // dropping it silently would change pixels, so the whole shape stays legacy.
                        _ => bail = true,
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        if !body_done {
            if let Some(c) = find(1, 0) {
                emit.push(Emit::Cell(c));
            }
        }
        if bail || emit.is_empty() {
            continue;
        }
        let placed = |c: &WvCell| place.contains_key(&c.key);
        if emit.iter().any(|e| match e {
            Emit::Cell(c) => !placed(c),
            Emit::Inner { flood, punch } => !placed(flood) || !placed(punch),
        }) {
            continue;
        }
        let rects = |c: &WvCell| {
            let (px, py) = place[&c.key];
            let (kwf, khf) = (c.kw as f32, c.kh as f32);
            (
                (px as f32, (strip_y + py) as f32, kwf, khf),
                (px as f32, py as f32, kwf, khf),
                (c.bx as f32, c.by as f32, c.bw as f32, c.bh as f32),
            )
        };
        // The cell's parameters come from its lowered graph, not from the cell fields — the builder
        // owns the sigma/linear semantics for BOTH paths. An empty graph is the identity: the cell
        // rides the blur stages as a sigma-0 copy so every batched cell lands in the surface the
        // later stages sample.
        let params = |c: &WvCell| match wv_batch_cell_shape(c) {
            Some(BatchShape::Stamp { sigma, linear, .. }) => (sigma, linear),
            _ => (0.0, false),
        };
        let cell_tint = |c: &WvCell| match wv_batch_cell_shape(c) {
            Some(BatchShape::Stamp { tint, .. }) => tint,
            _ => None,
        };
        let mut blur = |plan: &mut WvBatchPlan, c: &WvCell| {
            let (strip_rect, atlas_rect, _) = rects(c);
            let (sigma_dev, linear) = params(c);
            plan.h.push(crate::vello::batch::Inst::new(
                atlas_rect, atlas_size, strip_rect, acc_size, (1.0, 0.0), sigma_dev, linear,
            ));
            plan.v.push(crate::vello::batch::Inst::new(
                atlas_rect, atlas_size, atlas_rect, atlas_size, (0.0, 1.0), sigma_dev, linear,
            ));
        };
        for e in emit {
            match e {
                Emit::Cell(c) => {
                    blur(&mut plan, c);
                    let (_, atlas_rect, frame_rect) = rects(c);
                    let mut inst = crate::vello::batch::Inst::new(
                        frame_rect, acc_size, atlas_rect, atlas_size, (0.0, 0.0), 0.0, false,
                    );
                    if let Some(colour) = cell_tint(c) {
                        inst = inst.tinted(colour);
                    }
                    by_round.entry(rounds[j]).or_default().push(inst);
                }
                Emit::Inner { flood, punch } => {
                    blur(&mut plan, flood);
                    blur(&mut plan, punch);
                    let (_, flood_rect, frame_rect) = rects(flood);
                    let (_, punch_rect, _) = rects(punch);
                    // Materialise the band in atlas A at the flood's own rect (both reads from B),
                    // then composite it from A — `mode` 1 selects the second texture.
                    let Some(pc) = cell_tint(flood) else { continue };
                    plan.combine.push(
                        crate::vello::batch::Inst::new(
                            flood_rect, atlas_size, flood_rect, atlas_size, (0.0, 0.0), 0.0, false,
                        )
                        .with_src2(punch_rect, atlas_size, 0.0)
                        .tinted(pc),
                    );
                    let Some(colour) = cell_tint(flood) else { continue };
                    by_round.entry(rounds[j]).or_default().push(
                        crate::vello::batch::Inst::new(
                            frame_rect, acc_size, flood_rect, atlas_size, (0.0, 0.0), 0.0, false,
                        )
                        .with_src2(punch_rect, atlas_size, 1.0)
                        .tinted(colour),
                    );
                }
            }
        }
        plan.gids.insert(gid);
    }
    if plan.gids.is_empty() {
        return None;
    }
    {
        use crate::vello::batch::{stage, Stage, Surface};
        let rounds_used = by_round.len();
        plan.stages.push(
            Stage::new(stage::BLUR, Surface::Atlas(0), Surface::Acc, std::mem::take(&mut plan.h)).cleared(),
        );
        plan.stages.push(
            Stage::new(stage::BLUR, Surface::Atlas(1), Surface::Atlas(0), std::mem::take(&mut plan.v)).cleared(),
        );
        plan.stages.push(Stage::new(
            stage::COMBINE,
            Surface::Atlas(0),
            Surface::Atlas(1),
            std::mem::take(&mut plan.combine),
        ));
        for (r, insts) in by_round {
            plan.stages.push(
                Stage::new(stage::COMPOSITE, Surface::Acc, Surface::Atlas(1), insts)
                    .with_src2(Surface::Atlas(0))
                    .composited()
                    .with_round(r),
            );
        }
        let _ = rounds_used;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("WV_BATCH_STATS").is_ok() {
        eprintln!(
            "wv batch: shapes={} stages={} instances={}",
            plan.gids.len(),
            plan.stages.len(),
            plan.stages.iter().map(|s| s.insts.len()).sum::<usize>(),
        );
    }
    Some(plan)
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

/// One glass lens admitted to the batched stages: where it reads and writes on the accumulator,
/// which atlas cell it owns, and the lowered unit passes it runs.
///
/// `red` is the cell's *reduced* rect — the sub-rect of its own cell the warp and blur render
/// into when the chain solver dropped that prefix below native ([`crate::footprint::chain_scales`]
/// gives a frosted lens ~0.1–0.5). It nests inside the full cell rect, so one packing serves both
/// and the frost stage upsamples by sampling the reduced rect across the full one — the same
/// bilinear stretch `run_graph_into` gets from binding a smaller texture.
struct GlassCell {
    gid: u128,
    round: u32,
    dev: (f32, f32, f32, f32),
    cell: (f32, f32, f32, f32),
    red: (f32, f32, f32, f32),
    warp: crate::vello::glass::UnitOp,
    tail: Vec<crate::vello::glass::UnitOp>,
    sigma: f32,
}


/// Native A/B hook for the batched glass stages (default on): `WV_GLASS=0` forces every lens back
/// through its own pass chain, which is how the batched output is pixel-compared against the
/// per-shape one. No browser gate — the batch is the production path.
fn wv_glass_batch() -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::env::var("WV_GLASS").is_ok_and(|v| v != "0") || std::env::var("WV_GLASS").is_err();
    }
    #[cfg(target_arch = "wasm32")]
    true
}

/// The four surfaces the batched glass stages ping-pong through, all packed with the same cell
/// layout: `a` the cropped backdrops (kept — the mask-mix reads it as the original), `b` the warp
/// then the blurred warp, `d` the horizontal-blur scratch, `c` the finished lenses awaiting the
/// stamp. Held for the whole frame so every round reuses them.
struct WvGlassAtlas {
    w: u32,
    h: u32,
    a_view: wgpu::TextureView,
    b_view: wgpu::TextureView,
    c_view: wgpu::TextureView,
    d_view: wgpu::TextureView,
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

/// One whole-viewport effect surface, resolved to geometry: which node/kind it belongs to, the device
/// crop box it covers, the render scale `k`, the surface size at that scale, and its device sigma.
#[derive(Clone, Copy)]
struct WvCell {
    key: (u128, u8, usize),
    bx: u32,
    by: u32,
    bw: u32,
    bh: u32,
    kw: u32,
    kh: u32,
    k: f32,
    sigma: f32,
    /// Device-space translation this cell's chain applies to its result (a filter graph's `Offset`).
    /// Derived from the effect's ops the same way `sigma` is, because the consumers are handed a
    /// cell rather than the ops — a value carried on the cell reaches every one of them.
    dev_offset: (f32, f32),
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
    glass: GlassPipeline,
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
    /// reads it to scale the sigma / glass geometry and the stamp's source rect to match.
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

    /// Per-pass GPU timing for the effect graph (glass displacement/refraction/blur/composite), when
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
            glass: GlassPipeline::new(device, format),
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
                            let has_gather = n.background_blur.is_some() || n.glass.is_some() || n.gather_shader().is_some();
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
        let max_round = rounds.iter().copied().max().unwrap_or(0);
        let batch_plan = strip.as_ref().and_then(|(packing, cells)| {
            wv_batch_plan(&gathers, &rounds, packing, cells, strip_y, (width as f32, acc_h as f32))
        });
        let mut batch_rt: Option<(wgpu::Texture, wgpu::Texture, wgpu::TextureView, wgpu::TextureView)> = None;
        let glass_plan = self
            .wv_glass_plan(&gathers, &rounds, full_view, width, height, device.limits().max_texture_dimension_2d)
            .filter(|_| wv_glass_batch());
        let (glass_cells, glass_atlas) = match glass_plan {
            Some((packing, cells)) => {
                let _ = self
                    .batch_pipes
                    .get_or_insert_with(|| crate::vello::batch::BatchPipelines::new(device, format));
                let (aw, ah) = (packing.width, packing.height);
                let mut mk = |label| self.pool.acquire_target(device, aw, ah, format, wgpu::TextureUsages::empty(), label);
                let (a, b, c, d) = (mk("wv glass a"), mk("wv glass b"), mk("wv glass c"), mk("wv glass d"));
                let vd = wgpu::TextureViewDescriptor::default();
                let atlas = WvGlassAtlas {
                    w: aw,
                    h: ah,
                    a_view: a.create_view(&vd),
                    b_view: b.create_view(&vd),
                    c_view: c.create_view(&vd),
                    d_view: d.create_view(&vd),
                    keep: vec![a, b, c, d],
                };
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_GLASS_STATS").is_ok() {
                    let sharp = cells.iter().filter(|c| c.sigma <= 0.0).count();
                    eprintln!(
                        "wv glass batch: {} lenses ({sharp} sharp, {} frosted) in {} rounds, atlas {aw}x{ah}",
                        cells.len(),
                        cells.len() - sharp,
                        cells.iter().map(|c| c.round).collect::<std::collections::BTreeSet<_>>().len()
                    );
                }
                (Some(cells), Some(atlas))
            }
            None => (None, None),
        };

        let boundaries: Vec<u32> = {
            let mut b = Vec::with_capacity(gathers.len());
            let mut cursor = 0usize;
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                if gi > cursor {
                    backend.draw_scene_range(&mut scene, root, cursor, gi);
                    cursor = gi;
                }
                b.push(backend.draw_object_count(&scene));
                let effect_id = if kind == FX_STACK {
                    6u32
                } else {
                    crate::vello::abi::with_scene(|live, _, _| {
                        live.get(gid).map_or(1u32, |n| {
                            if n.glass.is_some() { 0 } else if n.gather_shader().is_some() { 2 } else { 1 }
                        })
                    })
                };
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_TRACE").is_ok() {
                    eprintln!("marker j={j} kind={kind} round={} reach={:?}", rounds[j], reaches[j]);
                }
                backend.draw_effect_marker(&mut scene, root, gid, effect_id, b.len() as u32, rounds[j], reaches[j]);
                if kind == FX_STACK {
                    cursor = gi + 1;
                }
            }
            backend.draw_scene_range(&mut scene, root, cursor, usize::MAX);
            b
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
        let rw = backend.rw_accumulator() && format == wgpu::TextureFormat::Rgba8Unorm;
        let n_slots: usize = if rw { 1 } else { 2 };
        let texs: Vec<wgpu::Texture> = (0..n_slots)
            .map(|_| self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv phase"))
            .collect();
        let views: Vec<wgpu::TextureView> =
            texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();

        for (_, (tex, _)) in std::mem::take(&mut self.wv_atlas) {
            self.pool.release(tex);
        }
        if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
            Self::submit_batch(&mut enc, device, queue, backend);
            flush_mark = passes_recorded();
        }

        let _tpb = crate::vello::prof::now();
        backend.phased_begin(&scene, device, queue, &mut enc, width, acc_h, crate::vello::abi::background());
        crate::vello::prof::dbg_add(31, crate::vello::prof::now() - _tpb);

        backend.phased_frontend_full(device, queue, &mut enc);
        let n_gathers = gathers.len() as u32;

        let _tpl = crate::vello::prof::now();
        let n_markers = n_gathers;
        let real_draws = total_draws.saturating_sub(n_markers);
        let draws_after = |j: usize| -> u32 {
            total_draws.saturating_sub(boundaries[j]).saturating_sub(n_markers - j as u32)
        };
        let window_has_draws = |lo: u32, hi: u32| -> bool {
            if lo == 0 {
                return real_draws > 0;
            }
            (0..gathers.len()).any(|j| {
                rounds[j] >= lo && (hi == crate::vello::rasterize::SEG_ALL || rounds[j] < hi) && draws_after(j) > 0
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
            note_passes(2);
            if window_has_draws(window_lo, r) {
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
                    batch_plan.as_ref().map(|p| &p.gids),
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
                    let a = self.pool.acquire_target(device, aw, ah, format, wgpu::TextureUsages::empty(), "wv batch blur a");
                    let b = self.pool.acquire_target(device, aw, ah, format, wgpu::TextureUsages::empty(), "wv batch blur b");
                    let av = a.create_view(&wgpu::TextureViewDescriptor::default());
                    let bv = b.create_view(&wgpu::TextureViewDescriptor::default());
                    pipes.run_stages(device, &mut enc, &plan.stages, None, &views[ci], &[&av, &bv], self.compositor.sampler());
                    // Held OUTSIDE `frame_transient` on purpose: the per-node recycle point
                    // truncates that list back to its pre-loop checkpoint, and the blurred atlas
                    // must survive every round. It returns to the pool after the final window.
                    batch_rt = Some((a, b, av, bv));
                }
                strip_filled = true;
            }
            if let (Some(plan), Some((_, _, av, bv))) = (batch_plan.as_ref(), batch_rt.as_ref()) {
                let pipes = self.batch_pipes.as_ref().expect("batch pipelines built with the plan");
                pipes.run_stages(device, &mut enc, &plan.stages, Some(r), &views[ci], &[av, bv], self.compositor.sampler());
            }
            // Every batched lens of this round, in one pass per stage. Lenses in a round are
            // disjoint by construction, so they can all read the accumulator and write their own
            // crops concurrently — the per-shape chain is what forced them apart before.
            if let (Some(cells), Some(atlas)) = (glass_cells.as_ref(), glass_atlas.as_ref()) {
                self.wv_glass_round(device, &mut enc, &views[ci], atlas, cells, r, format, acc_sz);
            }
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                if rounds[j] != r {
                    continue;
                }
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_TRACE").is_ok() {
                    eprintln!("wv trace: round={r} j={j} gi={gi} kind={kind} transient={}", self.frame_transient.len());
                }
                if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
                    Self::submit_batch(&mut enc, device, queue, backend);
                    flush_mark = passes_recorded();
                }
                match kind {
                    FX_STACK if batch_plan.as_ref().is_some_and(|p| p.gids.contains(&gid)) => {}
                    FX_STACK => self.wv_paint_stack(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, gi, width, height, format, acc_sz),
                    _ if glass_cells.as_ref().is_some_and(|cs| cs.iter().any(|c| c.gid == gid)) => {}
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
        if let Some((a, b, av, bv)) = batch_rt.take() {
            self.frame_transient.push(a);
            self.frame_transient.push(b);
            self.frame_transient_views.push(av);
            self.frame_transient_views.push(bv);
        }
        // Same rule as the batch atlases: held outside `frame_transient` for the whole round loop
        // (the per-node recycle point truncates that list), returned to the pool once it ends.
        if let Some(atlas) = glass_atlas {
            self.frame_transient.extend(atlas.keep);
            self.frame_transient_views.push(atlas.a_view);
            self.frame_transient_views.push(atlas.b_view);
            self.frame_transient_views.push(atlas.c_view);
            self.frame_transient_views.push(atlas.d_view);
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

    /// Plan the frame's batched glass: every scoped lens whose graph the instanced stages can express
    /// ([`wv_glass_admit`]), packed into one atlas whose cells are grouped by round. Lenses sharing a
    /// round never overlap (that is what [`wv_rounds`] guarantees), so a round's cells can all run in
    /// one pass per stage. `None` when fewer than two lenses qualify — one lens costs the same either
    /// way and only adds a pack.
    fn wv_glass_plan(
        &self,
        gathers: &[(usize, u128, u8)],
        rounds: &[u32],
        full_view: Affine,
        width: u32,
        height: u32,
        max_dim: u32,
    ) -> Option<(crate::atlas::Packing, Vec<GlassCell>)> {
        if !crate::vello::abi::wv_scope() {
            return None;
        }
        let mut cells: Vec<GlassCell> = Vec::new();
        for (j, &(_gi, gid, kind)) in gathers.iter().enumerate() {
            if kind == FX_STACK {
                continue;
            }
            let (is_glass, is_custom) = crate::vello::abi::with_scene(|live, _, _| {
                live.get(gid).map_or((false, false), |n| (n.glass.is_some(), n.gather_shader().is_some()))
            });
            if !is_glass || is_custom {
                continue;
            }
            let Some((bx, by, bw, bh, k)) = self.wv_glass_box(gid, full_view, width, height) else {
                continue;
            };
            if k < 0.999 || bw > max_dim || bh > max_dim {
                continue;
            }
            let Some(passes) = self.glass_graph(gid, bw, bh, f64::from(bx), f64::from(by), full_view, 1.0) else {
                continue;
            };
            let Some(BatchShape::Lens { head: warp, tail, sigma }) = batch_admit(&passes) else {
                continue;
            };
            let red_scale = if sigma > 0.0 { passes[0].scale } else { 1.0 };
            let (rw, rh) = (
                crate::effect_graph::pass_dim(bw, red_scale),
                crate::effect_graph::pass_dim(bh, red_scale),
            );
            cells.push(GlassCell {
                gid,
                round: rounds[j],
                dev: (bx as f32, by as f32, bw as f32, bh as f32),
                cell: (0.0, 0.0, bw as f32, bh as f32),
                red: (0.0, 0.0, rw as f32, rh as f32),
                warp,
                tail,
                sigma,
            });
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
        Some((packing, cells))
    }

    /// The device box and render scale one scoped lens reads and writes — the same derivation
    /// [`Self::wv_stamp_gather_scoped`] does, factored out so the batch planner and the per-shape
    /// path can never disagree about a lens's geometry.
    fn wv_glass_box(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32, f64)> {
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

    /// Run every batched lens of ONE round: crop each lens's backdrop out of the accumulator, run the
    /// unit stages over all of them at once — one pass per stage, not per lens — and composite the
    /// results back. A round's lenses are disjoint, so the whole round is at most six passes
    /// regardless of how many lenses it holds (crop, sharp, warp, blur H, blur V, frost, stamp).
    #[expect(clippy::too_many_arguments, reason = "the GPU context + atlas set travel together")]
    fn wv_glass_round(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        atlas: &WvGlassAtlas,
        cells: &[GlassCell],
        round: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        use crate::vello::batch::{stage, GlassField, Inst};
        let Some(pipes) = self.batch_pipes.as_ref() else { return };
        let here: Vec<&GlassCell> = cells.iter().filter(|c| c.round == round).collect();
        if here.is_empty() {
            return;
        }
        let asz = (atlas.w as f32, atlas.h as f32);
        let sampler = self.compositor.sampler();

        let mut crops: Vec<Inst> = Vec::with_capacity(here.len());
        let (mut sharp, mut sharp_f) = (Vec::new(), Vec::new());
        let (mut warp, mut warp_f) = (Vec::new(), Vec::new());
        let (mut blur_h, mut blur_v) = (Vec::new(), Vec::new());
        let (mut frost, mut frost_f) = (Vec::new(), Vec::new());
        let mut stamp: Vec<Inst> = Vec::with_capacity(here.len());
        for c in &here {
            crops.push(Inst::new(c.cell, asz, c.dev, sz, (0.0, 0.0), 0.0, false));
            let mut ops = vec![c.warp.clone()];
            if c.sigma <= 0.0 {
                ops.extend(c.tail.iter().cloned());
                sharp.push(
                    Inst::new(c.cell, asz, c.cell, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, sharp_f.len() as f32)
                        .at(c.cell),
                );
                sharp_f.push(GlassField { u: crate::vello::glass::units_uniform(&ops) });
            } else {
                warp.push(
                    Inst::new(c.red, asz, c.cell, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, warp_f.len() as f32)
                        .at(c.red),
                );
                warp_f.push(GlassField { u: crate::vello::glass::units_uniform(&ops) });
                blur_h.push(Inst::new(c.red, asz, c.red, asz, (1.0, 0.0), c.sigma, false));
                blur_v.push(Inst::new(c.red, asz, c.red, asz, (0.0, 1.0), c.sigma, false));
                frost.push(
                    Inst::new(c.cell, asz, c.red, asz, (0.0, 0.0), 0.0, false)
                        .with_src2(c.cell, asz, frost_f.len() as f32)
                        .at(c.cell),
                );
                frost_f.push(GlassField { u: crate::vello::glass::units_uniform(&c.tail) });
            }
            stamp.push(Inst::new(c.dev, sz, c.cell, asz, (0.0, 0.0), 0.0, false));
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
        let stages = [
            Stage::new(stage::BLUR, A, Surface::Acc, crops).cleared(),
            Stage::new(stage::GLASS_SHARP, C, A, sharp).with_fields(sharp_f),
            Stage::new(stage::GLASS_WARP, B, A, warp).with_fields(warp_f),
            Stage::new(stage::BLUR, D, B, blur_h).cleared(),
            Stage::new(stage::BLUR, B, D, blur_v).cleared(),
            Stage::new(stage::GLASS_FROST, C, B, frost).with_src2(A).with_fields(frost_f),
            Stage::new(stage::COMPOSITE, Surface::Acc, C, stamp).composited(),
        ];
        let views = [&atlas.a_view, &atlas.b_view, &atlas.c_view, &atlas.d_view];
        for st in &stages {
            pipes.run_stage(device, enc, st, acc_view, &views, sampler);
        }
        let _ = format;
    }

    /// Run a gather's effect graph over the whole-viewport backdrop (`acc`) and stamp the result back
    /// onto `acc` through the shape's silhouette — the whole-viewport counterpart of the tiled
    /// `paint_gather`, at full res (no `k` cap, backdrop origin `(0,0)`).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
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
        let is_glass = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.glass.is_some()));
        let is_custom = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));
        if crate::vello::abi::wv_scope() && !is_custom {
            self.wv_stamp_gather_scoped(backend, device, queue, enc, acc_view, root, full_view, id, is_glass, width, height, format, sz);
            return;
        }
        let passes = if is_glass {
            self.glass_graph(id, width, height, 0.0, 0.0, full_view, 1.0)
        } else if is_custom {
            self.custom_graph(id, width, height, device, format)
        } else {
            Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, 1.0)), None))
        };
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
        let graph = run_graph_into(
            &self.compositor, &self.glass, device, enc, &[graph_in], &passes, width, height, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views,
            self.pass_prof.as_mut(),
        );
        if let Some((t, v)) = crop {
            self.frame_transient.push(t);
            self.frame_transient_views.push(v);
        }
        let Some((rtex, rview)) = graph else {
            return;
        };
        if is_glass {
            self.compositor.blit(device, enc, acc_view, sz, &Blit {
                src: &rview, dst: (0.0, 0.0, vp.0, vp.1), src_rect: (0.0, 0.0, vp.0, vp.1), src_size: vp, alpha: 1.0,
            });
        } else {
            let mask = self.pool.acquire_target(device, width, height, format, self.raster_usage, "wv mask");
            let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(width as u16, height as u16);
            backend.build_mask(&mut mscene, root, id);
            backend.rasterize(&mscene, device, queue, enc, &mask_view, width, height, TRANSPARENT);
            self.compositor.blit_masked(device, enc, acc_view, sz, &MaskedBlit {
                src: &rview, mask: &mask_view, dst: (0.0, 0.0, vp.0, vp.1), src_rect: (0.0, 0.0, vp.0, vp.1), src_size: vp, alpha: 1.0,
            });
            self.frame_transient.push(mask);
            self.frame_transient_views.push(mask_view);
        }
        self.frame_transient.push(rtex);
        self.frame_transient_views.push(rview);
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
    fn wv_effect_cells(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Vec<WvCell> {
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
            for &kind in kinds {
                out.push(WvCell { key: (id, kind, index), bx, by, bw, bh, kw, kh, k, sigma: device_sigma.unwrap_or(0.0), dev_offset });
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
                out.push(WvCell { key: (id, 1, 0), bx, by, bw, bh, kw, kh, k, sigma: 0.0, dev_offset: (0.0, 0.0) });
            }
        }
        out
    }

    /// The device-space box an effect node's whole-viewport stamp (and its blur neighbourhood) can
    /// touch — the region whose tiles need this node's `CMD_EFFECT` boundary marker. A stack node's
    /// stamps composite at its effect cells' boxes; a gather stamps inside its lens bbox expanded by
    /// the blur reach (glass adds refraction slack — same margins as `wv_stamp_gather_scoped`); a
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
                x0 = x0.min(c.bx as f32);
                y0 = y0.min(c.by as f32);
                x1 = x1.max((c.bx + c.bw) as f32);
                y1 = y1.max((c.by + c.bh) as f32);
            }
            return [x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD];
        }
        use crate::kurbo::Point;
        let Some((page, is_glass, is_custom, glass_sigma)) =
            crate::vello::abi::with_scene(|live, _, modifiers| {
                let n = live.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                Some((
                    crate::schedule::page_bounds(n, m),
                    n.glass.is_some(),
                    n.gather_shader().is_some(),
                    n.glass.map_or(0.0, |g| g.total_blur_sigma()),
                ))
            })
        else {
            return full;
        };
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let reach = if is_glass {
            3.0 * f64::from(glass_sigma * scale) + 20.0
        } else {
            3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0
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
    ) -> Option<(crate::atlas::Packing, Vec<(WvCell, usize)>)> {
        const GAP: u32 = 4;
        let mut cells: Vec<(WvCell, usize)> = Vec::new();
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
        let gap = if align > 1 { 0 } else { GAP };
        let packing = shelf_pack(&sizes, gap, target_w, max_dim)?;
        Some((packing, cells))
    }

    /// The page→cell transform for one packed source surface: place the cell's device-space box at
    /// `(ox + cell.x, oy + cell.y)`, at the surface's render scale `k`. Shared by both fill
    /// strategies so a cell lands on the same texels whichever one runs.
    ///
    /// The cell's own translation ([`WvCell::dev_offset`], a filter graph's `Offset`) is applied
    /// here rather than at the stamp, because the cell's box already moved with it — its footprint
    /// walks the same ops — so rendering at the unmoved position and stamping at the moved box would
    /// cancel exactly, which is what made a filter offset a silent no-op. Zero for every chain
    /// without one, so every other cell is byte-identical.
    fn wv_cell_transform(c: &WvCell, place: &crate::atlas::Placement, ox: u32, oy: u32, root: Affine) -> Affine {
        Affine::translate((f64::from(ox + place.x), f64::from(oy + place.y)))
            * Affine::scale(f64::from(c.k))
            * Affine::translate((
                f64::from(c.dev_offset.0) - f64::from(c.bx),
                f64::from(c.dev_offset.1) - f64::from(c.by),
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
        cells: &[(WvCell, usize)],
        ox: u32,
        oy: u32,
        format: wgpu::TextureFormat,
        skip: Option<&HashSet<u128>>,
    ) {
        for place in &packing.cells {
            let (c, _) = &cells[place.index];
            if skip.is_some_and(|set| set.contains(&c.key.0)) {
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
    ) -> Option<(crate::atlas::Packing, Vec<(WvCell, usize)>)> {
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
        cells: &[(WvCell, usize)],
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
                    c.key, place.x, strip_y + place.y, c.kw, c.kh, c.bx, c.by, c.bw, c.bh, c.k, c.sigma);
            }
            let rect = Rect::new(
                f64::from(place.x),
                f64::from(strip_y + place.y),
                f64::from((place.x + c.kw).next_multiple_of(TILE_PX)),
                f64::from((strip_y + place.y + c.kh).next_multiple_of(TILE_PX)),
            );
            scene.set_transform(Affine::IDENTITY);
            scene.push_layer(Some(&rect.to_path(0.1)), Some(replace), None, None, None);
            match c.key.1 {
                0 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, false, true, false),
                2 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, true, false, false),
                3 => backend.build_shadow_silhouette(scene, m, c.key.0, c.key.2, true, true, false),
                _ => backend.draw_scene_range(scene, m, *root_index, *root_index + 1),
            }
            scene.pop_layer();
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
        cell: WvCell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        {
            let WvCell { bx, by, bw, bh, kw, kh, k, sigma, key, .. } = cell;
            let (bxf, byf, bwf, bhf) = (bx as f32, by as f32, bw as f32, bh as f32);
            let sil_view = if let Some(v) = self.wv_atlas.get(&key).map(|(_, v)| v.clone()) {
                v
            } else {
                let crop = Affine::translate((-f64::from(bx), -f64::from(by))) * root;
                let sil = self.pool.acquire_target(device, kw, kh, format, self.raster_usage, "wv path shadow silhouette");
                let v = sil.create_view(&wgpu::TextureViewDescriptor::default());
                let mut sscene = backend.new_scene(kw as u16, kh as u16);
                backend.build_shadow_silhouette(&mut sscene, Affine::scale(f64::from(k)) * crop, id, key.2, false, true, false);
                backend.rasterize(&sscene, device, queue, enc, &v, kw, kh, TRANSPARENT);
                self.frame_transient.push(sil);
                self.frame_transient_views.push(v.clone());
                v
            };
            let (kwf, khf) = (kw as f32, kh as f32);
            let Some(colour) = shadow_colour(id, false, key.2) else { return };
            let graph = effect_graph::drop_shadow_graph(kwf, khf, colour, sigma * k);
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&sil_view], &lower_graph(&graph, None),
                kw, kh, format, &mut self.pool, &mut self.frame_transient,
                &mut self.frame_transient_views, self.pass_prof.as_mut(),
            );
            let Some((tex, view)) = out else { return };
            self.compositor.blit(device, enc, acc_view, sz, &Blit {
                src: &view, dst: (bxf, byf, bwf, bhf), src_rect: (0.0, 0.0, kwf, khf), src_size: (kwf, khf), alpha: 1.0,
            });
            self.frame_transient.push(tex);
            self.frame_transient_views.push(view);
        }
    }

    /// Composite a node's inner (inset) shadows over the whole-viewport accumulator, on top of the
    /// body already painted below this boundary.
    ///
    /// The band is built entirely in textures: the shadow-coloured silhouette at the shape's own
    /// position is the flood (already clipped to the outline because it IS the outline), the same
    /// silhouette offset and blurred is the punch, and `DestOut` of the punch from the flood leaves
    /// colour only in the band on the offset side.
    ///
    /// Geometry comes from [`Self::wv_effect_cells`], the same planner the atlas prepass used, so the
    /// flood and the punch are guaranteed to share one box — which they must, since the `DestOut`
    /// aligns them 1:1.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_inner_shadow<B: RasterBackend>(
        &mut self,
        cell: WvCell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        {
            let WvCell { bx, by, bw, bh, kw, kh, k, sigma, key, .. } = cell;
            let i = key.2;
            let ksz = (kw as f32, kh as f32);
            let full_src = (0.0, 0.0, ksz.0, ksz.1);
            let crop = Affine::translate((-f64::from(bx), -f64::from(by))) * root;
            let scaled_root = Affine::scale(f64::from(k)) * crop;
            let mut fetch = |sink: &mut Self, kind: u8, apply_offset: bool, backend: &mut B, enc: &mut wgpu::CommandEncoder| {
                if let Some(v) = sink.wv_atlas.get(&(id, kind, i)).map(|(_, v)| v.clone()) {
                    return v;
                }
                let label = if apply_offset { "wv inner shadow punch" } else { "wv inner shadow band" };
                let tex = sink.pool.acquire_target(device, kw, kh, format, sink.raster_usage, label);
                let v = tex.create_view(&wgpu::TextureViewDescriptor::default());
                let mut scene = backend.new_scene(kw as u16, kh as u16);
                backend.build_shadow_silhouette(&mut scene, scaled_root, id, i, true, apply_offset, false);
                backend.rasterize(&scene, device, queue, enc, &v, kw, kh, TRANSPARENT);
                sink.frame_transient.push(tex);
                sink.frame_transient_views.push(v.clone());
                v
            };
            let band_view = fetch(self, 2, false, backend, enc);
            let punch_view = fetch(self, 3, true, backend, enc);
            let Some(colour) = shadow_colour(id, true, i) else { return };
            let graph = effect_graph::inner_shadow_graph(ksz.0, ksz.1, colour, sigma * k);
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&band_view, &punch_view],
                &lower_graph(&graph, None), kw, kh, format, &mut self.pool,
                &mut self.frame_transient, &mut self.frame_transient_views, self.pass_prof.as_mut(),
            );
            let Some((tex, view)) = out else { return };
            self.compositor.blit(device, enc, acc_view, sz, &Blit {
                src: &view, dst: (bx as f32, by as f32, bw as f32, bh as f32), src_rect: full_src, src_size: ksz, alpha: 1.0,
            });
            self.frame_transient.push(tex);
            self.frame_transient_views.push(view);
        }
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
                crate::vello::prof::dbg_set(16, f64::from(c.bx));
                crate::vello::prof::dbg_set(17, f64::from(c.by));
                crate::vello::prof::dbg_set(18, f64::from(c.bw));
                crate::vello::prof::dbg_set(19, f64::from(c.bh));
                crate::vello::prof::dbg_set(23, f64::from(c.kw));
                crate::vello::prof::dbg_set(29, f64::from(c.k) * 1000.0);
            }
        }
        let find = |kind: u8, idx: usize| cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).copied();

        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut body_done = false;
        for effect in &stack {
            match (&effect.source, effect.compose) {
                (Source::Coverage { .. }, Compose::Under) => {
                    if let Some(c) = find(0, drop_i) {
                        self.wv_paint_path_shadow(c, backend, device, queue, enc, acc_view, root, id, format, sz);
                    }
                    drop_i += 1;
                }
                (Source::Backdrop, _) => {
                    self.wv_stamp_gather(backend, device, queue, enc, acc_view, root, full_view, id, width, height, format, sz);
                }
                (Source::Body, _) => {
                    if let Some(c) = find(1, 0) {
                        self.wv_composite_body(c, &effect.ops, backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
                    }
                    body_done = true;
                }
                (Source::Coverage { .. }, Compose::Over) => {
                    if !body_done {
                        if let Some(c) = find(1, 0) {
                            self.wv_composite_body(c, &[], backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
                        }
                        body_done = true;
                    }
                    if let Some(c) = find(2, inner_i) {
                        self.wv_paint_inner_shadow(c, backend, device, queue, enc, acc_view, root, id, format, sz);
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        if !body_done {
            if let Some(c) = find(1, 0) {
                self.wv_composite_body(c, &[], backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
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
        cell: WvCell,
        ops: &[crate::effect::Op],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        root_index: usize,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let WvCell { bx, by, bw, bh, kw, kh, k, sigma, .. } = cell;
        let blur_sigma = (sigma >= 0.5).then_some(sigma);
        // A body chain may translate its result (a filter graph's `Offset`). The cell's own box
        // already moved with it — `Effect::footprint` walks the same ops — so rendering into the
        // moved cell and stamping it back would cancel out exactly. Shift the render by the same
        // device vector to make the move real. Zero for every chain without an offset, so the
        // layer-blur path is untouched.
        let (odx, ody) = (f64::from(cell.dev_offset.0), f64::from(cell.dev_offset.1));
        let crop = Affine::translate((odx - f64::from(bx), ody - f64::from(by))) * root;
        let (bxf, byf, bwf, bhf) = (bx as f32, by as f32, bw as f32, bh as f32);
        let ksz = (kw as f32, kh as f32);

        let mut cur_view = if let Some(v) = self.wv_atlas.get(&(id, 1, 0)).map(|(_, v)| v.clone()) {
            v
        } else {
            let sub = self.pool.acquire_target(device, kw, kh, format, self.raster_usage, "wv stack body");
            let v = sub.create_view(&wgpu::TextureViewDescriptor::default());
            let mut scene = backend.new_scene(kw as u16, kh as u16);
            backend.draw_scene_range(&mut scene, Affine::scale(f64::from(k)) * crop, root_index, root_index + 1);
            backend.rasterize(&scene, device, queue, enc, &v, kw, kh, TRANSPARENT);
            self.frame_transient.push(sub);
            self.frame_transient_views.push(v.clone());
            v
        };

        let chain: Vec<(String, Vec<f32>, u32)> = ops
            .iter()
            .filter_map(|op| match op {
                crate::effect::Op::Shader(c) => Some((c.wgsl.clone(), c.params.clone(), c.param_vec4s)),
                _ => None,
            })
            .collect();
        for (wgsl, params, param_vec4s) in chain {
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
            let mut u = vec![ksz.0, ksz.1];
            u.extend_from_slice(&params);
            let passes = lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline));
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&cur_view], &passes, kw, kh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            let Some((tex, view)) = out else { break };
            self.frame_transient.push(tex);
            self.frame_transient_views.push(cur_view);
            cur_view = view;
        }

        if let Some(sigma) = blur_sigma {
            let passes = lower_graph(&effect_graph::background_blur_graph(sigma * k), None);
            if let Some((tex, view)) = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&cur_view], &passes, kw, kh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, self.pass_prof.as_mut(),
            ) {
                self.frame_transient.push(tex);
                self.frame_transient_views.push(cur_view);
                cur_view = view;
            }
        }

        self.compositor.blit(device, enc, acc_view, sz, &Blit {
            src: &cur_view, dst: (bxf, byf, bwf, bhf), src_rect: (0.0, 0.0, ksz.0, ksz.1), src_size: ksz, alpha: 1.0,
        });
        self.frame_transient_views.push(cur_view);
    }

    /// Bbox-scoped gather stamp (the default gather path): crop the backdrop to the lens's device
    /// bounding box (expanded by the effect's blur reach, clamped to the viewport), run the effect
    /// graph at that size/origin, and stamp the small result back THROUGH the shape silhouette. Effect
    /// GPU work then scales with the lens area instead of the viewport area. Glass bakes its SDF mask,
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
        is_glass: bool,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        use crate::kurbo::Point;
        let Some(page) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        }) else {
            return;
        };
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let reach = if is_glass {
            let sigma = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).and_then(|n| n.glass).map_or(0.0, |g| g.total_blur_sigma() * scale)
            });
            3.0 * f64::from(sigma) + 20.0
        } else {
            3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0
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
        let bx = minx.floor().clamp(0.0, f64::from(width)) as u32;
        let by = miny.floor().clamp(0.0, f64::from(height)) as u32;
        let ex = maxx.ceil().clamp(0.0, f64::from(width)) as u32;
        let ey = maxy.ceil().clamp(0.0, f64::from(height)) as u32;
        let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
        if bw == 0 || bh == 0 {
            return;
        }

        let declared = f64::from(
            crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map_or(1.0_f32, |n| n.glass.map_or(1.0, |g| g.acceptable_downscale))
            })
            .clamp(f32::MIN_POSITIVE, 1.0),
        );
        let k = tiling::resolution_cap(full_view, reach / f64::from(scale)).min(declared);
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

        let passes = if is_glass {
            self.glass_graph(id, kw, kh, f64::from(bx), f64::from(by), full_view, k)
        } else {
            Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, k)), None))
        };
        let Some(passes) = passes else { return };
        let Some((rtex, rview)) = run_graph_into(
            &self.compositor, &self.glass, device, enc, &[&bd_view], &passes, kw, kh, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views,
            self.pass_prof.as_mut(),
        ) else {
            return;
        };

        if is_glass {
            let b = Blit {
                src: &rview,
                dst: (bx as f32, by as f32, bw as f32, bh as f32),
                src_rect: (0.0, 0.0, bw as f32, bh as f32),
                src_size: (bw as f32, bh as f32),
                alpha: 1.0,
            };
            if k < 0.999 {
                self.compositor.blit_sharp(device, enc, acc_view, sz, &b);
            } else {
                self.compositor.blit(device, enc, acc_view, sz, &b);
            }
        } else {
            let mask = self.pool.acquire_target(device, bw, bh, format, self.raster_usage, "wv scoped mask");
            let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(bw as u16, bh as u16);
            backend.build_mask(&mut mscene, Affine::translate((-(bx as f64), -(by as f64))) * root, id);
            backend.rasterize(&mscene, device, queue, enc, &mask_view, bw, bh, TRANSPARENT);
            let mb = MaskedBlit {
                src: &rview,
                mask: &mask_view,
                dst: (bx as f32, by as f32, bw as f32, bh as f32),
                src_rect: (0.0, 0.0, bw as f32, bh as f32),
                src_size: (bw as f32, bh as f32),
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
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(enc, acc_view, crate::vello::graph::prof_bucket::STAMP);
        }
        self.frame_transient.push(bd);
        self.frame_transient_views.push(bd_view);
        self.frame_transient.push(rtex);
        self.frame_transient_views.push(rview);
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
                run_graph(&self.compositor, &self.glass, device, queue, &[&bd_view], &passes, aw, ah, format)
            else {
                self.frame_transient.push(bd_atlas);
                continue;
            };

            if crate::vello::abi::debug_atlas() == 2 {
                self.dbg_atlas = Some((blur_view.clone(), aw, ah));
            }
            let mask_atlas = new_target_with_usage(device, aw, ah, format, self.raster_usage);
            let mask_view = mask_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(aw as u16, ah as u16);
            for cell in &packing.cells {
                let c = &cells[cell.index];
                let root_for_cell = Affine::translate((f64::from(cell.x), f64::from(cell.y)))
                    * Affine::scale(c.k)
                    * Affine::translate((-c.bdx, -c.bdy))
                    * root;
                backend.build_mask(&mut mscene, root_for_cell, plan.gathers[c.gi].shape);
            }
            if stages & 4 != 0 {
                backend.rasterize(&mscene, device, queue, enc, &mask_view, aw, ah, CLEAR);
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
        let chain: Vec<(crate::model::EffectSlot, String, Vec<f32>, u32)> =
            crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map(|n| {
                    n.spread_effects()
                        .map(|(slot, c)| (slot, c.wgsl.clone(), c.params.clone(), c.param_vec4s))
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
        for (slot, wgsl, params, param_vec4s) in chain {
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
                lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline))
            };
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&input_view], &passes, w, h, format,
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
            &self.compositor, &self.glass, device, enc, &[&input_view], &passes, w, h, format,
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
                    self.glass.clamp_fill(device, enc, &filled_view, &bd_view, (w as f32, h as f32), rect);
                    if let Some(old) = self.surfaces.insert(write_to, Surface { texture: filled, view: filled_view, width: w, height: h }) {
                        self.frame_transient.push(old.texture);
                    }
                }
            }
        }
    }

    /// Assemble a gather effect's result once (cached under the bumped ref) via [`run_graph`], then
    /// stamp it into `write_to`'s tile — through the shape's silhouette mask for background blur, or
    /// its device rect for glass (whose SDF mask is baked into the composite). The shape's own body
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

        let is_glass = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.glass.is_some()));
        let is_custom = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));

        let result_ref = backdrop.bump();
        let mask_ref = backdrop.bump().bump();
        if !self.surfaces.contains_key(&result_ref) {
            let passes = if is_glass {
                self.glass_graph(id, bw, bh, bdx, bdy, full_view, k)
            } else if is_custom {
                self.custom_graph(id, bw, bh, device, format)
            } else {
                let graph = effect_graph::background_blur_graph(self.gather_sigma(id, full_view, k));
                Some(lower_graph(&graph, None))
            };
            let Some(passes) = passes else { return };
            Self::submit_batch(enc, device, queue, backend);
            let backdrop_view = self.surfaces[&backdrop].view.clone();
            let mut genc = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("inline gather graph") });
            let out = run_graph_into(
                &self.compositor, &self.glass, device, &mut genc, &[&backdrop_view], &passes, bw, bh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            queue.submit([genc.finish()]);
                let Some((tex, view)) = out else { return };
            self.surfaces.insert(result_ref, Surface { texture: tex, view, width: bw, height: bh });

            if !is_glass {
                let mask = new_target_with_usage(device, bw, bh, format, self.raster_usage);
                let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
                let root_for_mask = Affine::scale(k) * Affine::translate((-bdx, -bdy)) * root;
                let mut mscene = backend.new_scene(bw as u16, bh as u16);
                backend.build_mask(&mut mscene, root_for_mask, id);
                backend.rasterize(&mscene, device, queue, enc, &mask_view, bw, bh, CLEAR);
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
        if is_glass {
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
                &self.compositor, &self.glass, device, enc, &[&sil_view], &passes, w, h, format,
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
                &self.compositor, &self.glass, device, enc, &[&punch_view], &passes, w, h, format,
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

    /// Build the glass pass-graph over the assembled backdrop (input 0). The geometry→uniform math is
    /// render-core's [`effect_graph::glass_graph`]; this only reads the shape's glass params/box off
    /// the live scene and lowers the neutral graph (no custom pass, so no pipeline to resolve). Glass
    /// geometry is the shape's rounded box (axis-aligned; rotation is a gap); the composite's own SDF
    /// mask does the clip, so no silhouette mask is needed.
    fn glass_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, geom) = crate::vello::abi::with_scene(|live, _, modifiers| {
            live.get(id).and_then(|n| {
                n.glass.map(|g| {
                    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let page = crate::schedule::page_bounds(n, m);
                    let [a, b, c, d, _, _] = (m * n.effective_transform()).as_coeffs();
                    let scale = ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0;
                    let geom = GlassGeometry {
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
        let graph = effect_graph::glass_graph_scaled(&g, geom, (bw, bh), (bdx, bdy), full_view, k);
        Some(lower_graph(&graph, None))
    }

    /// Build the custom-shader graph: one custom pass over the assembled backdrop (input 0). The
    /// neutral graph is render-core's [`effect_graph::custom_graph`]; this resolves the shape's
    /// pipeline (compiled once per distinct WGSL source, cached by hash) and lowers with it. The
    /// uniform is the backdrop resolution followed by the shader's declared params.
    fn custom_graph(&mut self, id: u128, bw: u32, bh: u32, device: &wgpu::Device, format: wgpu::TextureFormat) -> Option<Vec<Pass>> {
        let (wgsl, params, param_vec4s) = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .and_then(|n| n.gather_shader().map(|c| (c.wgsl.clone(), c.params.clone(), c.param_vec4s)))
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
        Some(lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline)))
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

    /// The tint reaches the composite through admission, so the colour cannot be looked up one way
    /// by the batch and another way by the fallback.
    #[test]
    fn a_stamp_carries_its_tint_out_of_admission() {
        let Some(BatchShape::Stamp { tint, sigma, .. }) = admit(&drop_shadow_graph(64.0, 64.0, C, 4.0))
        else {
            panic!("a drop shadow is a stamp")
        };
        assert_eq!(tint, Some(C));
        assert!(sigma > 0.0, "a blurred drop shadow keeps its sigma");
    }

    /// An empty chain is still a stamp — the cell rides the blur stages as a sigma-0 copy so every
    /// batched cell lands in the surface the later stages sample.
    #[test]
    fn an_empty_chain_is_an_untinted_stamp() {
        assert_eq!(
            admit(&[]),
            Some(BatchShape::Stamp { sigma: 0.0, linear: false, tint: None })
        );
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
        use crate::vello::glass::UnitOp;
        use crate::vello::graph::{Pass, PassKind};
        let units = |ops: Vec<UnitOp>| Pass {
            kind: PassKind::Units {
                ops,
                field: std::rc::Rc::new(crate::field::FieldProgram {
                    nodes: Vec::new(),
                    outputs: Vec::new(),
                }),
            },
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
