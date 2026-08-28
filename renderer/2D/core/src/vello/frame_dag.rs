//! Frame value-DAG (Phase C) — the explicit, whole-frame dependency graph, where every node *is* the
//! operation it runs.
//!
//! Today the render order is split across three mechanisms: the tree walk linearises shapes into a
//! draw stream (z-order = array index), per-effect [`crate::effect_graph`] DAGs describe a single
//! effect's passes, and the whole-viewport scheduler (`wv_rounds` + the shadow/stack maps) infers a
//! round order from reach-rectangle overlap. This module builds ONE graph that owns all of it.
//!
//! The point is a *single path*, not a faithful copy of the per-effect ones. Every effect — drop
//! shadow, inner shadow, glass, layer blur, background blur — decomposes into the SAME small alphabet
//! of primitives ([`Op`]): rasterize, blur, sample, erase, custom, reload, compose. There is no
//! "drop path" or "glass path": a frost *is* a blur, a silhouette *is* a rasterize, a lens warp *is* a
//! sample. A node carries its `op` and its `target` (scratch atlas vs. the frame accumulator) — which
//! is exactly a runnable stage (`reads` + `target` + `work`) — and the old node *kind* is a derived
//! view ([`Node::category`]), never a stored tag.
//!
//! Leaves stay coarse: a run of plain shapes is ONE rasterize band, not a node per shape — the tiled
//! rasterizer still owns the per-shape compositing inside a band. Rendering the graph for inspection
//! (Mermaid) lives in the dev harness (`webgpu-vello/examples/frame_dag_dump.rs`), not here.

use crate::kurbo::Rect;

use crate::effect::{effect_stack, Compose, Op as EffectOp};
use crate::model::Scene;
use crate::vello::plan::Target;
use crate::vello::units::UnitOp;

/// The frame's operation alphabet is [`UnitOp`] — the SAME enum the executor runs, so a DAG node *is*
/// the operation, with no separate scheduler alphabet to translate through. A node carries one atomic
/// unit; a fine arm is a *fused run* of them ([`crate::vello::units::fuse`]). The structural ops
/// (`Rasterize`/`Reload`/`Compose`) express the frame's dependency + barrier structure; the fragment
/// units (`Warp`/`Blur`/`Scatter`/`EraseBy`/`Shade`/`MaskMix`/`Tint`/`Custom`) are the shader math. A
/// separable blur is TWO positional `UnitOp::Blur` nodes (X then Y reading it); the schedule puts Y one
/// barrier after X and `bake` assigns the axis from position. The device GPU uniform is computed by
/// `bake` at draw time (it needs the viewport); the DAG carries structure alone.

/// Where a node's concrete work comes from in the scene — the thread the *executor* follows to build
/// the actual GPU pass (geometry to rasterize, effect config to bake into the uniform). The scheduler
/// never reads it; it exists only so `frame_exec`'s dispatch can resolve an [`Op`] to real work
/// without re-deriving anything.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// The page background fill.
    Background,
    /// A coalesced run of plain shapes — rasterize their fills, in order.
    Band(Vec<u128>),
    /// The shape's own body (plain fills / text).
    Body(u128),
    /// A pass belonging to one entry of a shape's effect stack: `shape`'s `effect_stack()[slot]`. The
    /// `Op` says which pass within that effect (rasterize the source, blur it, compose it); `slot` says
    /// which effect — so a drop's colour and an inner's colour never get confused.
    Effect { shape: u128, slot: usize },
}

/// The coarse role of a node, DERIVED from its `op` and `target` — a view for display and queries, not
/// a stored tag. (The scheduler branches on `op`/`target`, never on this.)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Category {
    /// The page background — the first accumulator value (a rasterize with no inputs).
    Background,
    /// A spine rasterize that writes the accumulator: a paint band or a shape body.
    Paint,
    /// A scratch value: any op writing an atlas (silhouette, blur, sample, erase, custom).
    Draft,
    /// The accumulator snapshot a gather samples.
    Reload,
    /// A source-over onto the accumulator.
    Compose,
}

/// One operation in the frame graph. `inputs` are the indices of the nodes whose output this reads;
/// `op` is the primitive it runs; `target` is where its output lives (a scratch atlas, or the frame
/// accumulator — the spine). Together `(inputs, op, target)` is a runnable stage.
#[derive(Clone, Debug)]
pub struct Node {
    pub op: UnitOp,
    pub target: Target,
    /// Back-reference to the scene work this runs — read only by the executor, never the scheduler.
    pub source: Source,
    /// A human-readable name for the dev dump — display only, never branched on.
    pub label: String,
    /// Page-space footprint, for the region-scoped accumulator and tile-vs-footprint barrier test.
    /// `None` for a whole-frame node (the background).
    pub reach: Option<Rect>,
    pub inputs: Vec<usize>,
}

impl Node {
    /// The node's coarse role, derived from `op` + `target` + whether it has inputs.
    #[must_use]
    pub fn category(&self) -> Category {
        match self.op {
            UnitOp::Reload => Category::Reload,
            UnitOp::Compose => Category::Compose,
            UnitOp::Rasterize if self.target == Target::Accumulator => {
                if self.inputs.is_empty() {
                    Category::Background
                } else {
                    Category::Paint
                }
            }
            _ => Category::Draft,
        }
    }

    /// Writes the frame accumulator (a spine node) rather than a scratch atlas.
    #[must_use]
    pub fn writes_accumulator(&self) -> bool {
        self.target == Target::Accumulator
    }
}

/// The whole-frame value-DAG: a flat, topologically-buildable node list (a node only ever cites
/// earlier indices, so the vector order is already a valid topological order).
#[derive(Clone, Debug, Default)]
pub struct FrameDag {
    pub nodes: Vec<Node>,
}

/// The on-chip tile edge in page units. A gather whose source fits inside one tile blurs entirely
/// within a workgroup (no cross-tile read → no barrier); a larger source spans workgroups and must
/// materialize. Matches the fine-pass 16×16 tile.
pub const TILE_PX: f64 = 16.0;

/// The reason a node opens a new round — the only two things that force a GPU-wide barrier (a
/// dispatch boundary). Everything else folds into a neighbouring pass.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Barrier {
    /// A gather reads a freshly-computed draft over a neighbourhood, so that draft must be flushed to
    /// VRAM and its producing dispatch must finish first.
    Materialize,
    /// A gather reads the composited accumulator (the backdrop), so every layer below it must have
    /// composited to VRAM before this dispatch can sample it.
    Reload,
}

/// The barrier-aware schedule: each node's round, where a round is one dispatch and consecutive rounds
/// are one barrier apart.
pub struct Schedule {
    /// `round[i]` — the dispatch node `i` runs in.
    pub round: Vec<u32>,
    /// `barrier[i]` — set when node `i` opens its round across a barrier edge (why it could not fold
    /// into an earlier one); `None` when it shares its inputs' round.
    pub barrier: Vec<Option<Barrier>>,
}

impl Schedule {
    /// Round count = one past the deepest round.
    #[must_use]
    pub fn rounds(&self) -> u32 {
        self.round.iter().copied().max().unwrap_or(0) + 1
    }
}

/// One effect pass, ready for `draw_effect_marker`: the shape it belongs to, which effect slot, the
/// round it runs in, its footprint, and the primitive. The Sink maps `(op, gid, slot)` to the
/// `effect_id` and bakes the unit uniform — the single per-op step this stream does not carry.
#[derive(Clone, Debug, PartialEq)]
pub struct EffectMarker {
    pub gid: u128,
    pub slot: usize,
    pub round: u32,
    pub reach: Option<Rect>,
    pub op: UnitOp,
}

impl FrameDag {
    /// The NAIVE topological depth: `0` for a leaf, else `1 + max(input round)` — a barrier at *every*
    /// edge. The upper bound the real scheduler improves on (it folds the composite spine, which
    /// carries no barrier). Kept only as the baseline to compare [`Self::schedule`] against.
    #[must_use]
    pub fn levels(&self) -> Vec<u32> {
        let mut lv = vec![0u32; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            lv[i] = n.inputs.iter().map(|&j| lv[j] + 1).max().unwrap_or(0);
        }
        lv
    }

    /// Does reading `from`'s output inside `to` require a barrier? The whole schedule reduces to this
    /// predicate, over `op` alone. Two — and only two — edges carry one:
    /// * `to` is a [`UnitOp::Reload`] → the accumulator must flush before it can be sampled (`Reload`).
    /// * `to` is a gather over a *freshly-computed* source that spans tiles → that source must
    ///   materialize first (`Materialize`). A gather over a reload is free (already resident); a gather
    ///   over a source that fits one tile blurs on-chip.
    ///
    /// Every other edge — the composite spine, a body reading the accumulator, a pointwise pass — is
    /// same-tile, same-dispatch and folds.
    fn edge_barrier(&self, from: usize, to: usize, tile: f64) -> Option<Barrier> {
        let (src, dst) = (&self.nodes[from], &self.nodes[to]);
        if dst.op == UnitOp::Reload {
            return Some(Barrier::Reload);
        }
        if dst.op.is_gather() && src.op != UnitOp::Reload {
            let on_chip = src.reach.is_some_and(|r| r.width() <= tile && r.height() <= tile);
            if !on_chip {
                return Some(Barrier::Materialize);
            }
        }
        None
    }

    /// The barrier-aware round of every node: `round[i] = max_j( round[j] + [edge j→i is a barrier] )`.
    /// One forward pass, since nodes are pre-sorted. Nodes sharing a round run in one dispatch (the
    /// composite spine folds into a single fine pass); a new round appears only across a materialize or
    /// a reload. `tile` is the on-chip tile edge (use [`TILE_PX`]).
    #[must_use]
    pub fn schedule(&self, tile: f64) -> Schedule {
        let mut round = vec![0u32; self.nodes.len()];
        let mut barrier = vec![None; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            for &j in &n.inputs {
                let b = self.edge_barrier(j, i, tile);
                let r = round[j] + u32::from(b.is_some());
                if r > round[i] {
                    round[i] = r;
                    barrier[i] = b;
                }
            }
        }
        Schedule { round, barrier }
    }

    /// The uniform effect-marker stream — ONE emission that replaces the four per-effect-type marker
    /// builders (`wv_rounds`, `wv_shadow_plan`/`schedule_shadows`, `stack_markers`, `fx_markers`) and
    /// the scaffolding they need to reconcile (`ShadowMarker`/`ShadowRole`/`WindowRole`, the
    /// pre-round/span math). Every effect pass — a gather (blur/sample/erase/custom), a backdrop
    /// reload, or an effect composite — becomes one marker carrying its `gid`, its `round` (straight
    /// from [`Self::schedule`]), its page-space `reach`, and its `op`. The Sink turns `(op, gid)` into
    /// the `effect_id` + the baked unit uniform (the one irreducible, per-op step) and calls
    /// `draw_effect_marker`; there is no per-type builder and no window-role reconciliation left.
    #[must_use]
    pub fn effect_markers(&self, tile: f64) -> Vec<EffectMarker> {
        let sched = self.schedule(tile);
        self.nodes
            .iter()
            .enumerate()
            .filter_map(|(i, n)| {
                let Source::Effect { shape, slot } = n.source else { return None };
                // The passes that become CMD_EFFECT markers: gathers, the reload, the effect composite,
                // and the pointwise fragment units that fuse into an arm. A rasterized silhouette is
                // scene coverage, not a marker.
                let is_marker = !matches!(n.op, UnitOp::Rasterize);
                is_marker.then_some(EffectMarker {
                    gid: shape,
                    slot,
                    round: sched.round[i],
                    reach: n.reach,
                    op: n.op.clone(),
                })
            })
            .collect()
    }

    /// The fine arms for one shape, straight from the schedule — the direct schedule→`fine` wire, with
    /// no per-effect planner in the middle. Partition this shape's effect nodes by their scheduled round
    /// (the round-partition IS the fuse cut — a barrier bumps the round, so units sharing a round are
    /// exactly one fused arm); each round whose fragment run the scheduler has FILLED becomes one
    /// 26-float descriptor ([`crate::vello::bake::arm_descriptor`]), its policy derived structurally from
    /// that round's own nodes. Returns `None` when any round is not yet DAG-drivable — a unit whose
    /// device uniform [`Self::fill_lens_uniforms`] has not stamped, or a `Blur`/`Custom` whose
    /// axis/params the arm grouping does not assign yet — so the caller falls back to the planner for
    /// that shape. Today SHARP glass drives through here byte-identically with the planner; the seam
    /// widens as the scheduler grows to fill more units.
    #[must_use]
    pub fn arms_for(&self, gid: u128, tile: f64) -> Option<Vec<[f32; 26]>> {
        use crate::vello::bake::{arm_descriptor, Policy};
        use std::collections::BTreeMap;
        // Shape-level gate: a lens HEAD together with a BLUR is frosted glass — 4 arms in the DAG vs the
        // 5 current `fine` expects, so it is not byte-reproducible here and stays on the planner. Pure
        // glass (a head, no blur) and pure background blur (a blur, no head) each reproduce their planner
        // descriptors exactly, so both flow through.
        let (mut has_head, mut has_blur) = (false, false);
        for n in self.nodes.iter().filter(|n| matches!(n.source, Source::Effect { shape, .. } if shape == gid)) {
            match n.op {
                UnitOp::Warp(_) | UnitOp::Scatter(_) => has_head = true,
                UnitOp::Blur { .. } => has_blur = true,
                _ => {}
            }
        }
        if has_head && has_blur {
            return None;
        }
        let sched = self.schedule(tile);
        let mut by_round: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
        for (i, n) in self.nodes.iter().enumerate() {
            if matches!(n.source, Source::Effect { shape, .. } if shape == gid) {
                by_round.entry(sched.round[i]).or_default().push(i);
            }
        }
        if by_round.is_empty() {
            return None;
        }
        let mut arms = Vec::new();
        let mut blur_axis = 0u32; // 0 → the first (X) blur pass of this effect, 1 → the second (Y)
        for (_round, idxs) in by_round {
            let run: Vec<UnitOp> = idxs.iter().map(|&i| self.nodes[i].op.clone()).filter(|op| !op.is_structural()).collect();
            match run.as_slice() {
                [] => continue, // a reload-only round carries no arm of its own
                // One axis pass of a separable blur. In the fx_fine wire the materialize (H → draft) and
                // masked composite (V) are driven by the emitter's round layout, NOT descriptor bits, so
                // the arm is axis + device sigma only: bits BLUR (+SRGB when it mixes in gamma space).
                // `units_uniform` skips `Blur`, so `u[0]` (slots 2..5) is written here; the axis comes
                // from the pass ordinal (the DAG's two positional Blur nodes, X before Y).
                [UnitOp::Blur { sigma, linear }] => {
                    arms.push(crate::vello::bake::blur_arm(*sigma, *linear, blur_axis != 0, Policy::default(), None));
                    blur_axis += 1;
                }
                // A fused fragment run (glass = Warp+Shade+MaskMix). Drivable only where every unit is a
                // FILLED fragment (a non-empty device uniform the scheduler stamped); an unfilled
                // placeholder means this effect is not on the DAG wire yet → bail to the planner.
                _ => {
                    if !run.iter().all(is_filled_fragment) {
                        return None;
                    }
                    arms.push(arm_descriptor(&run, Policy::default(), None));
                }
            }
        }
        (!arms.is_empty()).then_some(arms)
    }

    /// Fill each background-blur node's DEVICE sigma — the blur half of the scheduler's viewport pass,
    /// the sibling to [`Self::fill_lens_uniforms`]. For every `Source::Effect` `Blur` node whose shape
    /// `sigma_of` resolves (a pure background blur; the caller returns `None` for a frost blur so it
    /// stays page-space and falls back), replace the page-radius sigma with the device sigma. `arms_for`
    /// then reads it straight into the axis pass's `u[0].z`.
    pub fn fill_blur_uniforms(&mut self, sigma_of: impl Fn(u128) -> Option<f32>) {
        for node in &mut self.nodes {
            let Source::Effect { shape, .. } = node.source else { continue };
            if let UnitOp::Blur { linear, .. } = node.op {
                if let Some(sigma) = sigma_of(shape) {
                    node.op = UnitOp::Blur { sigma, linear };
                }
            }
        }
    }

    /// Elide every `Blur` whose device sigma is negligible (< 0.5 px) — a sub-pixel blur is visually a
    /// no-op, so its consumers are rewired to read the blur's own input instead, and the blur node is left
    /// an orphan (no consumer → no scheduled pass). This is the SCHEDULER's per-frame simplification that
    /// dissolves the sharp-vs-soft-shadow split: a "sharp" shadow is just a soft one whose blur elided, so
    /// its composite's edge lands on the silhouette and it flows through the SAME edge-driven dispatch — no
    /// separate lane. Run AFTER the sigma fills (the sigmas must be device-space). Node indices are
    /// preserved (orphans stay in place), so anything holding an index stays valid.
    pub fn elide_negligible_blurs(&mut self) {
        for i in 0..self.nodes.len() {
            let UnitOp::Blur { sigma, .. } = self.nodes[i].op else { continue };
            if sigma >= 0.5 {
                continue;
            }
            let Some(&src) = self.nodes[i].inputs.first() else { continue };
            for n in &mut self.nodes {
                for inp in &mut n.inputs {
                    if *inp == i {
                        *inp = src;
                    }
                }
            }
        }
    }

    /// Fill a drop shadow's device uniforms — the shadow half of the viewport pass. For every
    /// `Source::Effect` node on a shadow slot, stamp the device sigma into its `Blur` (`sigma_of(shape,
    /// slot)`) and the straight colour into its `Tint` (`tint_of(shape, slot)`, packed as the vec's first
    /// four floats). `Sink::wv_shadow_plan_dag` then reads sigma/colour straight from the filled nodes. A
    /// node whose closure returns `None` (a non-shadow blur/tint) is left as-is.
    pub fn fill_shadow_uniforms(
        &mut self,
        sigma_of: impl Fn(u128, usize) -> Option<f32>,
        tint_of: impl Fn(u128, usize) -> Option<[f32; 4]>,
    ) {
        for node in &mut self.nodes {
            let Source::Effect { shape, slot } = node.source else { continue };
            match node.op {
                UnitOp::Blur { linear, .. } => {
                    if let Some(sigma) = sigma_of(shape, slot) {
                        node.op = UnitOp::Blur { sigma, linear };
                    }
                }
                UnitOp::Tint(_) => {
                    if let Some(c) = tint_of(shape, slot) {
                        node.op = UnitOp::Tint(c.to_vec());
                    }
                }
                _ => {}
            }
        }
    }

    /// Fill each glass unit node's device uniform — the scheduler's viewport pass, the one non-trivial
    /// "baking". For every `Source::Effect` node whose shape carries glass, compute the device field
    /// ([`crate::effect_graph::lens_device_field`] at the whole viewport, origin 0, k=1) and stamp each
    /// unit's own slots onto it: warp's chromatic aberration, scatter's frost, shade's specular. The
    /// caller supplies `geom_of` (it holds the scene + modifiers); frame_dag stays decoupled from the
    /// host types. After this the units carry exactly what the descriptor needs — no separate `bake`.
    pub fn fill_lens_uniforms(
        &mut self,
        viewport: crate::kurbo::Affine,
        w: u32,
        h: u32,
        geom_of: impl Fn(u128) -> Option<(crate::model::Glass, crate::effect_graph::LensGeometry)>,
    ) {
        for node in &mut self.nodes {
            let Source::Effect { shape, .. } = node.source else { continue };
            let Some((g, geom)) = geom_of(shape) else { continue };
            let base = crate::effect_graph::lens_device_field(&g, geom, (w, h), (0.0, 0.0), viewport, 1.0);
            node.op = match &node.op {
                UnitOp::Warp(_) => {
                    let mut u = base.to_vec();
                    u[17] = g.chromatic_aberration;
                    UnitOp::Warp(u)
                }
                UnitOp::Scatter(_) => {
                    let mut u = base.to_vec();
                    u[18] = g.frost;
                    UnitOp::Scatter(u)
                }
                UnitOp::Shade(_) => {
                    let mut u = base.to_vec();
                    u[19] = g.specular_opacity;
                    u[20] = g.specular_saturation;
                    UnitOp::Shade(u)
                }
                UnitOp::MaskMix(_) => UnitOp::MaskMix(base.to_vec()),
                other => other.clone(),
            };
        }
    }

    /// Project each node to the allocator's stage IR ([`crate::vello::plan::StageSpec`]) — the same
    /// object, with the `op` erased, so `colour_stages` / `pack_groups` can place the scratch atlases.
    /// `target` is the node's own; an input is a [`Input::Value`] when its producer wrote an atlas,
    /// else the [`Input::External`] accumulator.
    #[must_use]
    pub fn to_stage_specs(&self) -> Vec<crate::vello::plan::StageSpec> {
        use crate::vello::plan::{Input, StageSpec, ValueId};
        self.nodes
            .iter()
            .map(|n| {
                let reads = n
                    .inputs
                    .iter()
                    .map(|&j| {
                        if self.nodes[j].writes_accumulator() {
                            Input::External(0)
                        } else {
                            Input::Value(ValueId(j))
                        }
                    })
                    .collect();
                StageSpec { reads, target: n.target }
            })
            .collect()
    }
}

/// A fragment unit the scheduler has already stamped with its device uniform — the arm-drivable ones.
/// A sampling head or pointwise tail whose uniform `Vec` is non-empty; `Blur`/`Custom` carry no fused
/// uniform (their axis/params are assigned by arm grouping, not here) and structural ops never fuse, so
/// both read as not-yet-drivable — the gate [`FrameDag::arms_for`] falls back on.
fn is_filled_fragment(op: &UnitOp) -> bool {
    matches!(
        op,
        UnitOp::Warp(u)
            | UnitOp::Scatter(u)
            | UnitOp::Shade(u)
            | UnitOp::MaskMix(u)
            | UnitOp::ClipToSource(u)
            | UnitOp::EraseBy(u)
            | UnitOp::Tint(u) if !u.is_empty()
    )
}

/// Does region `a` overlap region `b`? `None` is the whole frame, which overlaps everything. Two
/// finite rects overlap only with positive area — touching edges do not, and since reach rects already
/// include the 3σ blur halo, genuinely-interacting effects have overlapping rects.
fn overlaps(a: Option<Rect>, b: Option<Rect>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x.x0 < y.x1 && y.x0 < x.x1 && x.y0 < y.y1 && y.y0 < x.y1,
        _ => true,
    }
}

/// Does region `outer` fully contain `inner`? The whole frame contains everything; a finite region
/// never contains the whole frame.
fn covers(outer: Option<Rect>, inner: Option<Rect>) -> bool {
    match (outer, inner) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(o), Some(i)) => o.x0 <= i.x0 && o.y0 <= i.y0 && o.x1 >= i.x1 && o.y1 >= i.y1,
    }
}

/// The region-scoped accumulator: the frontier of spine writers, each tagged with the region it last
/// wrote (`None` = whole frame). A new spine node reads every writer its footprint overlaps, then
/// supersedes the ones it fully covers. So two disjoint effects never depend on each other — only
/// overlapping ones keep a z-order edge — and no edge is lost, because a covered writer is always an
/// input of the node that replaced it (the dependency survives transitively).
#[derive(Default)]
struct Accumulator {
    writers: Vec<(Option<Rect>, usize)>,
}

impl Accumulator {
    fn readers(&self, reach: Option<Rect>) -> Vec<usize> {
        self.writers.iter().filter(|(r, _)| overlaps(*r, reach)).map(|&(_, n)| n).collect()
    }

    fn write(&mut self, reach: Option<Rect>, node: usize) {
        self.writers.retain(|&(r, _)| !covers(reach, r));
        self.writers.push((reach, node));
    }
}

/// A pending run of plain shapes waiting to coalesce into one rasterize band. Carries the union of
/// their bounds so the band's `reach` is its real footprint — not the whole frame — which keeps
/// disjoint bands (e.g. a per-cell background behind each effect) from re-chaining the whole frontier,
/// and the shape ids so the executor can rasterize them.
#[derive(Default)]
struct Band {
    ids: Vec<u128>,
    bounds: Option<Rect>,
}

impl Band {
    fn push(&mut self, id: u128, r: Rect) {
        self.ids.push(id);
        self.bounds = Some(self.bounds.map_or(r, |b| b.union(r)));
    }
    fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
    fn take(&mut self) -> Vec<u128> {
        self.bounds = None;
        std::mem::take(&mut self.ids)
    }
}

struct Builder {
    dag: FrameDag,
    /// The region-scoped spine frontier — the last writer of each region (see [`Accumulator`]).
    acc: Accumulator,
    /// Per-effect-node counter, for readable labels (`s1`, `s2`, …).
    fx_no: u32,
    /// The source every subsequent `push` stamps onto its node — set once per effect/body/band so the
    /// individual op emitters don't each thread it.
    cur: Source,
}

impl Builder {
    fn push(&mut self, op: UnitOp, target: Target, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        let id = self.dag.nodes.len();
        let source = self.cur.clone();
        self.dag.nodes.push(Node { op, target, source, label, reach, inputs });
        id
    }

    /// A scratch draft: writes an atlas, reads its predecessors (or nothing, for a source).
    fn draft(&mut self, op: UnitOp, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        self.push(op, Target::Atlas, label, reach, inputs)
    }

    /// A pointwise fragment unit (an empty-uniform structural placeholder — `bake` computes the device
    /// uniform). Reads `cur` (and any extra input, e.g. a mask-mix backdrop or an erase punch).
    fn pointwise(&mut self, op: UnitOp, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        self.draft(op, label, reach, inputs)
    }

    /// Lower a separable Gaussian to its two axis passes as two positional [`UnitOp::Blur`] nodes: X
    /// reads `cur`, Y reads X. The schedule puts Y one barrier after X (it gathers a fresh draft); `bake`
    /// assigns the axis from position. Returns the Y tail.
    fn blur(&mut self, radius: f32, linear: bool, cur: usize, reach: Option<Rect>, name: &str, tag: &str) -> usize {
        let x = self.draft(UnitOp::Blur { sigma: radius, linear }, format!("{name} {tag} blur-X r{radius:.0}"), reach, vec![cur]);
        self.draft(UnitOp::Blur { sigma: radius, linear }, format!("{name} {tag} blur-Y r{radius:.0}"), reach, vec![x])
    }

    /// Coalesce a pending run of plain shapes into ONE rasterize band on the spine, scoped to their
    /// union bounds so it only chains with effects it actually overlaps.
    fn flush_band(&mut self, band: &mut Band) {
        if band.is_empty() {
            return;
        }
        let reach = band.bounds;
        let label = format!("paint band · {} shape(s)", band.ids.len());
        let inputs = self.acc.readers(reach);
        self.cur = Source::Band(band.take());
        let id = self.push(UnitOp::Rasterize, Target::Accumulator, label, reach, inputs);
        self.acc.write(reach, id);
        self.cur = Source::Background;
    }

    /// Lower a chain of effect ops onto a starting value, emitting the atomic units each decomposes to —
    /// NO pointwise gets folded away: a lens emits `Warp` (+ `Blur`/`Scatter` for frost) then explicit
    /// `Shade` + `MaskMix` nodes; a shadow tint emits a `Tint` node; a background blur emits `Blur` (+
    /// `MaskMix`). `fuse` recombines the adjacent ones into fine arms at bake time, so the DAG carries the
    /// exact units the executor runs and `bake` never re-derives them. `linear` selects the blur's light
    /// space. Returns the chain tail. (Inner-shadow erase is a two-input op handled by the caller.)
    fn lower_ops(&mut self, ops: &[EffectOp], start: usize, reach: Option<Rect>, name: &str, tag: &str, linear: bool) -> usize {
        let mut cur = start;
        for op in ops {
            cur = match op {
                EffectOp::Blur { radius } => self.blur(*radius, linear, cur, reach, name, tag),
                EffectOp::EraseBy { blur, .. } => {
                    // The punch is a blurred copy of the silhouette; the erase is the pointwise dst-out
                    // of `cur` by it. Two units, not one bundled `Erase` — the same Blur every effect uses.
                    let punch = self.blur(*blur, linear, cur, reach, name, "punch");
                    self.pointwise(UnitOp::EraseBy(Vec::new()), format!("{name} {tag} erase"), reach, vec![cur, punch])
                }
                EffectOp::Lens(g) => {
                    // Lens is warp (+ blur → scatter for frost) then the pointwise shade + mask-mix, all
                    // explicit. `fuse` folds sharp glass to one arm ([Warp,Shade,MaskMix]) and frost to
                    // four ([Warp][BlurH][BlurV][Scatter,Shade,MaskMix]).
                    let warp = self.draft(UnitOp::Warp(Vec::new()), format!("{name} lens warp"), reach, vec![cur]);
                    let head = if g.total_blur_sigma() > 0.5 {
                        let blurred = self.blur(g.total_blur_sigma(), false, warp, reach, name, "frost");
                        self.draft(UnitOp::Scatter(Vec::new()), format!("{name} lens scatter"), reach, vec![blurred])
                    } else {
                        warp
                    };
                    let shaded = self.pointwise(UnitOp::Shade(Vec::new()), format!("{name} lens shade"), reach, vec![head]);
                    self.pointwise(UnitOp::MaskMix(Vec::new()), format!("{name} lens mask-mix"), reach, vec![shaded])
                }
                EffectOp::Shader(_) => self.draft(
                    UnitOp::Custom { u: Vec::new(), param_vec4s: 0, reach: 0.0, reads_backdrop: true },
                    format!("{name} custom pass"),
                    reach,
                    vec![cur],
                ),
                EffectOp::Tint(_) => self.pointwise(UnitOp::Tint(Vec::new()), format!("{name} {tag} tint"), reach, vec![cur]),
                EffectOp::Offset(_) => cur, // geometry — baked into which silhouette is rasterized, no unit
            };
        }
        cur
    }

    /// Lower one effect-bearing node's whole stack onto the spine, in paint order: drops under the
    /// body, the body, a gather through the coverage, inners over. Each effect is `rasterize/reload
    /// source → units → compose`, differing only in where it sits and whether it reloads.
    fn lower_effect_node(&mut self, shape: u128, node: &crate::model::Node) {
        self.fx_no += 1;
        let name = format!("s{}", self.fx_no);
        let base = node.bounds;
        let stack = effect_stack(node);
        let has_replace = stack.iter().any(|e| e.compose == Compose::Replace);
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();

        let mut body_done = false;
        for (slot, e) in stack.iter().enumerate() {
            if !body_done && e.compose != Compose::Under {
                self.emit_body(shape, base, has_replace, has_paint, &name);
                body_done = true;
            }
            let reach = Some(e.footprint(base));
            self.cur = Source::Effect { shape, slot };
            let tail = match e.compose {
                // An inner shadow is a two-coverage op — flood MINUS an offset+blurred punch. Both are
                // plain `Rasterize` nodes (the flood is the shape's UNOFFSET coverage — for a Text that
                // is its glyphs, drawn by the silhouette rasterizer), so there is no back-sampling
                // special case: the erase reads the flood and the blurred punch directly.
                Compose::Over => {
                    let flood = self.draft(UnitOp::Rasterize, format!("{name} inner flood"), reach, vec![]);
                    let punch_sil = self.draft(UnitOp::Rasterize, format!("{name} inner punch silhouette"), reach, vec![]);
                    let blur = e.ops.iter().find_map(|o| match o {
                        EffectOp::EraseBy { blur, .. } => Some(*blur),
                        EffectOp::Blur { radius } => Some(*radius),
                        _ => None,
                    });
                    let punch = match blur {
                        Some(r) if r > 0.5 => self.blur(r, false, punch_sil, reach, &name, "punch"),
                        _ => punch_sil,
                    };
                    let band = self.pointwise(UnitOp::EraseBy(Vec::new()), format!("{name} inner band"), reach, vec![flood, punch]);
                    self.pointwise(UnitOp::Tint(Vec::new()), format!("{name} inner tint"), reach, vec![band])
                }
                Compose::Under => {
                    let sil = self.draft(UnitOp::Rasterize, format!("{name} drop silhouette"), reach, vec![]);
                    self.lower_ops(&e.ops, sil, reach, &name, "drop", false)
                }
                Compose::Replace => {
                    let sil = self.draft(UnitOp::Rasterize, format!("{name} body-read"), reach, vec![]);
                    self.lower_ops(&e.ops, sil, reach, &name, "body", false)
                }
                Compose::ThroughCoverage => {
                    let reads = self.acc.readers(reach);
                    let reload = self.draft(UnitOp::Reload, format!("{name} read backdrop"), reach, reads);
                    // A background blur mixes in linear light; a lens (its own Blur) mixes in sRGB.
                    let linear = e.ops.iter().any(|o| matches!(o, EffectOp::Blur { .. }));
                    self.lower_ops(&e.ops, reload, reach, &name, "gather", linear)
                }
            };
            self.compose(format!("{name} → acc"), reach, tail);
            self.cur = Source::Background;
        }
        if !body_done {
            self.emit_body(shape, base, has_replace, has_paint, &name);
        }
    }

    /// Emit the shape's own body (plain fills/text) onto the spine — unless a Replace effect replaces
    /// it, or it has no paint.
    fn emit_body(&mut self, shape: u128, base: Rect, has_replace: bool, has_paint: bool, name: &str) {
        if has_replace || !has_paint {
            return;
        }
        let reach = Some(base);
        let inputs = self.acc.readers(reach);
        self.cur = Source::Body(shape);
        let id = self.push(UnitOp::Rasterize, Target::Accumulator, format!("{name} body"), reach, inputs);
        self.acc.write(reach, id);
        self.cur = Source::Background;
    }

    /// Land an effect result (`tail`) onto the region-scoped accumulator: read the writers `reach`
    /// overlaps, add the chain tail, emit the compose, and make it the new writer for `reach`.
    fn compose(&mut self, label: String, reach: Option<Rect>, tail: usize) {
        let mut inputs = self.acc.readers(reach);
        inputs.push(tail);
        let id = self.push(UnitOp::Compose, Target::Accumulator, label, reach, inputs);
        self.acc.write(reach, id);
    }

    fn walk(&mut self, scene: &Scene, id: u128, band: &mut Band) {
        let Some(node) = scene.get(id) else { return };
        if node.hidden {
            return;
        }
        let has_effects = !effect_stack(node).is_empty();
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();
        if !has_effects && node.kind.is_container() {
            // A plain group: its children carry the real paints — recurse.
            for &child in &node.children {
                self.walk(scene, child, band);
            }
            return;
        }
        if !has_effects {
            // A plain leaf shape → coalesce into the pending rasterize band (id + bounds).
            if has_paint {
                band.push(id, node.bounds);
            }
            return;
        }
        // An effect-bearing node breaks the band: flush it, then lower the effects. (v1 treats an
        // effect node as a leaf — nested children of an effect node are a follow-up.)
        self.flush_band(band);
        self.lower_effect_node(id, node);
    }
}

/// Build the whole-frame value-DAG for an installed [`Scene`]. Walks the roots in z-order, threading
/// the region-scoped accumulator; plain shapes coalesce into rasterize bands, effect nodes lower their
/// stack into the shared primitive alphabet.
#[must_use]
pub fn build_frame_dag(scene: &Scene) -> FrameDag {
    let mut b = Builder { dag: FrameDag::default(), acc: Accumulator::default(), fx_no: 0, cur: Source::Background };
    let bg = b.push(UnitOp::Rasterize, Target::Accumulator, "BG".to_string(), None, vec![]);
    b.acc.write(None, bg);
    let mut band = Band::default();
    for &root in scene.roots() {
        b.walk(scene, root, &mut band);
    }
    b.flush_band(&mut band);
    b.dag
}

/// Convenience: build the DAG for the scene installed in the ABI thread-local.
#[must_use]
pub fn build_frame_dag_installed() -> FrameDag {
    crate::vello::abi::with_scene(|scene, _, _| build_frame_dag(scene))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every node cites only earlier indices, so the node vector is already a valid topological
    /// order — the invariant the whole design leans on (no separate sort, `levels()` is one forward
    /// pass).
    fn assert_topological(dag: &FrameDag) {
        for (i, n) in dag.nodes.iter().enumerate() {
            for &j in &n.inputs {
                assert!(j < i, "node {i} ({}) reads later node {j} — not topological", n.label);
            }
        }
    }

    fn count(dag: &FrameDag, c: Category) -> usize {
        dag.nodes.iter().filter(|n| n.category() == c).count()
    }

    #[test]
    fn combined_dag_is_well_formed() {
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        // Exactly one background, node 0, no inputs — the spine root.
        assert_eq!(count(&dag, Category::Background), 1);
        assert_eq!(dag.nodes[0].category(), Category::Background);
        assert!(dag.nodes[0].inputs.is_empty());
        // The scene has effects → drafts and composites, and no backdrop gather → no reloads.
        assert!(count(&dag, Category::Draft) > 0, "expected effect drafts");
        assert!(count(&dag, Category::Compose) > 0, "expected effect composites");
        assert_eq!(count(&dag, Category::Reload), 0);
        // Every compose reads the accumulator + the effect tail (>= 2 inputs).
        for n in dag.nodes.iter().filter(|n| n.category() == Category::Compose) {
            assert!(n.inputs.len() >= 2, "compose '{}' must read acc + tail", n.label);
        }
    }

    #[test]
    fn plain_shapes_coalesce_into_one_band() {
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        let bands = dag.nodes.iter().filter(|n| n.label.starts_with("paint band")).count();
        assert_eq!(bands, 1, "the checker ground must be ONE band");
        assert!(count(&dag, Category::Reload) > 0, "glass must read the backdrop");
    }

    #[test]
    fn schedule_collapses_the_naive_spine() {
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        let naive = dag.levels().iter().copied().max().unwrap() + 1;
        let real = dag.schedule(TILE_PX).rounds();
        assert!(real < naive, "barrier-aware schedule must beat naive ({real} vs {naive})");
        // silhouette(0) → blur-X(1) → blur-Y(2) → composite(2): a separable blur is two barriers, then
        // the whole spine folds into the last round.
        assert_eq!(real, 3, "combined collapses to two blur rounds + a fold round");
    }

    #[test]
    fn glass_reloads_drops_materialize() {
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX);

        assert!(
            sched.barrier.iter().any(|b| matches!(b, Some(Barrier::Reload))),
            "a glass gather must reload the backdrop",
        );
        assert!(
            sched.barrier.iter().any(|b| matches!(b, Some(Barrier::Materialize))),
            "a drop shadow's blur must materialize its silhouette",
        );
        let naive = dag.levels().iter().copied().max().unwrap() + 1;
        assert!(sched.rounds() < naive, "still beats naive on the stacked case");
    }

    #[test]
    fn disjoint_cells_do_not_serialise() {
        // 20-cell grid of independent effects, each behind its own background rect. Region-scoping the
        // accumulator keeps the round count at the depth of the deepest single cell — NOT the cell
        // count. (A whole-frame band would re-chain them and this would blow up.)
        crate::vello::abi::load_matrix_scene();
        let dag = build_frame_dag_installed();
        let rounds = dag.schedule(TILE_PX).rounds();
        // The deepest single cell ("everything": drop blur X/Y + bg-blur + inner) sets the count; it
        // must not grow with the 20 cells.
        assert!(rounds <= 8, "disjoint grid cells must not chain (got {rounds} rounds for 20 cells)");
    }

    #[test]
    fn every_node_resolves_to_real_scene_work() {
        // The executor follows `source` back to the scene; every node must point at work that exists —
        // a band's shape ids, a body's shape, or an effect slot that indexes a real effect stack.
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        assert_eq!(dag.nodes[0].source, Source::Background, "node 0 is the background");
        crate::vello::abi::with_scene(|scene, _, _| {
            for n in &dag.nodes {
                match &n.source {
                    Source::Background => {}
                    Source::Band(ids) => {
                        assert!(!ids.is_empty(), "a band names its shapes");
                        for id in ids {
                            assert!(scene.get(*id).is_some(), "band shape {id:x} is in the scene");
                        }
                    }
                    Source::Body(shape) => {
                        assert!(scene.get(*shape).is_some(), "body shape {shape:x} is in the scene");
                    }
                    Source::Effect { shape, slot } => {
                        let node = scene.get(*shape).expect("effect shape is in the scene");
                        assert!(
                            *slot < crate::effect::effect_stack(node).len(),
                            "slot {slot} indexes shape {shape:x}'s effect stack",
                        );
                    }
                }
            }
        });
    }

    #[test]
    fn effect_markers_are_uniform_and_scheduled() {
        // One emission for every effect, whatever its type: stack-glass's markers all carry a real
        // shape, a schedule round, and a footprint — no per-type builder, no window roles.
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();
        let markers = dag.effect_markers(TILE_PX);
        let sched = dag.schedule(TILE_PX);

        assert!(!markers.is_empty(), "glass emits markers");
        // Each glass layer contributes a reload + a warp. Two layers → two of each.
        assert_eq!(markers.iter().filter(|m| m.op == UnitOp::Reload).count(), 2);
        assert_eq!(markers.iter().filter(|m| matches!(m.op, UnitOp::Warp(_))).count(), 2);
        crate::vello::abi::with_scene(|scene, _, _| {
            for m in &markers {
                assert!(scene.get(m.gid).is_some(), "marker names a real shape");
                assert!(m.round < sched.rounds(), "marker round is within the schedule");
                assert!(m.reach.is_some(), "an effect marker has a footprint (for binning)");
            }
        });
        // A reload opens a later round than the drop blur it sits over — the schedule, not a window role.
        let reload_round = markers.iter().find(|m| m.op == UnitOp::Reload).unwrap().round;
        assert!(reload_round >= 1, "the backdrop reload runs after the drop materializes");
    }

    #[test]
    fn a_sharp_glass_dag_fills_and_serializes_to_the_descriptor() {
        // The whole scheduler→serialize pipeline on the real DAG: build the sharp-glass graph, let the
        // scheduler fill the lens units' device uniforms, and serialize the arm. It must produce the
        // shipping sharp-glass descriptor shape — bits 56, lens program, real (non-zero) device field.
        use crate::vello::bake::{arm_descriptor, Policy, PROGRAM_LENS};
        crate::vello::abi::load_stack_glass_scene(1, 0);
        let mut dag = build_frame_dag_installed();
        crate::vello::abi::with_scene(|scene, viewport, modifiers| {
            dag.fill_lens_uniforms(viewport, 400, 400, |id| {
                let n = scene.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(crate::kurbo::Affine::IDENTITY);
                crate::effect_graph::lens_geometry(n, m)
            });
        });
        // Sharp glass drops the scatter, so the fused arm is warp + shade + mask-mix, in order.
        let run: Vec<UnitOp> = dag
            .nodes
            .iter()
            .filter(|n| matches!(n.op, UnitOp::Warp(_) | UnitOp::Shade(_) | UnitOp::MaskMix(_)))
            .map(|n| n.op.clone())
            .collect();
        assert_eq!(run.len(), 3, "sharp glass = warp + shade + mask-mix");
        let d = arm_descriptor(&run, Policy::default(), None);
        assert_eq!(d[0], 56.0, "WARP|SHADE|MASKMIX");
        assert_eq!(d[1], PROGRAM_LENS);
        assert!(d[2] > 0.0 && d[3] > 0.0, "the device field was filled (backdrop resolution present)");
    }

    #[test]
    fn arms_for_reproduces_the_sharp_glass_arm() {
        // The direct schedule→fine wire on the real DAG: build sharp glass, fill the lens uniforms, and
        // let `arms_for` partition by round + serialize. It must yield exactly ONE arm — the fused
        // `[Warp, Shade, MaskMix]` round — carrying bits 56 (WARP|SHADE|MASKMIX) and the lens program,
        // the same descriptor the planner emits. This is what the emitter swap sources.
        use crate::vello::bake::PROGRAM_LENS;
        // The pure-glass grid — a shadow-less rounded rect carrying only a lens, the `FX_GATHER` shape
        // the `fx_fine`/`arms_for` wire actually drives (a stack-glass node also has a drop shadow, so
        // its shadow rounds are not yet fillable and it rides the planner).
        crate::vello::abi::load_glass_grid_scene(1, 0);
        let mut dag = build_frame_dag_installed();
        let gid = dag
            .nodes
            .iter()
            .find_map(|n| match n.source {
                Source::Effect { shape, .. } => Some(shape),
                _ => None,
            })
            .expect("the glass shape is an effect node");
        crate::vello::abi::with_scene(|scene, viewport, modifiers| {
            dag.fill_lens_uniforms(viewport, 400, 400, |id| {
                let n = scene.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(crate::kurbo::Affine::IDENTITY);
                crate::effect_graph::lens_geometry(n, m)
            });
        });
        let arms = dag.arms_for(gid, TILE_PX).expect("sharp glass drives through arms_for");
        assert_eq!(arms.len(), 1, "sharp glass is one fused arm");
        assert_eq!(arms[0][0], 56.0, "WARP|SHADE|MASKMIX");
        assert_eq!(arms[0][1], PROGRAM_LENS);
        assert!(arms[0][2] > 0.0 && arms[0][3] > 0.0, "the device field was filled");
    }

    #[test]
    fn arms_for_reproduces_the_background_blur_pair() {
        // A pure background blur drives through the SAME wire as glass: `arms_for` partitions it into
        // its two axis rounds and emits the emitter-driven pair the planner (`wv_fine_passes`) does —
        // both bits BLUR(64), axes (1,0) then (0,1), each carrying the filled device sigma in u[0].z.
        use crate::vello::bake::bits;
        crate::vello::abi::load_vpblur_scene(4, 8.0);
        let mut dag = build_frame_dag_installed();
        let gid = dag
            .nodes
            .iter()
            .find_map(|n| match n.source {
                Source::Effect { shape, .. } => Some(shape),
                _ => None,
            })
            .expect("the blurred shape is an effect node");
        dag.fill_blur_uniforms(|_| Some(3.0));
        let arms = dag.arms_for(gid, TILE_PX).expect("a pure background blur drives through arms_for");
        assert_eq!(arms.len(), 2, "separable blur = two axis passes");
        assert_eq!(arms[0][0], f64::from(bits::BLUR) as f32, "H pass is plain BLUR — materialize is emitter-driven");
        assert_eq!([arms[0][2], arms[0][3], arms[0][4]], [1.0, 0.0, 3.0], "H axis + device sigma");
        assert_eq!([arms[1][2], arms[1][3], arms[1][4]], [0.0, 1.0, 3.0], "V axis + device sigma");
    }

    #[test]
    fn stage_specs_are_executor_ready() {
        use crate::vello::plan::{atlases_needed, colour_stages, Target};
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();
        let specs = dag.to_stage_specs();

        assert_eq!(specs.len(), dag.nodes.len());
        let colours = colour_stages(&specs);
        // A3/A4: a blur reads its silhouette so it takes a different atlas, but disjoint drafts reuse
        // atlases — the frame-wide count stays a small constant, not one-per-draft.
        let atlases = atlases_needed(&colours);
        assert!((2..=4).contains(&atlases), "disjoint drafts must reuse atlases (got {atlases})");
        // Every spine node writes the accumulator and takes no atlas colour.
        for (i, n) in dag.nodes.iter().enumerate() {
            if n.writes_accumulator() {
                assert_eq!(specs[i].target, Target::Accumulator);
                assert!(colours[i].is_none(), "accumulator stage must not be coloured");
            }
        }
    }
}
