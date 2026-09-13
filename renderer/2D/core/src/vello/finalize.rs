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
//! 3. **Allocation.** Interval leases from the deaths [`FrameDag::schedule`] already computes,
//!    packed by [`super::frame_dag::pack`]; every slot reuse is a WAR edge with a priced buyout
//!    (min of read-set and write-set areas).
//! 4. **Route records** are data the swap emits; here they are the [`Route`] list — one operand
//!    record per served reader (the overflow role of the records ABI). There is no side/parity
//!    step: region windows write through a staging texture and blit back, so a dispatch never
//!    binds the lease store it writes and any piece may read any lease.

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
/// nodes, the interval leases, and the WAR ledger.
#[derive(Debug, Default)]
pub struct Final {
    pub k: HashMap<usize, f64>,
    pub routes: Vec<Route>,
    pub transports: Vec<usize>,
    pub leases: Vec<Option<Lease>>,
    pub wars: Vec<War>,
    pub blocks: Vec<(usize, Vec<usize>)>,
}

fn union_rect(rects: impl Iterator<Item = Rect>) -> Option<Rect> {
    rects.reduce(|a, b| a.union(b))
}

fn sub_rect(a: Rect, b: Rect) -> Vec<Rect> {
    let i = a.intersect(b);
    if !(i.x1 > i.x0 && i.y1 > i.y0) {
        return vec![a];
    }
    let mut out = Vec::with_capacity(4);
    if i.y0 > a.y0 {
        out.push(Rect::new(a.x0, a.y0, a.x1, i.y0));
    }
    if i.y1 < a.y1 {
        out.push(Rect::new(a.x0, i.y1, a.x1, a.y1));
    }
    if i.x0 > a.x0 {
        out.push(Rect::new(a.x0, i.y0, i.x0, i.y1));
    }
    if i.x1 < a.x1 {
        out.push(Rect::new(i.x1, i.y0, a.x1, i.y1));
    }
    out
}

fn sub_all(rects: Vec<Rect>, b: Rect) -> Vec<Rect> {
    rects.into_iter().flat_map(|r| sub_rect(r, b)).collect()
}

/// Tile-align a rect outward, so lease-block chunk offsets stay whole tiles and the block route's
/// affine lands every chunk exactly where the block frame expects it.
fn tile_round_out(r: Rect) -> Rect {
    let t = TILE_PX as f64;
    Rect::new(
        (r.x0 / t).floor() * t,
        (r.y0 / t).floor() * t,
        (r.x1 / t).ceil() * t,
        (r.y1 / t).ceil() * t,
    )
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
    host_w: f64,
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

    /// The lease contract says every lease owns one texel past the farthest tap, but a
    /// lease-block's chunks tile only the covers — the bbox holds gap texels no chunk writes.
    /// Fill a one-tile ring around every chunk with extra copies of that chunk's source (clamped
    /// content, deterministic), so guard reads never sample stale atlas rows.
    fn fill_gaps(
        &mut self,
        block_rect: Rect,
        seeds: &[(usize, Rect)],
        k: f64,
        chunks: &mut Vec<usize>,
        label: &str,
    ) {
        let t = TILE_PX as f64;
        let mut covered: Vec<Rect> = seeds.iter().map(|&(_, r)| r).collect();
        for &(src, cr) in seeds {
            let band = cr.inflate(t, t).intersect(block_rect);
            let mut parts = vec![band];
            for c in &covered {
                parts = sub_all(parts, *c);
            }
            for p in parts {
                if !(p.x1 > p.x0 && p.y1 > p.y0) {
                    continue;
                }
                let f = self.push_copy(p, vec![src], format!("combine gap fill {label}"));
                self.out.k.insert(f, k);
                chunks.push(f);
                covered.push(p);
            }
        }
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
        if rect.width() > self.host_w {
            let block_rect = tile_round_out(rect);
            let mut chunks = Vec::new();
            let mut seeds = Vec::new();
            for (node, r) in covers {
                let k_src = self.out.k.get(node).copied().unwrap_or(1.0);
                let (t, _) = self.ladder(*node, k_src, k_reader);
                let jr = self.dag.nodes[*node].reach.unwrap_or(*r);
                let cr = tile_round_out(jr).intersect(block_rect);
                let c = self.push_copy(cr, vec![t], format!("combine chunk for {reader}"));
                self.out.k.insert(c, k_reader);
                chunks.push(c);
                seeds.push((t, cr));
            }
            self.fill_gaps(block_rect, &seeds, k_reader, &mut chunks, &format!("for {reader}"));
            let b = self.push_copy(block_rect, chunks.clone(), format!("combine block for {reader}"));
            self.out.k.insert(b, k_reader);
            self.out.blocks.push((b, chunks));
            self.out.routes.push(Route { reader, target: b, rect: block_rect, k: 1.0 });
            return;
        }
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
}

/// Run finalize over a walked dag. `asks(reader)` is the reader's authored ask (`None` = full
/// res); `budget_bytes` caps summed piece lease bytes via the √ squeeze. Wires each route's
/// target into its reader component's `Reload` (append-only, invisible to arm baking — the
/// [`FrameDag::wire_region_reader`] convention), or into the reader itself for a scene-rooted
/// chain that has no `Reload`, so the shipped scheduler orders piece writes before their
/// consumers, then computes interval leases and the WAR ledger.
#[must_use]
pub fn finalize(
    dag: &mut FrameDag,
    walk: &Walk,
    asks: &dyn Fn(usize) -> Option<f64>,
    budget_bytes: u64,
    host_w: f64,
) -> Final {
    let mut k = resolve_k(dag, walk, asks);
    squeeze(walk, &mut k, budget_bytes);
    let mut fin = Fin { dag, out: Final { k, ..Final::default() }, host_w };

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

    let piece_nodes: Vec<usize> = walk.pieces.iter().map(|p| p.node).collect();
    let chain_producer = |j: usize| {
        walk.pieces
            .iter()
            .find(|p| p.node == j)
            .is_some_and(|p| matches!(p.producer, Producer::Chain { .. }))
    };
    for &n in &piece_nodes {
        let inputs = fin.dag.nodes[n].inputs.clone();
        let sampled: Vec<usize> = inputs
            .iter()
            .copied()
            .filter(|j| piece_nodes.contains(j) || fin.out.transports.contains(j))
            .collect();
        let (chain_grp, base_grp): (Vec<usize>, Vec<usize>) =
            sampled.iter().copied().partition(|&j| chain_producer(j));
        for group in [base_grp, chain_grp] {
            if group.len() < 2 {
                continue;
            }
            let need = fin.dag.nodes[n].reach.map(|r| {
                let p = f64::from(fin.dag.nodes[n].pad) + 1.0;
                r.inflate(p, p)
            });
            let rect = union_rect(
                group.iter().filter_map(|&j| fin.dag.nodes[j].reach),
            )
            .map(|u| need.map_or(u, |nd| u.intersect(nd)))
            .unwrap_or_default();
            let kg = group
                .iter()
                .map(|j| fin.out.k.get(j).copied().unwrap_or(1.0))
                .fold(K_FLOOR, f64::max);
            let c = if rect.width() > fin.host_w {
                let block_rect = tile_round_out(rect);
                let mut chunks = Vec::new();
                let mut seeds = Vec::new();
                for &j in &group {
                    let jr = fin.dag.nodes[j].reach.unwrap_or(block_rect);
                    let cr = tile_round_out(jr).intersect(block_rect);
                    let cc = fin.push_copy(cr, vec![j], format!("combine chunk input of {n}"));
                    fin.out.k.insert(cc, kg);
                    chunks.push(cc);
                    seeds.push((j, cr));
                }
                fin.fill_gaps(block_rect, &seeds, kg, &mut chunks, &format!("input of {n}"));
                let b = fin.push_copy(block_rect, chunks.clone(), format!("combine block input of {n}"));
                fin.out.blocks.push((b, chunks));
                b
            } else {
                fin.push_copy(rect, group.clone(), format!("combine input of {n}"))
            };
            fin.out.k.insert(c, kg);
            let current = fin.dag.nodes[n].inputs.clone();
            let mut placed = false;
            let mut rewired = Vec::new();
            for &inp in &current {
                if group.contains(&inp) {
                    if !placed {
                        rewired.push(c);
                        placed = true;
                    }
                } else {
                    rewired.push(inp);
                }
            }
            fin.dag.nodes[n].inputs = rewired;
        }
    }

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
        match reload {
            Some(rl) => fin.dag.nodes[rl].inputs.push(r.target),
            None => fin.dag.nodes[r.reader].inputs.push(r.target),
        }
    }

    fin.dag.reset_binding_index();
    #[cfg(debug_assertions)]
    {
        let n = fin.dag.nodes.len();
        let mut lv = vec![false; n];
        loop {
            let mut changed = false;
            for i in (0..n).rev() {
                if fin.dag.nodes[i].writes_accumulator() && !lv[i] {
                    lv[i] = true;
                    changed = true;
                }
                if lv[i] {
                    for &j in &fin.dag.nodes[i].inputs {
                        if !lv[j] {
                            lv[j] = true;
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
        for (i, live) in lv.iter().enumerate() {
            if !live {
                eprintln!("finalize: dead node {i} '{}'", fin.dag.nodes[i].label);
            }
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
        let fin = finalize(&mut dag, &w, &|_| Some(0.5), u64::MAX, FRAME.width());
        for p in &w.pieces {
            let k = fin.k[&p.node];
            assert!(k <= 0.5 + 1e-9, "no piece may exceed the finest ask, got {k}");
        }
        let (mut dag2, w2) = walked();
        let fin2 = finalize(&mut dag2, &w2, &|_| Some(1.0), 64 * 1024, FRAME.width());
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
        let fin = finalize(&mut dag, &w, &|_| None, u64::MAX, FRAME.width());
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
        let fin = finalize(&mut dag, &w, &asks, u64::MAX, FRAME.width());
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
        let fin = finalize(&mut dag, &w, &|_| None, u64::MAX, FRAME.width());
        for war in &fin.wars {
            assert!(war.overwrite > war.last_read, "overwrite lands after the last reader");
            assert!(war.buyout_px > 0, "every WAR edge carries its buyout price");
        }
        check(&dag, &w, &fin).expect("WAR ledger consistent");
    }
}
