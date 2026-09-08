//! Finalize (piece graph P2) — numbers on the walk's fixed topology.
//!
//! Runs once after [`super::walk::walk`]; inserts transport nodes ([`UnitOp::Copy`], law 2) but
//! never re-plans the walk's cuts. Five steps, from the plan:
//!
//! 1. **Density.** One authored number per reader — its *ask* (a ceiling, never exceeded). Each
//!    piece's k = the finest ask among its readers; over budget, one uniform √ squeeze lowers
//!    every k proportionally (hard floor 1/64, a piece is never dropped). `Copy` rungs go on
//!    k-crossing edges steeper than 2:1 (the halving ladder); a ≤2:1 crossing fuses into the
//!    consumer's bilinear taps and inserts nothing.
//! 2. **Fragmentation.** A reader whose coverage is more than one piece gets a **combine** — one
//!    transport assembling its sources into one contiguous lease — so every reader ends with
//!    exactly ONE route.
//! 3. **Sides.** 2-colouring along sample edges ([`FrameDag::parity_colours`]); a collision is
//!    discharged by law 2 with one re-side copy.
//! 4. **Allocation.** Interval leases from the deaths [`FrameDag::schedule`] already computes,
//!    packed by [`super::frame_dag::pack`]; every slot reuse is a WAR edge with a priced buyout
//!    (min of read-set and write-set areas).
//! 5. **Route records** are data the swap emits; here they are the [`Route`] list.

use crate::kurbo::Rect;
use std::collections::HashMap;

use super::frame_dag::{pack, FrameDag, Lease, LiveRect, Node, Source, TILE_PX};
use super::plan::Target;
use super::units::UnitOp;
use super::walk::{Producer, Walk};

/// The hard density floor — coarse-but-correct beats the edge clamp, so the squeeze never drops a
/// piece, it only coarsens down to here.
pub const K_FLOOR: f64 = 1.0 / 64.0;

/// One reader's single resolved route: its taps resolve through `target` (a piece or a transport
/// node) over `rect`, at density ratio `k` (the ≤2:1 residual its bilinear taps absorb).
#[derive(Clone, Debug)]
pub struct Route {
    pub reader: usize,
    pub target: usize,
    pub rect: Rect,
    pub k: f64,
}

/// One WAR edge the allocator's address coalescing introduced: `overwriter` reuses the slot whose
/// old tenant `tenant` was last read in `last_read`; the overwrite must land strictly after it.
/// `buyout_px` prices trading the edge for a copy: min(read-set, write-set) area.
#[derive(Clone, Debug)]
pub struct War {
    pub tenant: usize,
    pub overwriter: usize,
    pub last_read: u32,
    pub overwrite: u32,
    pub buyout_px: u64,
}

/// Finalize's whole output: per-node density, the single route per reader, the inserted transport
/// nodes, the side colouring, the interval leases, and the WAR ledger.
#[derive(Debug, Default)]
pub struct Final {
    pub k: HashMap<usize, f64>,
    pub routes: Vec<Route>,
    pub transports: Vec<usize>,
    pub sides: Vec<u8>,
    pub leases: Vec<Option<Lease>>,
    pub wars: Vec<War>,
}

fn union_rect(rects: impl Iterator<Item = Rect>) -> Option<Rect> {
    rects.reduce(|a, b| a.union(b))
}

/// Parity 2-colouring that reports its first failing constraint instead of just `None`:
/// `Err((a, b, was_eq))` names the exact pair law 2 must discharge. Same union-find-with-parity
/// as [`FrameDag::parity_colours`]; kept separate because the discharge needs the culprit.
fn try_colour(
    n: usize,
    eq: &[(usize, usize)],
    neq: &[(usize, usize)],
) -> Result<Vec<u8>, (usize, usize, bool)> {
    let mut parent: Vec<usize> = (0..n).collect();
    let mut par = vec![0u8; n];
    fn find(parent: &mut [usize], par: &mut [u8], i: usize) -> (usize, u8) {
        if parent[i] == i {
            return (i, 0);
        }
        let (root, p) = find(parent, par, parent[i]);
        parent[i] = root;
        par[i] ^= p;
        (root, par[i])
    }
    let mut union = |a: usize, b: usize, diff: u8| -> bool {
        let (ra, pa) = find(&mut parent, &mut par, a);
        let (rb, pb) = find(&mut parent, &mut par, b);
        if ra == rb {
            return pa ^ pb == diff;
        }
        parent[ra] = rb;
        par[ra] = pa ^ pb ^ diff;
        true
    };
    for &(a, b) in eq {
        if !union(a, b, 0) {
            return Err((a, b, true));
        }
    }
    for &(a, b) in neq {
        if !union(a, b, 1) {
            return Err((a, b, false));
        }
    }
    Ok((0..n).map(|i| find(&mut parent, &mut par, i).1).collect())
}

/// Step 1a — per-piece k: the finest ask among the piece's readers (frame readers via coverage,
/// piece readers via edges), propagated producer-ward so a chain instance runs at its gather's
/// ask. `asks` is the authored `acceptable_downscale` per frame reader (`None` = 1); the planner
/// never grants coarseness on its own.
fn resolve_k(dag: &FrameDag, walk: &Walk, asks: &dyn Fn(usize) -> Option<f64>) -> HashMap<usize, f64> {
    let mut k: HashMap<usize, f64> = HashMap::new();
    for (reader, covers) in &walk.coverage {
        let a = asks(*reader).unwrap_or(1.0).clamp(K_FLOOR, 1.0);
        for c in covers {
            let node = walk.pieces[c.piece].node;
            let e = k.entry(node).or_insert(a);
            *e = e.max(a);
        }
    }
    let piece_nodes: Vec<usize> = walk.pieces.iter().map(|p| p.node).collect();
    for &n in piece_nodes.iter().rev() {
        let kn = k.get(&n).copied().unwrap_or(1.0);
        for &j in &dag.nodes[n].inputs {
            if piece_nodes.contains(&j) {
                let e = k.entry(j).or_insert(kn);
                *e = e.max(kn);
            }
        }
    }
    for &n in &piece_nodes {
        k.entry(n).or_insert(1.0);
    }
    k
}

/// Step 1b — the budget squeeze, re-fed from the demolished demand planner: when summed lease
/// bytes exceed the budget, one uniform √ scale below every ask, floored at [`K_FLOOR`].
fn squeeze(walk: &Walk, k: &mut HashMap<usize, f64>, budget_bytes: u64) {
    let bytes: f64 = walk
        .pieces
        .iter()
        .map(|p| {
            let kp = k.get(&p.node).copied().unwrap_or(1.0);
            p.rect.width() * kp * p.rect.height() * kp * 4.0
        })
        .sum();
    if bytes > budget_bytes as f64 {
        let s = (budget_bytes as f64 / bytes).sqrt();
        for v in k.values_mut() {
            *v = (*v * s).max(K_FLOOR);
        }
    }
}

struct Fin<'a> {
    dag: &'a mut FrameDag,
    out: Final,
}

impl Fin<'_> {
    fn push_copy(&mut self, rect: Rect, inputs: Vec<usize>, label: String) -> usize {
        let idx = self.dag.nodes.len();
        self.dag.nodes.push(Node {
            op: UnitOp::Copy,
            target: Target::Atlas,
            source: Source::Region(usize::MAX),
            label,
            reach: Some(rect),
            pad: 0.0,
            inputs,
        });
        self.out.transports.push(idx);
        idx
    }

    /// Step 1c — the halving ladder on one k-crossing edge: rungs at successive halvings of the
    /// producer's k until within 2:1 of the consumer, whose taps fuse the residual. Returns the
    /// node the consumer should read and the residual ratio its taps absorb.
    fn ladder(&mut self, src: usize, k_src: f64, k_dst: f64) -> (usize, f64) {
        let mut cur = src;
        let mut kc = k_src;
        while kc / k_dst > 2.0 {
            kc /= 2.0;
            let rect = self.dag.nodes[cur].reach.unwrap_or_default();
            let rung = self.push_copy(rect, vec![cur], format!("rung k={kc}"));
            self.out.k.insert(rung, kc);
            cur = rung;
        }
        (cur, kc / k_dst)
    }

    /// Step 2 — discharge one reader's coverage into ONE route: a single cover routes directly
    /// (through a ladder if the densities cross); more than one gets a combine transport over the
    /// bounding window, each source laddered to the combine's k first.
    fn discharge(&mut self, reader: usize, covers: &[(usize, Rect)], k_reader: f64) {
        if covers.is_empty() {
            return;
        }
        if let [(node, rect)] = covers {
            let k_src = self.out.k.get(node).copied().unwrap_or(1.0);
            let (target, residual) = self.ladder(*node, k_src, k_reader);
            self.out.routes.push(Route { reader, target, rect: *rect, k: residual });
            return;
        }
        let rect = union_rect(covers.iter().map(|(_, r)| *r)).unwrap_or_default();
        let mut inputs = Vec::new();
        for (node, _) in covers {
            let k_src = self.out.k.get(node).copied().unwrap_or(1.0);
            let (t, _) = self.ladder(*node, k_src, k_reader);
            inputs.push(t);
        }
        let c = self.push_copy(rect, inputs, format!("combine for {reader}"));
        self.out.k.insert(c, k_reader);
        self.out.routes.push(Route { reader, target: c, rect, k: 1.0 });
    }

    /// Sampled-input pairs for the parity constraints: a lease-writing node samples every
    /// piece/transport input, so it must sit on the opposite atlas side (`neq`), and all its
    /// sampled inputs must co-side (`eq`).
    fn parity_edges(&self, lease_writers: &[usize]) -> (Vec<(usize, usize)>, Vec<(usize, usize)>) {
        let set: std::collections::HashSet<usize> = lease_writers.iter().copied().collect();
        let mut eq = Vec::new();
        let mut neq = Vec::new();
        for &i in lease_writers {
            let sampled: Vec<usize> = self.dag.nodes[i]
                .inputs
                .iter()
                .copied()
                .filter(|j| set.contains(j))
                .collect();
            for &j in &sampled {
                neq.push((i, j));
            }
            for w in sampled.windows(2) {
                eq.push((w[0], w[1]));
            }
        }
        (eq, neq)
    }

    /// Step 3 — sides are STRUCTURAL fold parity, not a search: a piece pass samples only the
    /// non-written atlas, so a node's side is one hop past its inputs', and depth parity mod 2 is
    /// the colouring. Processing lease writers bottom-up (the node vector is topological), any
    /// window that co-samples mixed parities is discharged by law 2 right there: each
    /// minority-parity input gets one re-side copy (which flips its parity by construction), so
    /// every window is co-sided and opposite its writer with a deterministic, bounded number of
    /// copies — no retry loop, no failure mode. Verified against the union-find colouring in
    /// debug builds.
    fn colour_with_resides(&mut self, walk: &Walk) -> Vec<u8> {
        let mut writer_of = vec![false; self.dag.nodes.len()];
        for p in &walk.pieces {
            writer_of[p.node] = true;
        }
        for &t in &self.out.transports {
            writer_of[t] = true;
        }
        let mut parity: HashMap<usize, u8> = HashMap::new();
        let mut i = 0;
        while i < self.dag.nodes.len() {
            if !writer_of[i] && !self.out.transports.contains(&i) {
                i += 1;
                continue;
            }
            if parity.contains_key(&i) {
                i += 1;
                continue;
            }
            let sampled: Vec<usize> = self.dag.nodes[i]
                .inputs
                .iter()
                .copied()
                .filter(|&j| parity.contains_key(&j) || writer_of.get(j).copied().unwrap_or(false))
                .collect();
            let Some(&first) = sampled.first() else {
                parity.insert(i, 0);
                i += 1;
                continue;
            };
            let target = parity.get(&first).copied().unwrap_or(0);
            for &j in sampled.iter().skip(1) {
                let pj = parity.get(&j).copied().unwrap_or(0);
                if pj % 2 != target % 2 {
                    let r = self.reside(i, j);
                    writer_of.resize(self.dag.nodes.len(), false);
                    writer_of[r] = true;
                    parity.insert(r, pj + 1);
                }
            }
            parity.insert(i, target + 1);
            i += 1;
        }
        let sides: Vec<u8> = (0..self.dag.nodes.len())
            .map(|n| parity.get(&n).map_or(0, |p| p % 2))
            .collect();
        #[cfg(debug_assertions)]
        {
            let writers: Vec<usize> = (0..self.dag.nodes.len())
                .filter(|&n| writer_of.get(n).copied().unwrap_or(false))
                .collect();
            let (eq, neq) = self.parity_edges(&writers);
            debug_assert!(
                try_colour(self.dag.nodes.len(), &eq, &neq).is_ok(),
                "structural parity left an uncolourable window"
            );
        }
        sides
    }

    /// Discharge one parity collision: mint a re-side copy of `b` (law 2, side arm — same rect,
    /// same density, opposite atlas) and make `sampler` read it instead.
    fn reside(&mut self, sampler: usize, b: usize) -> usize {
        let rect = self.dag.nodes[b].reach.unwrap_or_default();
        let kb = self.out.k.get(&b).copied().unwrap_or(1.0);
        let r = self.push_copy(rect, vec![b], format!("re-side of {b}"));
        self.out.k.insert(r, kb);
        if sampler != b {
            for inp in &mut self.dag.nodes[sampler].inputs {
                if *inp == b {
                    *inp = r;
                }
            }
        }
        r
    }
}

/// Run finalize over a walked dag. `asks(reader)` is the reader's authored ask (`None` = full
/// res); `budget_bytes` caps summed piece lease bytes via the √ squeeze. Wires each route's
/// target into its reader component's `Reload` (append-only, invisible to arm baking — the
/// [`FrameDag::wire_region_reader`] convention) so the shipped scheduler orders piece writes
/// before their consumers, then computes interval leases and the WAR ledger.
#[must_use]
pub fn finalize(
    dag: &mut FrameDag,
    walk: &Walk,
    asks: &dyn Fn(usize) -> Option<f64>,
    budget_bytes: u64,
) -> Final {
    let mut k = resolve_k(dag, walk, asks);
    squeeze(walk, &mut k, budget_bytes);
    let mut fin = Fin { dag, out: Final { k, ..Final::default() } };

    let mut per_reader: Vec<(usize, Vec<(usize, Rect)>)> = Vec::new();
    for (reader, covers) in &walk.coverage {
        let cs: Vec<(usize, Rect)> =
            covers.iter().map(|c| (walk.pieces[c.piece].node, c.rect)).collect();
        match per_reader.iter_mut().find(|(r, _)| r == reader) {
            Some((_, acc)) => acc.extend(cs),
            None => per_reader.push((*reader, cs)),
        }
    }
    for (reader, covers) in &per_reader {
        let kr = asks(*reader).unwrap_or(1.0).clamp(K_FLOOR, 1.0);
        fin.discharge(*reader, covers, kr);
    }

    fin.out.sides = fin.colour_with_resides(walk);

    let routes: Vec<Route> = fin.out.routes.clone();
    for r in &routes {
        let reload = fin.dag.nodes[..r.reader]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, n)| {
                matches!(n.op, UnitOp::Reload)
                    && n.source == fin.dag.nodes[r.reader].source
            })
            .map(|(i, _)| i);
        if let Some(rl) = reload {
            fin.dag.nodes[rl].inputs.push(r.target);
        }
    }

    let sched = fin.dag.schedule(TILE_PX, u64::MAX);
    let lives: Vec<LiveRect> = fin.dag.materialized_lives(&sched);
    let leases_packed = pack(&lives);
    let mut leases: Vec<Option<Lease>> = vec![None; fin.dag.nodes.len()];
    for (lr, le) in lives.iter().zip(&leases_packed) {
        leases[lr.node] = Some(*le);
    }
    let mut by_slot: HashMap<(u32, u32, u32), Vec<usize>> = HashMap::new();
    for (idx, (lr, le)) in lives.iter().zip(&leases_packed).enumerate() {
        let _ = lr;
        by_slot.entry((le.slab, le.x, le.y)).or_default().push(idx);
    }
    let mut wars = Vec::new();
    for tenants in by_slot.values() {
        let mut sorted = tenants.clone();
        sorted.sort_by_key(|&i| lives[i].birth);
        for pair in sorted.windows(2) {
            let (old, new) = (lives[pair[0]], lives[pair[1]]);
            wars.push(War {
                tenant: old.node,
                overwriter: new.node,
                last_read: old.death,
                overwrite: new.birth,
                buyout_px: (u64::from(old.w) * u64::from(old.h))
                    .min(u64::from(new.w) * u64::from(new.h)),
            });
        }
    }
    fin.out.leases = leases;
    fin.out.wars = wars;
    fin.out
}

/// The CPU-checkable invariants from the plan, over the lowered structures. Returns the first
/// violation as text; `Ok` means the plan is placement-sound.
pub fn check(dag: &FrameDag, walk: &Walk, fin: &Final) -> Result<(), String> {
    for (a, pa) in walk.pieces.iter().enumerate() {
        for pb in walk.pieces.iter().skip(a + 1) {
            if pa.producer == pb.producer {
                let i = pa.rect.intersect(pb.rect);
                if i.width() > 0.0 && i.height() > 0.0 {
                    return Err(format!("producer pieces overlap: {:?} vs {:?}", pa.rect, pb.rect));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    for r in &fin.routes {
        if !seen.insert(r.reader) {
            return Err(format!("reader {} carries more than one route", r.reader));
        }
        if r.k > 2.0 {
            return Err(format!("route residual steeper than tap fusion: {}", r.k));
        }
    }
    let lease_writer: Vec<bool> = (0..dag.nodes.len())
        .map(|i| {
            walk.pieces.iter().any(|p| p.node == i) || fin.transports.contains(&i)
        })
        .collect();
    for (i, n) in dag.nodes.iter().enumerate() {
        if !lease_writer[i] {
            continue;
        }
        let sampled: Vec<usize> =
            n.inputs.iter().copied().filter(|&j| lease_writer[j]).collect();
        for &j in &sampled {
            if fin.sides[i] == fin.sides[j] {
                return Err(format!("node {i} samples its own side ({j})"));
            }
        }
        for w in sampled.windows(2) {
            if fin.sides[w[0]] != fin.sides[w[1]] {
                return Err(format!("node {i} samples both sides ({} vs {})", w[0], w[1]));
            }
        }
        let kn = fin.k.get(&i).copied().unwrap_or(1.0);
        for &j in &sampled {
            let kj = fin.k.get(&j).copied().unwrap_or(1.0);
            if kj / kn > 2.0 {
                return Err(format!("edge {j}->{i} crosses density steeper than 2:1"));
            }
        }
    }
    for w in &fin.wars {
        if w.overwrite <= w.last_read {
            return Err(format!(
                "WAR violated: {} overwrites at r{} but {} is read to r{}",
                w.overwriter, w.overwrite, w.tenant, w.last_read
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::units::{BlurAxis, BlurEdge, ComposeMode, RasterSource};
    use crate::vello::walk::{walk, Piece};

    const FRAME: Rect = Rect { x0: 0.0, y0: 0.0, x1: 640.0, y1: 480.0 };

    fn base_dag() -> FrameDag {
        let mut dag = FrameDag::default();
        dag.nodes.push(Node {
            op: UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }),
            target: Target::Accumulator,
            source: Source::Body(1),
            label: "art".into(),
            reach: Some(Rect::new(-160.0, 0.0, 320.0, 640.0)),
            pad: 0.0,
            inputs: vec![],
        });
        dag
    }

    fn push_bgblur(dag: &mut FrameDag, shape: u128, reach: Rect, pad: f32) -> (usize, usize) {
        let fx = |op, target, pad, inputs| Node {
            op,
            target,
            source: Source::Effect { shape, slot: 0 },
            label: format!("fx{shape}"),
            reach: Some(reach),
            pad,
            inputs,
        };
        let r = dag.nodes.len();
        dag.nodes.push(fx(UnitOp::Reload, Target::Atlas, 0.0, vec![]));
        let x = dag.nodes.len();
        dag.nodes.push(fx(
            UnitOp::Blur { sigma: 8.0, linear: false, axis: BlurAxis::X, edge: BlurEdge::Backdrop },
            Target::Atlas,
            pad,
            vec![r],
        ));
        let y = dag.nodes.len();
        dag.nodes.push(fx(
            UnitOp::Blur { sigma: 8.0, linear: false, axis: BlurAxis::Y, edge: BlurEdge::Backdrop },
            Target::Atlas,
            pad,
            vec![x],
        ));
        let c = dag.nodes.len();
        dag.nodes.push(fx(
            UnitOp::Compose { mode: ComposeMode::Over, colour: None },
            Target::Accumulator,
            0.0,
            vec![r, y],
        ));
        (r, c)
    }

    fn walked() -> (FrameDag, Walk) {
        let mut dag = base_dag();
        push_bgblur(&mut dag, 7, Rect::new(-40.0, 380.0, 120.0, 520.0), 32.0);
        push_bgblur(&mut dag, 8, Rect::new(0.0, 300.0, 100.0, 460.0), 32.0);
        let w = walk(&mut dag, FRAME);
        (dag, w)
    }

    #[test]
    fn k_is_finest_ask_and_squeeze_is_uniform() {
        let (mut dag, w) = walked();
        let fin = finalize(&mut dag, &w, &|_| Some(0.5), u64::MAX);
        for p in &w.pieces {
            let k = fin.k[&p.node];
            assert!(k <= 0.5 + 1e-9, "no piece may exceed the finest ask, got {k}");
        }
        let (mut dag2, w2) = walked();
        let fin2 = finalize(&mut dag2, &w2, &|_| Some(1.0), 64 * 1024);
        let ks: Vec<f64> = w2.pieces.iter().map(|p| fin2.k[&p.node]).collect();
        assert!(ks.iter().any(|&k| k < 1.0), "a tight budget must squeeze k below the asks");
        assert!(ks.iter().all(|&k| k >= K_FLOOR), "the squeeze never breaches the floor");
        let r = ks[0];
        assert!(
            ks.iter().all(|&k| (k - r).abs() < 1e-9 || k == K_FLOOR),
            "the squeeze is UNIFORM below equal asks: {ks:?}"
        );
    }

    #[test]
    fn multi_piece_coverage_gets_one_combine_route() {
        let (mut dag, w) = walked();
        let multi: Vec<usize> = {
            let mut per: HashMap<usize, usize> = HashMap::new();
            for (r, cs) in &w.coverage {
                *per.entry(*r).or_default() += cs.len();
            }
            per.iter().filter(|&(_, &c)| c > 1).map(|(&r, _)| r).collect()
        };
        assert!(!multi.is_empty(), "the fixture must have a fragmented reader");
        let fin = finalize(&mut dag, &w, &|_| None, u64::MAX);
        for r in &multi {
            let routes: Vec<&Route> = fin.routes.iter().filter(|rt| rt.reader == *r).collect();
            assert_eq!(routes.len(), 1, "reader {r} must end with exactly ONE route");
            let t = routes[0].target;
            assert!(
                matches!(dag.nodes[t].op, UnitOp::Copy),
                "a fragmented reader routes through a combine transport"
            );
            assert!(dag.nodes[t].inputs.len() > 1, "the combine assembles every source");
        }
        check(&dag, &w, &fin).expect("the lowered plan passes the invariant checker");
    }

    #[test]
    fn ladder_depth_matches_ratio() {
        let (mut dag, mut w) = walked();
        let fine_reader = w.coverage[0].0;
        let coarse_piece = w.coverage[0].1[0].piece;
        let extra_reader = {
            let fx = |op, target, inputs| Node {
                op,
                target,
                source: Source::Effect { shape: 99, slot: 0 },
                label: "coarse reader".into(),
                reach: Some(Rect::new(0.0, 380.0, 64.0, 480.0)),
                pad: 8.0,
                inputs,
            };
            let rl = dag.nodes.len();
            dag.nodes.push(fx(UnitOp::Reload, Target::Atlas, vec![]));
            let g = dag.nodes.len();
            dag.nodes.push(fx(UnitOp::Warp(vec![]), Target::Atlas, vec![rl]));
            dag.nodes.push(fx(
                UnitOp::Compose { mode: ComposeMode::Over, colour: None },
                Target::Accumulator,
                vec![rl, g],
            ));
            g
        };
        w.coverage.push((extra_reader, vec![w.coverage[0].1[0].clone()]));
        let asks = move |r: usize| -> Option<f64> {
            if r == extra_reader {
                Some(1.0 / 8.0)
            } else if r == fine_reader {
                Some(1.0)
            } else {
                Some(1.0)
            }
        };
        let fin = finalize(&mut dag, &w, &asks, u64::MAX);
        let route = fin
            .routes
            .iter()
            .find(|r| r.reader == extra_reader)
            .expect("the coarse reader has a route");
        assert!(route.k <= 2.0 + 1e-9, "the residual fuses into taps");
        let mut rungs = 0;
        let mut cur = route.target;
        while matches!(dag.nodes[cur].op, UnitOp::Copy) {
            rungs += 1;
            cur = dag.nodes[cur].inputs[0];
        }
        assert_eq!(cur, w.pieces[coarse_piece].node, "the ladder roots at the shared piece");
        assert_eq!(rungs, 2, "8:1 = two halving rungs (½, ¼) + a 2:1 residual in the taps");
        check(&dag, &w, &fin).expect("ladder plan is invariant-clean");
    }

    #[test]
    fn parity_collision_discharges_with_a_reside() {
        let mut dag = base_dag();
        let a = dag.nodes.len();
        dag.nodes.push(Node {
            op: UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }),
            target: Target::Atlas,
            source: Source::Region(0),
            label: "piece A".into(),
            reach: Some(Rect::new(-64.0, 0.0, 0.0, 480.0)),
            pad: 0.0,
            inputs: vec![],
        });
        let b = dag.nodes.len();
        dag.nodes.push(Node {
            op: UnitOp::Blur { sigma: 8.0, linear: false, axis: BlurAxis::X, edge: BlurEdge::Backdrop },
            target: Target::Atlas,
            source: Source::Region(1),
            label: "piece B (samples A)".into(),
            reach: Some(Rect::new(-64.0, 0.0, 0.0, 480.0)),
            pad: 0.0,
            inputs: vec![a],
        });
        let s = dag.nodes.len();
        dag.nodes.push(Node {
            op: UnitOp::Compose { mode: ComposeMode::Over, colour: None },
            target: Target::Atlas,
            source: Source::Region(2),
            label: "step S (samples A and B)".into(),
            reach: Some(Rect::new(-64.0, 0.0, 0.0, 480.0)),
            pad: 0.0,
            inputs: vec![a, b],
        });
        let w = Walk {
            pieces: vec![
                Piece { node: a, producer: Producer::Ground { prefix: 0 }, rect: dag.nodes[a].reach.unwrap() },
                Piece { node: b, producer: Producer::Chain { of: 1 }, rect: dag.nodes[b].reach.unwrap() },
                Piece { node: s, producer: Producer::Step { writer: 2 }, rect: dag.nodes[s].reach.unwrap() },
            ],
            coverage: vec![],
        };
        let mut fin = Fin { dag: &mut dag, out: Final::default() };
        let sides = fin.colour_with_resides(&w);
        let transports = fin.out.transports.clone();
        assert_eq!(transports.len(), 1, "the odd cycle discharges with exactly ONE re-side copy");
        let r = transports[0];
        assert!(matches!(dag.nodes[r].op, UnitOp::Copy));
        let mut writers: Vec<usize> = vec![a, b, s];
        writers.extend(&transports);
        for &i in &writers {
            let sampled: Vec<usize> = dag.nodes[i]
                .inputs
                .iter()
                .copied()
                .filter(|j| writers.contains(j))
                .collect();
            for &j in &sampled {
                assert_ne!(sides[i], sides[j], "node {i} must sample the opposite side ({j})");
            }
            for pair in sampled.windows(2) {
                assert_eq!(
                    sides[pair[0]], sides[pair[1]],
                    "node {i}'s sampled reads must co-side"
                );
            }
        }
        let _ = (a, b, s);
    }

    #[test]
    fn cross_parity_combine_gets_a_reside() {
        let (mut dag, w) = walked();
        let fin = finalize(&mut dag, &w, &|_| None, u64::MAX);
        let resides: Vec<usize> = fin
            .transports
            .iter()
            .copied()
            .filter(|&t| dag.nodes[t].label.starts_with("re-side"))
            .collect();
        assert!(
            !resides.is_empty(),
            "a sampler co-reading a step and its own base ground forces one re-side"
        );
        check(&dag, &w, &fin).expect("cross-parity discharge leaves an invariant-clean plan");
    }

    #[test]
    fn war_ledger_prices_slot_reuse() {
        let lives = [
            LiveRect { node: 10, w: 64, h: 64, birth: 1, death: 2 },
            LiveRect { node: 11, w: 64, h: 64, birth: 4, death: 5 },
        ];
        let leases = pack(&lives);
        assert_eq!(
            (leases[0].slab, leases[0].x, leases[0].y),
            (leases[1].slab, leases[1].x, leases[1].y),
            "disjoint intervals of one class coalesce onto one slot"
        );
        let (mut dag, w) = walked();
        let fin = finalize(&mut dag, &w, &|_| None, u64::MAX);
        for war in &fin.wars {
            assert!(war.overwrite > war.last_read, "overwrite lands after the last reader");
            assert!(war.buyout_px > 0, "every WAR edge carries its buyout price");
        }
        check(&dag, &w, &fin).expect("WAR ledger consistent");
    }
}
