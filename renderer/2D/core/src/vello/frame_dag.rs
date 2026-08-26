//! Frame value-DAG (Phase C spike) — the explicit, whole-frame dependency graph.
//!
//! Today the render order is split across three mechanisms: the tree walk linearises shapes into a
//! draw stream (z-order = array index), per-effect [`crate::effect_graph`] DAGs describe a single
//! effect's passes, and the whole-viewport scheduler (`wv_rounds` + the shadow/stack maps) infers a
//! round order from reach-rectangle overlap. This module builds ONE graph that owns all of it: every
//! operation — the background, a paint band of plain shapes, a shadow's silhouette/blur/composite, a
//! gather's backdrop-read/lens/composite — is a [`Node`], and edges are value dependencies (a node's
//! `inputs` are the nodes whose output it reads). The accumulator is threaded explicitly: each op that
//! writes it takes the previous writer as an input, so z-order is a spine of edges rather than an
//! implicit index.
//!
//! This first slice only GENERATES the graph; rendering it for inspection (Mermaid) lives out in the
//! dev harness (`webgpu-vello/examples/frame_dag_dump.rs`), not here — the library owns the model and
//! the schedule, not the visualization. Leaves stay coarse: a run of plain shapes is ONE `Paint` band
//! node, not a node per shape — the tiled rasterizer still owns the per-shape compositing inside a band.

use crate::kurbo::Rect;

use crate::effect::{effect_stack, Compose, Op};
use crate::model::Scene;

/// What an operation does to the frame. The accumulator-writing kinds (`Background`, `Paint`,
/// `Composite`) form the z-order spine; `Draft` and `Backdrop` are off-spine scratch the composites
/// read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeKind {
    /// The page background — the first accumulator version. A leaf.
    Background,
    /// A paint-band leaf (a coalesced run of plain shapes) or a shape's own body. Reads the
    /// accumulator, writes the next version. Its internals stay the display list.
    Paint,
    /// An off-accumulator scratch pass — a shadow silhouette, a blur, an inner-shadow punch, a lens
    /// link, a custom pass. A `Draft` with no inputs is a leaf that can be filled from the get-go.
    Draft,
    /// A materialize of the accumulator so a gather can sample it (the reload). Reads the accumulator
    /// but does not write it — its output is a value the gather's passes consume.
    Backdrop,
    /// Lands an effect result into the accumulator (a shadow under/over the body, a gather through the
    /// coverage). Reads the accumulator + the effect chain's tail; writes the next version.
    Composite,
}

/// One operation in the frame graph. `inputs` are the indices of the nodes whose output this reads
/// (the [`crate::effect_graph::Src`] idea, generalised to frame scope — every value is a node).
#[derive(Clone, Debug)]
pub struct Node {
    pub kind: NodeKind,
    pub label: String,
    /// Page-space footprint, for the region-aware batching a later topological schedule needs. `None`
    /// for nodes whose extent is the whole frame (the background, a paint band).
    pub reach: Option<Rect>,
    pub inputs: Vec<usize>,
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
    /// A gather (blur / punch / warp / frost) reads a freshly-computed draft over a neighbourhood, so
    /// that draft must be flushed to VRAM and its producing dispatch must finish first.
    Materialize,
    /// A gather reads the composited accumulator (the backdrop), so every layer below it must have
    /// composited to VRAM before this dispatch can sample it.
    Reload,
}

/// The barrier-aware schedule: each node's round, where a round is one dispatch and consecutive
/// rounds are one barrier apart.
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
    /// edge. This is the upper bound the real scheduler improves on (it serialises the composite
    /// spine, which carries no barrier). Kept only as the baseline to compare [`Self::schedule`]
    /// against; nothing executes it.
    #[must_use]
    pub fn levels(&self) -> Vec<u32> {
        let mut lv = vec![0u32; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            lv[i] = n.inputs.iter().map(|&j| lv[j] + 1).max().unwrap_or(0);
        }
        lv
    }

    /// Does reading `from`'s output inside `to` require a barrier? The whole schedule reduces to this
    /// predicate. Two — and only two — edges carry one:
    /// * `to` is a [`NodeKind::Backdrop`] → the accumulator must flush before it can be sampled
    ///   (`Reload`).
    /// * `to` is a gather (a `Draft` that reads an input) over a *freshly-computed* source that spans
    ///   tiles → that source must materialize first (`Materialize`). A gather over the backdrop is
    ///   free: the reload already made it resident. A gather over a source that fits one tile blurs
    ///   on-chip.
    ///
    /// Every other edge — the composite spine, a body reading the accumulator, a pointwise pass — is
    /// same-tile, same-dispatch and folds.
    fn edge_barrier(&self, from: usize, to: usize, tile: f64) -> Option<Barrier> {
        let (src, dst) = (&self.nodes[from], &self.nodes[to]);
        if dst.kind == NodeKind::Backdrop {
            return Some(Barrier::Reload);
        }
        let dst_gathers = dst.kind == NodeKind::Draft && !dst.inputs.is_empty();
        if dst_gathers && src.kind != NodeKind::Backdrop {
            let on_chip = src.reach.is_some_and(|r| r.width() <= tile && r.height() <= tile);
            if !on_chip {
                return Some(Barrier::Materialize);
            }
        }
        None
    }

    /// Lower the frame graph to the executor's stage IR ([`crate::vello::plan::StageSpec`]) — one
    /// stage per node, in schedule order (the node vector is already topologically sorted). A `Draft`
    /// or a `Backdrop` reload writes a scratch atlas; every spine node (`Background`, `Paint`,
    /// `Composite`) writes the frame accumulator. Each input references its producer by node index:
    /// a [`Input::Value`] when that producer wrote an atlas, else the [`Input::External`] accumulator.
    ///
    /// This is the Phase-4 bridge: it proves the whole-frame DAG produces plans the existing allocator
    /// ([`crate::vello::plan::colour_stages`] / [`crate::vello::plan::atlases_needed`]) can colour and
    /// pack, without the live executor being cut over yet.
    #[must_use]
    pub fn to_stage_specs(&self) -> Vec<crate::vello::plan::StageSpec> {
        use crate::vello::plan::{Input, StageSpec, Target, ValueId};
        let is_atlas = |k: NodeKind| matches!(k, NodeKind::Draft | NodeKind::Backdrop);
        self.nodes
            .iter()
            .map(|n| {
                let reads = n
                    .inputs
                    .iter()
                    .map(|&j| {
                        if is_atlas(self.nodes[j].kind) {
                            Input::Value(ValueId(j))
                        } else {
                            Input::External(0)
                        }
                    })
                    .collect();
                let target = if is_atlas(n.kind) { Target::Atlas } else { Target::Accumulator };
                StageSpec { reads, target }
            })
            .collect()
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
}

/// Does region `a` overlap region `b`? `None` is the whole frame, which overlaps everything. Two
/// finite rects overlap only with positive area — touching edges (a shared boundary) do not, and
/// since reach rects already include the 3σ blur halo, genuinely-interacting effects have
/// overlapping rects.
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
/// supersedes the writers it fully covers. So two disjoint effects never depend on each other — only
/// overlapping ones keep a z-order edge — and no edge is lost, because a covered writer is always an
/// input of the node that replaced it (the dependency survives transitively).
#[derive(Default)]
struct Accumulator {
    writers: Vec<(Option<Rect>, usize)>,
}

impl Accumulator {
    /// The current writers whose region overlaps `reach`, in paint order — the accumulator inputs a
    /// node reading region `reach` depends on.
    fn readers(&self, reach: Option<Rect>) -> Vec<usize> {
        self.writers.iter().filter(|(r, _)| overlaps(*r, reach)).map(|&(_, n)| n).collect()
    }

    /// Record `node` as the writer for `reach`, dropping every writer it fully covers.
    fn write(&mut self, reach: Option<Rect>, node: usize) {
        self.writers.retain(|&(r, _)| !covers(reach, r));
        self.writers.push((reach, node));
    }
}

/// A pending run of plain shapes waiting to coalesce into one paint band. Carries the union of their
/// bounds so the band's `reach` is its real footprint — not the whole frame — which keeps disjoint
/// bands (e.g. a per-cell background behind each effect) from re-chaining the whole frontier.
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
    fn push(&mut self, kind: NodeKind, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        let id = self.dag.nodes.len();
        self.dag.nodes.push(Node { kind, label, reach, inputs });
        id
    }

    /// Coalesce a pending run of plain shapes into ONE paint band on the spine, scoped to their
    /// union bounds so it only chains with effects it actually overlaps.
    fn flush_band(&mut self, band: &mut Band) {
        if band.is_empty() {
            return;
        }
        let label = format!("paint band · {} shape(s)", band.count);
        let reach = band.bounds;
        let inputs = self.acc.readers(reach);
        let id = self.push(NodeKind::Paint, label, reach, inputs);
        self.acc.write(reach, id);
        band.clear();
    }

    /// Lower a chain of ops onto a starting value, emitting one `Draft` per real pass (blur, punch,
    /// lens link, custom). Pointwise ops (tint, offset) fold into their neighbours — no node. Returns
    /// the chain tail.
    fn lower_ops(&mut self, ops: &[Op], start: usize, reach: Option<Rect>, name: &str, tag: &str) -> usize {
        let mut cur = start;
        for op in ops {
            cur = match op {
                Op::Blur { radius } => self.push(
                    NodeKind::Draft,
                    format!("{name} {tag} blur r{radius:.0}"),
                    reach,
                    vec![cur],
                ),
                Op::EraseBy { blur, .. } => self.push(
                    NodeKind::Draft,
                    format!("{name} {tag} punch (erase r{blur:.0})"),
                    reach,
                    vec![cur],
                ),
                Op::Lens(g) => {
                    // warp (displaced read) and frost (blur) are neighbourhood gathers → real drafts.
                    // The shade (per-pixel fresnel/tint) is pointwise → it folds into the composite,
                    // exactly like Tint, so it emits no node and every remaining draft is a gather.
                    let warp = self.push(NodeKind::Draft, format!("{name} lens warp"), reach, vec![cur]);
                    if g.total_blur_sigma() > 0.5 {
                        self.push(NodeKind::Draft, format!("{name} lens frost"), reach, vec![warp])
                    } else {
                        warp
                    }
                }
                Op::Shader(_) => self.push(NodeKind::Draft, format!("{name} custom pass"), reach, vec![cur]),
                Op::Tint(_) | Op::Offset(_) => cur, // pointwise — folds into the silhouette/composite
            };
        }
        cur
    }

    /// Lower one effect-bearing node's whole stack onto the spine, in paint order: drops under the
    /// body, the body, a gather through the coverage, inners over. Each effect is
    /// `source-draft → op drafts → composite(acc, tail)`.
    fn lower_effect_node(&mut self, node: &crate::model::Node) {
        self.fx_no += 1;
        let name = format!("s{}", self.fx_no);
        let base = node.bounds;
        let stack = effect_stack(node);
        let has_replace = stack.iter().any(|e| e.compose == Compose::Replace);
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();

        // 1. Drop shadows (Under) — silhouette → blur → composite, under the body.
        for e in stack.iter().filter(|e| e.compose == Compose::Under) {
            let reach = Some(e.footprint(base));
            let sil = self.push(NodeKind::Draft, format!("{name} drop silhouette"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, sil, reach, &name, "drop");
            self.compose(NodeKind::Composite, format!("{name} drop → acc"), reach, tail);
        }

        // 2. The node's own body (plain fills/text), unless a Replace effect stands in for it.
        if !has_replace && has_paint {
            let reach = Some(base);
            let inputs = self.acc.readers(reach);
            let id = self.push(NodeKind::Paint, format!("{name} body"), reach, inputs);
            self.acc.write(reach, id);
        }
        // 2b. Body-replacing effects (layer blur / body shader): read the node's own body, transform.
        for e in stack.iter().filter(|e| e.compose == Compose::Replace) {
            let reach = Some(e.footprint(base));
            let read = self.push(NodeKind::Draft, format!("{name} body-read"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "body");
            self.compose(NodeKind::Composite, format!("{name} body → acc"), reach, tail);
        }

        // 3. Backdrop gathers (ThroughCoverage) — materialize the accumulator, run the lens/blur,
        //    composite through the coverage over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::ThroughCoverage) {
            let reach = Some(e.footprint(base));
            let read_inputs = self.acc.readers(reach);
            let read = self.push(NodeKind::Backdrop, format!("{name} read backdrop"), reach, read_inputs);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "gather");
            self.compose(NodeKind::Composite, format!("{name} gather → acc"), reach, tail);
        }

        // 4. Inner shadows (Over) — silhouette → punch → composite, over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::Over) {
            let reach = Some(e.footprint(base));
            let sil = self.push(NodeKind::Draft, format!("{name} inner silhouette"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, sil, reach, &name, "inner");
            self.compose(NodeKind::Composite, format!("{name} inner → acc"), reach, tail);
        }
    }

    /// Land an effect result (`tail`) onto the region-scoped accumulator: read the writers `reach`
    /// overlaps, add the chain tail, emit the composite, and make it the new writer for `reach`.
    fn compose(&mut self, kind: NodeKind, label: String, reach: Option<Rect>, tail: usize) {
        let mut inputs = self.acc.readers(reach);
        inputs.push(tail);
        let id = self.push(kind, label, reach, inputs);
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
            // A plain leaf shape → coalesce into the pending paint band (union its bounds).
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
/// the accumulator spine; plain shapes coalesce into paint bands, effect nodes lower their stack.
#[must_use]
pub fn build_frame_dag(scene: &Scene) -> FrameDag {
    let mut b = Builder { dag: FrameDag::default(), acc: Accumulator::default(), fx_no: 0 };
    let bg = b.push(NodeKind::Background, "BG".to_string(), None, vec![]);
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
    /// pass). If a builder ever emits a forward/self edge this catches it.
    fn assert_topological(dag: &FrameDag) {
        for (i, n) in dag.nodes.iter().enumerate() {
            for &j in &n.inputs {
                assert!(j < i, "node {i} ({}) reads later node {j} — not topological", n.label);
            }
        }
    }

    fn kinds(dag: &FrameDag, k: NodeKind) -> usize {
        dag.nodes.iter().filter(|n| n.kind == k).count()
    }

    #[test]
    fn combined_dag_is_well_formed() {
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        // Exactly one background, and it is node 0 with no inputs (the spine root).
        assert_eq!(kinds(&dag, NodeKind::Background), 1);
        assert_eq!(dag.nodes[0].kind, NodeKind::Background);
        assert!(dag.nodes[0].inputs.is_empty());
        // The scene has effects, so the graph has drafts and composites.
        assert!(kinds(&dag, NodeKind::Draft) > 0, "expected effect drafts");
        assert!(kinds(&dag, NodeKind::Composite) > 0, "expected effect composites");
        // combined has no backdrop gather → no reload nodes.
        assert_eq!(kinds(&dag, NodeKind::Backdrop), 0);
        // Every composite reads the accumulator (>= 2 inputs: prev spine + effect tail).
        for n in dag.nodes.iter().filter(|n| n.kind == NodeKind::Composite) {
            assert!(n.inputs.len() >= 2, "composite '{}' must read acc + tail", n.label);
        }
    }

    #[test]
    fn plain_shapes_coalesce_into_one_band() {
        // stack-glass grounds on a 550-shape checker; it must collapse to a single paint band, not
        // 550 nodes — the coarse-leaf invariant.
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        let bands = dag.nodes.iter().filter(|n| n.label.starts_with("paint band")).count();
        assert_eq!(bands, 1, "the checker ground must be ONE band");
        // Glass reads the backdrop → at least one reload + gather composite.
        assert!(kinds(&dag, NodeKind::Backdrop) > 0, "glass must read the backdrop");
    }

    #[test]
    fn schedule_collapses_the_naive_spine() {
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        let naive = dag.levels().iter().copied().max().unwrap() + 1;
        let real = dag.schedule(TILE_PX).rounds();
        assert!(real < naive, "barrier-aware schedule must beat naive ({real} vs {naive})");
        // combined has no backdrop gather: one materialize round for the blurs/punches, then the whole
        // composite spine folds into a single fine pass → 2 rounds.
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
        // Stacked glass genuinely serialises (each layer reads the one below), but still far under the
        // naive per-edge count.
        let naive = dag.levels().iter().copied().max().unwrap() + 1;
        assert!(sched.rounds() < naive, "still beats naive on the stacked case");
    }

    #[test]
    fn disjoint_cells_do_not_serialise() {
        // The matrix is a 20-cell grid of independent effects, each behind its own background rect.
        // Region-scoping the accumulator must keep the round count at the depth of the deepest single
        // cell — NOT growing with the cell count. (A whole-frame paint band would re-chain them and
        // this would blow up.)
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

        // One stage per node, and the whole thing runs through the real allocator.
        assert_eq!(specs.len(), dag.nodes.len());
        let colours = colour_stages(&specs);
        // A3/A4: a blur reads its silhouette so it takes a different atlas, but disjoint drafts reuse
        // atlases — the frame-wide count stays a small constant, not one-per-draft.
        let atlases = atlases_needed(&colours);
        assert!(atlases >= 2, "a blur ping-pongs off its source → at least 2 atlases");
        assert!(atlases <= 4, "disjoint drafts must reuse atlases (got {atlases})");
        // The spine writes the accumulator; an accumulator stage takes no atlas colour.
        for (i, n) in dag.nodes.iter().enumerate() {
            if n.kind == NodeKind::Composite || n.kind == NodeKind::Background {
                assert_eq!(specs[i].target, Target::Accumulator);
                assert!(colours[i].is_none(), "accumulator stage must not be coloured");
            }
        }
    }
}
