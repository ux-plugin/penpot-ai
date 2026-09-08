//! The walk (piece graph P1) — off-frame piece emission over the [`FrameDag`].
//!
//! One pass in z order over escaping gathers. Everything it produces is a **piece**: an ordinary
//! DAG node computing one value over a rect domain, appended to the one [`FrameDag`] — the walk
//! never mutates what already exists (monotone). Per reader it records a **coverage set** (which
//! pieces serve which sub-rects of its need); coverage larger than one piece is planner
//! bookkeeping that finalize discharges with a combine — no multi-route machinery exists here or
//! anywhere downstream.
//!
//! The rules, from the plan (`docs/extension-graph-plan.md`):
//! * **Need is local.** At a tapping node the off-frame need is `(reach ∩ frame) ⊕ pad ∖ frame`,
//!   computed right there; a chain extends its input's rect by its own pad in passing (an
//!   instance's window may dip back in-frame — the priced pad-margin replay).
//! * **Never-cut-existing.** Minted pieces are immutable. A later reader reads overlaps as-is and
//!   mints only the uncovered remainder: rect subtraction (≤4 rects, widest horizontal slab
//!   first), tile round-out, then re-clip against the pieces already minted.
//! * **Sharing = same producer + overlapping domain, nothing else.**
//! * **Prefix / z.** A reader needs the accumulator *state* at its z. One shared
//!   [`fold_expressible`] predicate splits the writers below it: a fold-expressible writer gets a
//!   **step piece** over (writer reach ∩ need) — outside that window the state is unchanged and
//!   readers alias the lower state's pieces directly; every other writer is scene geometry the
//!   ground pieces simply re-draw.

use crate::kurbo::Rect;

use super::frame_dag::{FrameDag, Node, Source};
use super::plan::Target;
use super::units::UnitOp;

/// Tile edge for piece round-out, in device pixels — matches the fine pass tile and the region
/// grid's shelf alignment.
pub const PIECE_TILE: f64 = 16.0;

/// The shared prefix predicate: does spine writer `n`'s contribution admit the per-texel fold form
/// `state' = f(state)` given its materialized value inputs? True for every accumulator write that
/// lands a computed value (a `Compose`, a fused acc-writing `Blur` — their state access is the
/// own-texel `⊕`); false for `Rasterize` writers, whose contribution is scene geometry with no
/// materialized value to step — those are re-drawn into ground pieces instead. This same predicate
/// must decide the sink's run ranges at the swap: the Δ244 corruption class exists exactly when
/// the two disagree.
#[must_use]
pub fn fold_expressible(n: &Node) -> bool {
    n.writes_accumulator() && !matches!(n.op, UnitOp::Rasterize(_))
}

/// What a piece computes — its identity for the sharing rule. Two needs share a piece iff their
/// producers are EQUAL and their domains overlap; nothing else (no fingerprints, no epsilon).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Producer {
    /// Scene state built purely of raster writers: every spine `Rasterize` at index `≤ prefix`,
    /// re-drawn by the executor in one ground pass. `prefix` is the index of the highest raster
    /// spine writer included, so two readers separated only by fold-expressible writers share.
    Ground { prefix: usize },
    /// The state step across fold-expressible spine writer `writer` (a DAG node index): applies
    /// that writer's `⊕` over the window, reading the lower state and the writer's chain value.
    Step { writer: usize },
    /// An off-frame instance of chain node `of`: the same op over the piece's window, reading
    /// instance/state coverage where the frame draft would read frame values.
    Chain { of: usize },
}

/// One minted piece: the appended DAG node, what it computes, and its rounded device-space domain.
#[derive(Clone, Debug)]
pub struct Piece {
    pub node: usize,
    pub producer: Producer,
    pub rect: Rect,
}

/// One reader's coverage: for DAG node `reader`, the pieces serving each sub-rect of its off-frame
/// need. More than one entry is legal here — finalize turns multi-piece coverage into a combine so
/// every lowered mark ends with exactly ONE route.
#[derive(Clone, Debug)]
pub struct Cover {
    pub piece: usize,
    pub rect: Rect,
}

/// The walk's bookkeeping output. Pieces parallel the nodes appended to the dag; `coverage` maps
/// each off-frame-reading DAG node to the pieces that serve it.
#[derive(Debug, Default)]
pub struct Walk {
    pub pieces: Vec<Piece>,
    pub coverage: Vec<(usize, Vec<Cover>)>,
}

impl Walk {
    /// All coverage entries recorded for `reader`, flattened.
    #[must_use]
    pub fn covers_of(&self, reader: usize) -> Vec<&Cover> {
        self.coverage
            .iter()
            .filter(|(r, _)| *r == reader)
            .flat_map(|(_, cs)| cs.iter())
            .collect()
    }
}

fn degenerate(r: Rect) -> bool {
    !(r.x1 > r.x0 && r.y1 > r.y0)
        || !(r.x0.is_finite() && r.y0.is_finite() && r.x1.is_finite() && r.y1.is_finite())
}

/// `a ∖ b` as ≤4 rects, widest horizontal slab first: the full-width top and bottom slabs, then
/// the left and right rests of the middle band. The fixed order is the slab determinism rule — a
/// scene always yields the same pieces.
fn subtract(a: Rect, b: Rect) -> Vec<Rect> {
    let isect = a.intersect(b);
    if degenerate(isect) {
        return vec![a];
    }
    let mut out = Vec::with_capacity(4);
    if isect.y0 > a.y0 {
        out.push(Rect::new(a.x0, a.y0, a.x1, isect.y0));
    }
    if isect.y1 < a.y1 {
        out.push(Rect::new(a.x0, isect.y1, a.x1, a.y1));
    }
    if isect.x0 > a.x0 {
        out.push(Rect::new(a.x0, isect.y0, isect.x0, isect.y1));
    }
    if isect.x1 < a.x1 {
        out.push(Rect::new(isect.x1, isect.y0, a.x1, isect.y1));
    }
    out
}

fn subtract_all(rects: Vec<Rect>, cut: Rect) -> Vec<Rect> {
    rects
        .into_iter()
        .flat_map(|r| subtract(r, cut))
        .filter(|r| !degenerate(*r))
        .collect()
}

fn intersect_all(rects: &[Rect], win: Rect) -> Vec<Rect> {
    rects
        .iter()
        .map(|r| r.intersect(win))
        .filter(|r| !degenerate(*r))
        .collect()
}

fn round_out(r: Rect) -> Rect {
    let t = PIECE_TILE;
    Rect::new(
        (r.x0 / t).floor() * t,
        (r.y0 / t).floor() * t,
        (r.x1 / t).ceil() * t,
        (r.y1 / t).ceil() * t,
    )
}

/// The walking context: the dag being appended to, the fixed spine (accumulator writers in z
/// order), and the pieces minted so far.
struct Ctx<'a> {
    dag: &'a mut FrameDag,
    frame: Rect,
    spine: Vec<usize>,
    out: Walk,
}

impl Ctx<'_> {
    fn reach(&self, i: usize) -> Rect {
        self.dag.nodes[i].reach.unwrap_or(self.frame)
    }

    fn mint(&mut self, producer: Producer, rect: Rect, op: UnitOp, inputs: Vec<usize>) -> usize {
        let idx = self.dag.nodes.len();
        self.dag.nodes.push(Node {
            op,
            target: Target::Atlas,
            source: Source::Region(self.out.pieces.len()),
            label: format!("piece {producer:?} {rect:?}"),
            reach: Some(rect),
            pad: 0.0,
            inputs,
        });
        self.out.pieces.push(Piece { node: idx, producer, rect });
        self.out.pieces.len() - 1
    }

    /// Cover `rects` with pieces of `producer`, never cutting what exists: overlaps with already
    /// minted same-producer pieces are read as-is; the remainder is tile-rounded, re-clipped
    /// against those pieces, and minted via `mint_new` (which builds the piece's op + inputs for
    /// one rect). Returns the full coverage in deterministic order (existing overlaps in mint
    /// order, then new pieces in slab order).
    fn cover_with(
        &mut self,
        producer: Producer,
        rects: Vec<Rect>,
        mint_new: &mut dyn FnMut(&mut Self, Rect) -> (UnitOp, Vec<usize>),
    ) -> Vec<Cover> {
        let mut covers = Vec::new();
        let mut remainder: Vec<Rect> = rects.into_iter().filter(|r| !degenerate(*r)).collect();
        let existing: Vec<(usize, Rect)> = self
            .out
            .pieces
            .iter()
            .enumerate()
            .filter(|(_, p)| p.producer == producer)
            .map(|(i, p)| (i, p.rect))
            .collect();
        for (pi, pr) in &existing {
            let served = intersect_all(&remainder, *pr);
            for s in served {
                covers.push(Cover { piece: *pi, rect: s });
            }
            remainder = subtract_all(remainder, *pr);
        }
        for r in remainder {
            let mut news = vec![round_out(r)];
            for (_, pr) in &existing {
                news = subtract_all(news, *pr);
            }
            for nr in news {
                let (op, inputs) = mint_new(self, nr);
                let pi = self.mint(producer, nr, op, inputs);
                covers.push(Cover { piece: pi, rect: nr.intersect(r) });
            }
        }
        covers
    }

    /// Cover `rects` with the accumulator STATE below spine position `top` (exclusive). Scans the
    /// spine downward for the highest fold-expressible writer whose reach intersects; its window
    /// becomes step pieces (base = the state below it, chain = the writer's off-frame chain
    /// instance), the rest recurses past it — the alias partition, zero new pixels where nothing
    /// below changed. With no intersecting fold writer the state is pure scene raster: ground
    /// pieces re-draw it, identified by the highest raster spine writer below `top`.
    fn cover_state(&mut self, top: usize, rects: Vec<Rect>) -> Vec<Cover> {
        let rects: Vec<Rect> = rects.into_iter().filter(|r| !degenerate(*r)).collect();
        if rects.is_empty() {
            return Vec::new();
        }
        let fold_hit = (0..top).rev().find(|&s| {
            let w = self.spine[s];
            fold_expressible(&self.dag.nodes[w])
                && rects.iter().any(|r| !degenerate(r.intersect(self.reach(w))))
        });
        let Some(s) = fold_hit else {
            let prefix = (0..top)
                .rev()
                .map(|s| self.spine[s])
                .find(|&w| matches!(self.dag.nodes[w].op, UnitOp::Rasterize(_)))
                .unwrap_or(0);
            return self.cover_with(
                Producer::Ground { prefix },
                rects,
                &mut |_, _| (UnitOp::Rasterize(super::units::RasterSource::Body { offset: [0.0; 2] }), vec![]),
            );
        };
        let w = self.spine[s];
        let wreach = self.reach(w);
        let win = intersect_all(&rects, wreach);
        let rest = subtract_all(rects, wreach);
        let mut covers = self.cover_state(top, rest);
        let wop = self.dag.nodes[w].op.clone();
        let step_covers = self.cover_with(Producer::Step { writer: w }, win, &mut |ctx, r| {
            let base = ctx.cover_state(s, vec![r]);
            let chain = ctx.instantiate_chain(w, r);
            let mut inputs: Vec<usize> =
                base.iter().map(|c| ctx.out.pieces[c.piece].node).collect();
            inputs.extend(chain.iter().map(|c| ctx.out.pieces[c.piece].node));
            (wop.clone(), inputs)
        });
        covers.extend(step_covers);
        covers
    }

    /// Mint the off-frame instance of writer `w`'s chain over window `win`: the chain's final
    /// value node and, transitively (each level extending by its own pad — leaves first, so
    /// instance inputs never cite later nodes), every chain node below it down to the state read.
    /// Returns coverage by the FINAL chain value's instance piece — the step reads the full chain
    /// through it (X exists because Y's instance reads it).
    fn instantiate_chain(&mut self, w: usize, win: Rect) -> Vec<Cover> {
        let Some(&value) = self.chain_value_input(w) else {
            return Vec::new();
        };
        self.instantiate_value(value, vec![win])
    }

    fn chain_value_input(&self, w: usize) -> Option<&usize> {
        self.dag.nodes[w]
            .inputs
            .iter()
            .find(|&&j| !matches!(self.dag.nodes[j].op, UnitOp::Reload) && !self.is_piece(j))
    }

    fn is_piece(&self, node: usize) -> bool {
        self.out.pieces.iter().any(|p| p.node == node)
    }

    /// Instance coverage for chain node `v` over `rects`. A `Reload` resolves to state coverage at
    /// the reading component's z; a `Rasterize` source is scene-rooted (the executor re-draws it
    /// with the piece offset) and needs no piece; any other node mints `Chain` instance pieces
    /// whose inputs are the instance coverage of its own inputs over the pad-extended window.
    fn instantiate_value(&mut self, v: usize, rects: Vec<Rect>) -> Vec<Cover> {
        match self.dag.nodes[v].op {
            UnitOp::Reload => {
                let top = self.state_top_of(v);
                self.cover_state(top, rects)
            }
            UnitOp::Rasterize(_) => Vec::new(),
            _ => {
                let pad = f64::from(self.dag.nodes[v].pad);
                let vop = self.dag.nodes[v].op.clone();
                let vinputs = self.dag.nodes[v].inputs.clone();
                self.cover_with(Producer::Chain { of: v }, rects, &mut |ctx, r| {
                    let need = r.inflate(pad, pad);
                    let mut inputs = Vec::new();
                    for &j in &vinputs {
                        let covs = ctx.instantiate_value(j, vec![need]);
                        inputs.extend(covs.iter().map(|c| ctx.out.pieces[c.piece].node));
                    }
                    (vop.clone(), inputs)
                })
            }
        }
    }

    /// The spine position whose state a `Reload` at node `r` snapshots: the number of spine
    /// writers strictly below the reload's component's own accumulator write (every writer with a
    /// smaller node index).
    fn state_top_of(&self, r: usize) -> usize {
        self.spine.iter().take_while(|&&w| w < r).count()
    }
}

/// Run the walk: visit every escaping backdrop reader of `dag` in z order, mint pieces, record
/// coverage. Appends piece nodes to `dag` (never mutating existing nodes) and returns the
/// bookkeeping. `frame` is the device-space viewport rect.
#[must_use]
pub fn walk(dag: &mut FrameDag, frame: Rect) -> Walk {
    let spine: Vec<usize> = dag
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.writes_accumulator() && !matches!(n.source, Source::Region(_)))
        .map(|(i, _)| i)
        .collect();
    let n = dag.nodes.len();
    let mut ctx = Ctx { dag, frame, spine, out: Walk::default() };
    for i in 0..n {
        let (pad, structural, from_region) = {
            let node = &ctx.dag.nodes[i];
            (node.pad, node.op.is_structural(), matches!(node.source, Source::Region(_)))
        };
        if pad <= 0.0 || structural || from_region {
            continue;
        }
        let window = ctx.reach(i).intersect(frame);
        if degenerate(window) {
            continue;
        }
        let pad = f64::from(pad);
        let need = subtract_all(vec![window.inflate(pad, pad)], frame);
        if need.is_empty() {
            continue;
        }
        let inputs = ctx.dag.nodes[i].inputs.clone();
        for &j in &inputs {
            if ctx.is_piece(j) {
                continue;
            }
            let covers = ctx.instantiate_value(j, need.clone());
            if !covers.is_empty() {
                ctx.out.coverage.push((i, covers));
            }
        }
    }
    ctx.out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::units::{BlurAxis, BlurEdge, ComposeMode, RasterSource};

    fn raster_body(reach: Rect) -> Node {
        Node {
            op: UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }),
            target: Target::Accumulator,
            source: Source::Body(1),
            label: "art".into(),
            reach: Some(reach),
            pad: 0.0,
            inputs: vec![],
        }
    }

    fn effect_node(
        shape: u128,
        op: UnitOp,
        target: Target,
        reach: Rect,
        pad: f32,
        inputs: Vec<usize>,
    ) -> Node {
        Node {
            op,
            target,
            source: Source::Effect { shape, slot: 0 },
            label: format!("fx{shape}"),
            reach: Some(reach),
            pad,
            inputs,
        }
    }

    /// One background-blur gather: Reload → BlurX → BlurY → Compose, σ pad `pad`, window `reach`.
    /// Returns (reload, compose) node indices.
    fn push_bgblur(dag: &mut FrameDag, shape: u128, reach: Rect, pad: f32) -> (usize, usize) {
        let r = dag.nodes.len();
        dag.nodes.push(effect_node(shape, UnitOp::Reload, Target::Atlas, reach, 0.0, vec![]));
        let x = dag.nodes.len();
        dag.nodes.push(effect_node(
            shape,
            UnitOp::Blur { sigma: 8.0, linear: false, axis: BlurAxis::X, edge: BlurEdge::Backdrop },
            Target::Atlas,
            reach,
            pad,
            vec![r],
        ));
        let y = dag.nodes.len();
        dag.nodes.push(effect_node(
            shape,
            UnitOp::Blur { sigma: 8.0, linear: false, axis: BlurAxis::Y, edge: BlurEdge::Backdrop },
            Target::Atlas,
            reach,
            pad,
            vec![x],
        ));
        let c = dag.nodes.len();
        dag.nodes.push(effect_node(
            shape,
            UnitOp::Compose { mode: ComposeMode::Over, colour: None },
            Target::Accumulator,
            reach,
            0.0,
            vec![r, y],
        ));
        (r, c)
    }

    /// One warp gather (single-tap head, no chain): Reload → Warp → Compose, slack pad `pad`.
    fn push_warp(dag: &mut FrameDag, shape: u128, reach: Rect, pad: f32) -> (usize, usize) {
        let r = dag.nodes.len();
        dag.nodes.push(effect_node(shape, UnitOp::Reload, Target::Atlas, reach, 0.0, vec![]));
        let g = dag.nodes.len();
        dag.nodes.push(effect_node(shape, UnitOp::Warp(vec![]), Target::Atlas, reach, pad, vec![r]));
        let c = dag.nodes.len();
        dag.nodes.push(effect_node(
            shape,
            UnitOp::Compose { mode: ComposeMode::Over, colour: None },
            Target::Accumulator,
            reach,
            0.0,
            vec![r, g],
        ));
        (r, c)
    }

    const FRAME: Rect = Rect { x0: 0.0, y0: 0.0, x1: 640.0, y1: 480.0 };

    fn base_dag() -> FrameDag {
        let mut dag = FrameDag::default();
        dag.nodes.push(raster_body(Rect::new(-160.0, 0.0, 320.0, 640.0)));
        dag
    }

    #[test]
    fn l_shaped_cut_is_two_slabs_widest_first() {
        let mut dag = base_dag();
        push_warp(&mut dag, 7, Rect::new(0.0, 380.0, 120.0, 480.0), 32.0);
        let w = walk(&mut dag, FRAME);
        let grounds: Vec<&Piece> = w
            .pieces
            .iter()
            .filter(|p| matches!(p.producer, Producer::Ground { .. }))
            .collect();
        assert_eq!(grounds.len(), 2, "an L off the bottom-left corner cuts into two pieces");
        let bottom = grounds.iter().find(|p| p.rect.y0 >= FRAME.y1).expect("bottom slab");
        let left = grounds.iter().find(|p| p.rect.x1 <= FRAME.x0).expect("left column");
        assert!(
            bottom.rect.width() >= left.rect.width(),
            "widest horizontal slab first: bottom {:?} vs left {:?}",
            bottom.rect,
            left.rect
        );
        assert!(bottom.rect.x0 % PIECE_TILE == 0.0 && bottom.rect.y1 % PIECE_TILE == 0.0);
    }

    #[test]
    fn first_come_keeps_whole() {
        let mut dag = base_dag();
        push_bgblur(&mut dag, 7, Rect::new(0.0, 380.0, 120.0, 480.0), 32.0);
        push_bgblur(&mut dag, 8, Rect::new(0.0, 200.0, 100.0, 420.0), 32.0);
        let w = walk(&mut dag, FRAME);
        let first_rects: Vec<Rect> = {
            let mut d2 = base_dag();
            push_bgblur(&mut d2, 7, Rect::new(0.0, 380.0, 120.0, 480.0), 32.0);
            walk(&mut d2, FRAME).pieces.iter().map(|p| p.rect).collect()
        };
        for r in &first_rects {
            assert!(
                w.pieces.iter().any(|p| p.rect == *r),
                "piece {r:?} minted by the first gather must survive uncut"
            );
        }
        for (a, pa) in w.pieces.iter().enumerate() {
            for pb in w.pieces.iter().skip(a + 1) {
                if pa.producer == pb.producer {
                    assert!(
                        degenerate(pa.rect.intersect(pb.rect)),
                        "same-producer pieces must be pairwise disjoint: {:?} vs {:?}",
                        pa.rect,
                        pb.rect
                    );
                }
            }
        }
    }

    #[test]
    fn same_producer_overlap_aliases() {
        let mut dag = base_dag();
        let (_, _c) = push_bgblur(&mut dag, 7, Rect::new(400.0, 380.0, 520.0, 480.0), 32.0);
        push_bgblur(&mut dag, 8, Rect::new(0.0, 200.0, 100.0, 420.0), 32.0);
        let w = walk(&mut dag, FRAME);
        let g8_reload = 5;
        let covers = w.covers_of(g8_reload + 1);
        assert!(!covers.is_empty(), "the second gather's X blur reads state coverage");
        for c in &covers {
            assert!(
                matches!(w.pieces[c.piece].producer, Producer::Ground { .. }),
                "away from the first writer's reach the second gather aliases GROUND pieces, got {:?}",
                w.pieces[c.piece].producer
            );
        }
    }

    #[test]
    fn step_window_at_writer_reach() {
        let mut dag = base_dag();
        let wreach = Rect::new(-40.0, 380.0, 120.0, 520.0);
        let (_, wc) = push_bgblur(&mut dag, 7, wreach, 32.0);
        push_bgblur(&mut dag, 8, Rect::new(0.0, 300.0, 100.0, 460.0), 32.0);
        let w = walk(&mut dag, FRAME);
        let steps: Vec<&Piece> = w
            .pieces
            .iter()
            .filter(|p| matches!(p.producer, Producer::Step { writer } if writer == wc))
            .collect();
        assert!(!steps.is_empty(), "the second gather's need dips into W's reach → step piece");
        for s in &steps {
            let win = round_out(wreach);
            assert!(
                s.rect.x0 >= win.x0 - PIECE_TILE
                    && s.rect.y0 >= win.y0 - PIECE_TILE
                    && s.rect.x1 <= win.x1 + PIECE_TILE
                    && s.rect.y1 <= win.y1 + PIECE_TILE,
                "step window {:?} must sit at (reach ∩ need) rounded out, reach {wreach:?}",
                s.rect
            );
            let node = &dag.nodes[s.node];
            assert!(
                matches!(node.op, UnitOp::Compose { .. }),
                "a step piece carries the writer's own ⊕ op"
            );
            assert!(!node.inputs.is_empty(), "a step reads base state + the writer's chain");
            let has_chain = node.inputs.iter().any(|&j| {
                w.pieces
                    .iter()
                    .any(|p| p.node == j && matches!(p.producer, Producer::Chain { .. }))
            });
            assert!(has_chain, "the step reads the writer's chain instance (full chain rule)");
        }
        let chain_pieces = w
            .pieces
            .iter()
            .filter(|p| matches!(p.producer, Producer::Chain { .. }))
            .count();
        assert!(chain_pieces >= 2, "instances for BOTH blur axes (X and Y), got {chain_pieces}");
    }

    #[test]
    fn slab_determinism() {
        let build = || {
            let mut dag = base_dag();
            push_bgblur(&mut dag, 7, Rect::new(0.0, 380.0, 120.0, 480.0), 32.0);
            push_bgblur(&mut dag, 8, Rect::new(0.0, 300.0, 100.0, 460.0), 32.0);
            push_bgblur(&mut dag, 9, Rect::new(0.0, 80.0, 110.0, 200.0), 16.0);
            let w = walk(&mut dag, FRAME);
            w.pieces.iter().map(|p| (p.producer, p.rect)).collect::<Vec<_>>()
        };
        assert_eq!(build(), build(), "two identical walks must yield identical piece lists");
    }

    #[test]
    fn pieces_are_appended_never_mutating() {
        let mut dag = base_dag();
        push_bgblur(&mut dag, 7, Rect::new(0.0, 380.0, 120.0, 480.0), 32.0);
        let before: Vec<(UnitOp, Vec<usize>)> =
            dag.nodes.iter().map(|n| (n.op.clone(), n.inputs.clone())).collect();
        let w = walk(&mut dag, FRAME);
        for (i, (op, inputs)) in before.iter().enumerate() {
            assert_eq!(&dag.nodes[i].op, op, "existing node {i} op mutated");
            assert_eq!(&dag.nodes[i].inputs, inputs, "existing node {i} edges mutated");
        }
        assert_eq!(dag.nodes.len(), before.len() + w.pieces.len());
    }

    #[test]
    fn in_frame_gather_mints_nothing() {
        let mut dag = base_dag();
        push_bgblur(&mut dag, 7, Rect::new(200.0, 200.0, 300.0, 300.0), 16.0);
        let w = walk(&mut dag, FRAME);
        assert!(w.pieces.is_empty());
        assert!(w.coverage.is_empty());
    }
}
