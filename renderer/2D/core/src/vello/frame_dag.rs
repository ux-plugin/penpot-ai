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

/// The primitive an operation runs — the whole alphabet, shared by every effect. What distinguishes a
/// drop shadow from a glass card is *which* of these it emits and in what order, never a different
/// code path. Intrinsic (page-space) parameters that size the op live here; the GPU uniforms are baked
/// by the executor from the source effect, not stored (that would duplicate [`crate::effect_graph`]).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Op {
    /// Turn geometry into pixels — a plain-shape band, a shape's own body, or a coverage silhouette.
    /// One primitive; whether it writes the spine or a scratch source is the node's `target`, not a
    /// separate op.
    Rasterize,
    /// Snapshot the accumulator so a gather can sample the composited backdrop (the reload).
    Reload,
    /// A separable Gaussian of the given page-space radius. EVERY blur is this: drop, inner pre-blur,
    /// frost, layer, background.
    Blur { radius: f32 },
    /// A displaced / jittered read of the input — the lens sampling head (warp / scatter).
    Sample,
    /// Erase the input by a blurred copy of itself (dst-out) — the inner-shadow punch, nothing else.
    Erase { radius: f32 },
    /// A hand-written WGSL pass — the escape hatch.
    Custom,
    /// Source-over the chain tail onto the accumulator. Under / over / replace is z-order (the node's
    /// place on the spine), not a compose variant — the executor runs one blend.
    Compose,
}

impl Op {
    /// A gather reads its input at coordinates other than its own pixel (a neighbourhood or a
    /// displacement), so it can cross tiles — the property the barrier predicate turns on. `Reload` is
    /// its own barrier and handled separately; the rest are pointwise and fold.
    #[must_use]
    pub fn is_gather(self) -> bool {
        matches!(self, Op::Blur { .. } | Op::Sample | Op::Erase { .. } | Op::Custom)
    }
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
    pub op: Op,
    pub target: Target,
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
            Op::Reload => Category::Reload,
            Op::Compose => Category::Compose,
            Op::Rasterize if self.target == Target::Accumulator => {
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
    /// * `to` is a [`Op::Reload`] → the accumulator must flush before it can be sampled (`Reload`).
    /// * `to` is a gather over a *freshly-computed* source that spans tiles → that source must
    ///   materialize first (`Materialize`). A gather over a reload is free (already resident); a gather
    ///   over a source that fits one tile blurs on-chip.
    ///
    /// Every other edge — the composite spine, a body reading the accumulator, a pointwise pass — is
    /// same-tile, same-dispatch and folds.
    fn edge_barrier(&self, from: usize, to: usize, tile: f64) -> Option<Barrier> {
        let (src, dst) = (&self.nodes[from], &self.nodes[to]);
        if dst.op == Op::Reload {
            return Some(Barrier::Reload);
        }
        if dst.op.is_gather() && src.op != Op::Reload {
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
/// disjoint bands (e.g. a per-cell background behind each effect) from re-chaining the whole frontier.
#[derive(Default)]
struct Band {
    count: usize,
    bounds: Option<Rect>,
}

impl Band {
    fn push(&mut self, r: Rect) {
        self.count += 1;
        self.bounds = Some(self.bounds.map_or(r, |b| b.union(r)));
    }
    fn is_empty(&self) -> bool {
        self.count == 0
    }
    fn clear(&mut self) {
        self.count = 0;
        self.bounds = None;
    }
}

struct Builder {
    dag: FrameDag,
    /// The region-scoped spine frontier — the last writer of each region (see [`Accumulator`]).
    acc: Accumulator,
    /// Per-effect-node counter, for readable labels (`s1`, `s2`, …).
    fx_no: u32,
}

impl Builder {
    fn push(&mut self, op: Op, target: Target, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        let id = self.dag.nodes.len();
        self.dag.nodes.push(Node { op, target, label, reach, inputs });
        id
    }

    /// A scratch draft: writes an atlas, reads its single predecessor (or nothing, for a source).
    fn draft(&mut self, op: Op, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        self.push(op, Target::Atlas, label, reach, inputs)
    }

    /// Coalesce a pending run of plain shapes into ONE rasterize band on the spine, scoped to their
    /// union bounds so it only chains with effects it actually overlaps.
    fn flush_band(&mut self, band: &mut Band) {
        if band.is_empty() {
            return;
        }
        let label = format!("paint band · {} shape(s)", band.count);
        let reach = band.bounds;
        let inputs = self.acc.readers(reach);
        let id = self.push(Op::Rasterize, Target::Accumulator, label, reach, inputs);
        self.acc.write(reach, id);
        band.clear();
    }

    /// Lower a chain of effect ops onto a starting value, emitting one draft per real pass. Every
    /// effect uses the SAME mapping — blur→Blur, erase→Erase, lens→Sample(+Blur for frost),
    /// shader→Custom — so there is no per-effect path. Pointwise ops (tint, offset, lens shade) fold
    /// into the composite that consumes the tail. Returns the chain tail.
    fn lower_ops(&mut self, ops: &[EffectOp], start: usize, reach: Option<Rect>, name: &str, tag: &str) -> usize {
        let mut cur = start;
        for op in ops {
            cur = match op {
                EffectOp::Blur { radius } => {
                    self.draft(Op::Blur { radius: *radius }, format!("{name} {tag} blur r{radius:.0}"), reach, vec![cur])
                }
                EffectOp::EraseBy { blur, .. } => {
                    self.draft(Op::Erase { radius: *blur }, format!("{name} {tag} punch (erase r{blur:.0})"), reach, vec![cur])
                }
                EffectOp::Lens(g) => {
                    // warp is a Sample, frost is a Blur — the same primitives as everything else. The
                    // shade (pointwise fresnel/tint) folds into the composite, so it emits no node.
                    let warp = self.draft(Op::Sample, format!("{name} lens warp"), reach, vec![cur]);
                    let sigma = g.total_blur_sigma();
                    if sigma > 0.5 {
                        self.draft(Op::Blur { radius: sigma }, format!("{name} lens frost"), reach, vec![warp])
                    } else {
                        warp
                    }
                }
                EffectOp::Shader(_) => self.draft(Op::Custom, format!("{name} custom pass"), reach, vec![cur]),
                EffectOp::Tint(_) | EffectOp::Offset(_) => cur, // pointwise — folds into the composite
            };
        }
        cur
    }

    /// Lower one effect-bearing node's whole stack onto the spine, in paint order: drops under the
    /// body, the body, a gather through the coverage, inners over. Each effect is the identical shape —
    /// `rasterize/reload source → op drafts → compose(acc, tail)` — differing only in where it sits and
    /// whether it reloads.
    fn lower_effect_node(&mut self, node: &crate::model::Node) {
        self.fx_no += 1;
        let name = format!("s{}", self.fx_no);
        let base = node.bounds;
        let stack = effect_stack(node);
        let has_replace = stack.iter().any(|e| e.compose == Compose::Replace);
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();

        // 1. Drop shadows (Under) — rasterize silhouette → blur → compose, under the body.
        for e in stack.iter().filter(|e| e.compose == Compose::Under) {
            let reach = Some(e.footprint(base));
            let sil = self.draft(Op::Rasterize, format!("{name} drop silhouette"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, sil, reach, &name, "drop");
            self.compose(format!("{name} drop → acc"), reach, tail);
        }

        // 2. The node's own body (plain fills/text), unless a Replace effect stands in for it.
        if !has_replace && has_paint {
            let reach = Some(base);
            let inputs = self.acc.readers(reach);
            let id = self.push(Op::Rasterize, Target::Accumulator, format!("{name} body"), reach, inputs);
            self.acc.write(reach, id);
        }
        // 2b. Body-replacing effects (layer blur / body shader): rasterize the body into scratch, transform.
        for e in stack.iter().filter(|e| e.compose == Compose::Replace) {
            let reach = Some(e.footprint(base));
            let read = self.draft(Op::Rasterize, format!("{name} body-read"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "body");
            self.compose(format!("{name} body → acc"), reach, tail);
        }

        // 3. Backdrop gathers (ThroughCoverage) — reload the accumulator, run the lens/blur, compose
        //    through the coverage over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::ThroughCoverage) {
            let reach = Some(e.footprint(base));
            let read_inputs = self.acc.readers(reach);
            let read = self.draft(Op::Reload, format!("{name} read backdrop"), reach, read_inputs);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "gather");
            self.compose(format!("{name} gather → acc"), reach, tail);
        }

        // 4. Inner shadows (Over) — rasterize silhouette → punch → compose, over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::Over) {
            let reach = Some(e.footprint(base));
            let sil = self.draft(Op::Rasterize, format!("{name} inner silhouette"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, sil, reach, &name, "inner");
            self.compose(format!("{name} inner → acc"), reach, tail);
        }
    }

    /// Land an effect result (`tail`) onto the region-scoped accumulator: read the writers `reach`
    /// overlaps, add the chain tail, emit the compose, and make it the new writer for `reach`.
    fn compose(&mut self, label: String, reach: Option<Rect>, tail: usize) {
        let mut inputs = self.acc.readers(reach);
        inputs.push(tail);
        let id = self.push(Op::Compose, Target::Accumulator, label, reach, inputs);
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
            // A plain leaf shape → coalesce into the pending rasterize band (union its bounds).
            if has_paint {
                band.push(node.bounds);
            }
            return;
        }
        // An effect-bearing node breaks the band: flush it, then lower the effects. (v1 treats an
        // effect node as a leaf — nested children of an effect node are a follow-up.)
        self.flush_band(band);
        self.lower_effect_node(node);
    }
}

/// Build the whole-frame value-DAG for an installed [`Scene`]. Walks the roots in z-order, threading
/// the region-scoped accumulator; plain shapes coalesce into rasterize bands, effect nodes lower their
/// stack into the shared primitive alphabet.
#[must_use]
pub fn build_frame_dag(scene: &Scene) -> FrameDag {
    let mut b = Builder { dag: FrameDag::default(), acc: Accumulator::default(), fx_no: 0 };
    let bg = b.push(Op::Rasterize, Target::Accumulator, "BG".to_string(), None, vec![]);
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
        assert_eq!(real, 2, "combined collapses to a materialize round + a fold round");
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
        assert!(rounds <= 5, "disjoint grid cells must not chain (got {rounds} rounds for 20 cells)");
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
