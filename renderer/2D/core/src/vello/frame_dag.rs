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

impl FrameDag {
    /// The topological depth (round) of every node: `0` for a leaf, else `1 + max(input round)`. Since
    /// a node only ever cites earlier indices, one forward pass suffices. This IS the schedule — nodes
    /// sharing a round have no dependency between them and can run together (different workgroups); a
    /// later region-aware pass would additionally split a round by reach so only disjoint ones batch.
    #[must_use]
    pub fn levels(&self) -> Vec<u32> {
        let mut lv = vec![0u32; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            lv[i] = n.inputs.iter().map(|&j| lv[j] + 1).max().unwrap_or(0);
        }
        lv
    }
}

struct Builder {
    dag: FrameDag,
    /// The node that wrote the current accumulator version (the spine tail).
    acc: Option<usize>,
    /// Per-effect-node counter, for readable labels (`s1`, `s2`, …).
    fx_no: u32,
}

impl Builder {
    fn push(&mut self, kind: NodeKind, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        let id = self.dag.nodes.len();
        self.dag.nodes.push(Node { kind, label, reach, inputs });
        id
    }

    /// Coalesce a pending run of plain shapes into ONE paint band on the spine.
    fn flush_band(&mut self, band: &mut Vec<String>) {
        if band.is_empty() {
            return;
        }
        let label = format!("paint band · {} shape(s)", band.len());
        let inputs = self.acc.into_iter().collect();
        let id = self.push(NodeKind::Paint, label, None, inputs);
        self.acc = Some(id);
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
                    let warp = self.push(NodeKind::Draft, format!("{name} lens warp"), reach, vec![cur]);
                    let mid = if g.total_blur_sigma() > 0.5 {
                        self.push(NodeKind::Draft, format!("{name} lens frost"), reach, vec![warp])
                    } else {
                        warp
                    };
                    self.push(NodeKind::Draft, format!("{name} lens shade"), reach, vec![mid])
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
            let acc = self.acc.into_iter().chain(std::iter::once(tail)).collect();
            self.acc = Some(self.push(NodeKind::Composite, format!("{name} drop → acc"), reach, acc));
        }

        // 2. The node's own body (plain fills/text), unless a Replace effect stands in for it.
        if !has_replace && has_paint {
            let acc = self.acc.into_iter().collect();
            self.acc = Some(self.push(NodeKind::Paint, format!("{name} body"), None, acc));
        }
        // 2b. Body-replacing effects (layer blur / body shader): read the node's own body, transform.
        for e in stack.iter().filter(|e| e.compose == Compose::Replace) {
            let reach = Some(e.footprint(base));
            let read = self.push(NodeKind::Draft, format!("{name} body-read"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "body");
            let acc = self.acc.into_iter().chain(std::iter::once(tail)).collect();
            self.acc = Some(self.push(NodeKind::Composite, format!("{name} body → acc"), reach, acc));
        }

        // 3. Backdrop gathers (ThroughCoverage) — materialize the accumulator, run the lens/blur,
        //    composite through the coverage over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::ThroughCoverage) {
            let reach = Some(e.footprint(base));
            let read_inputs = self.acc.into_iter().collect();
            let read = self.push(NodeKind::Backdrop, format!("{name} read backdrop"), reach, read_inputs);
            let tail = self.lower_ops(&e.ops, read, reach, &name, "gather");
            let acc = self.acc.into_iter().chain(std::iter::once(tail)).collect();
            self.acc = Some(self.push(NodeKind::Composite, format!("{name} gather → acc"), reach, acc));
        }

        // 4. Inner shadows (Over) — silhouette → punch → composite, over the body.
        for e in stack.iter().filter(|e| e.compose == Compose::Over) {
            let reach = Some(e.footprint(base));
            let sil = self.push(NodeKind::Draft, format!("{name} inner silhouette"), reach, vec![]);
            let tail = self.lower_ops(&e.ops, sil, reach, &name, "inner");
            let acc = self.acc.into_iter().chain(std::iter::once(tail)).collect();
            self.acc = Some(self.push(NodeKind::Composite, format!("{name} inner → acc"), reach, acc));
        }
    }

    fn walk(&mut self, scene: &Scene, id: u128, band: &mut Vec<String>) {
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
            // A plain leaf shape → coalesce into the pending paint band.
            if has_paint {
                band.push(format!("{id:x}"));
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
    let mut b = Builder { dag: FrameDag::default(), acc: None, fx_no: 0 };
    let bg = b.push(NodeKind::Background, "BG".to_string(), None, vec![]);
    b.acc = Some(bg);
    let mut band = Vec::new();
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
}
