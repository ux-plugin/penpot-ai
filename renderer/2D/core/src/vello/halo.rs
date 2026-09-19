//! DAG++: the frame graph continued past the frame. Every read of the frame's spine that escapes
//! the frame is rerouted through an [`Op::Halo`], the spine's state at the node read, continued
//! past the frame by a spine of its own: a root draw of the spine's items, the spine up to that
//! node cloned (its draws kept; each chain whose footprint reaches the region read past the frame
//! cloned over a fill point of its level, its leaves cloned, its resamples verbatim; the other
//! composes passed over), and the halo on top, placed before the first node that reads it. One
//! instance per spine node read and resolution read at. The scheduler plans the result and never
//! makes a value that is not a node.

use std::collections::HashMap;

use crate::kurbo::{Rect, Vec2};

use crate::vello::frame_graph::{pad_at, FrameGraph, GNode, NodeId, Op};
use crate::vello::resolve::{bands, tile_round, Demand, Res, Spines};

/// The resolution the expansion sizes a chain's reach by when deciding which chains an instance
/// clones: the lowest a pair goes in practice, so a chain that would only enter the region past
/// the frame once lowered is cloned in advance (a clone nothing demands costs nothing).
const MEMBERSHIP_K: f32 = 1.0 / 16.0;

/// One read of the frame's spine past the frame, or several at one resolution: the spine node
/// read, the resolution the readers run at, the region they read (frame pixels), and the graph
/// nodes whose input is rerouted to the halo.
struct Instance {
    of: NodeId,
    k: f32,
    region: Rect,
    rewired: Vec<NodeId>,
}

/// `g` expanded past `frame` under the resolutions `res` and the demand `dem` at them (the pairs'
/// targets: the decision comes after, on what this returns). `None` when no read escapes.
pub(crate) fn expand(g: &FrameGraph, frame: Rect, res: &Res, dem: &Demand, spines: &Spines) -> Option<FrameGraph> {
    let n = g.nodes.len();
    let mut instances: Vec<Instance> = Vec::new();
    for j in 0..n {
        if !g.is_spine(j) || spines.under_halo(g, j) {
            continue;
        }
        for &r in &res.readers[j] {
            if g.is_spine(r) || !dem.live(res, r) {
                continue;
            }
            let read = tile_round(dem.read_of(g, res, r, j));
            let inside = frame.x0 <= read.x0 && read.x1 <= frame.x1 && frame.y0 <= read.y0 && read.y1 <= frame.y1;
            if inside {
                continue;
            }
            let k = res.k[r];
            let x = if g.nodes[r].inputs.contains(&j) {
                r
            } else {
                g.nodes[r].inputs.iter().copied().find(|&e| res.elided[e] && g.nodes[e].inputs.contains(&j)).expect("a reader reads through an elided resample")
            };
            match instances.iter_mut().find(|i| i.of == j && i.k == k) {
                Some(i) => {
                    i.region = i.region.union(read);
                    if !i.rewired.contains(&x) {
                        i.rewired.push(x);
                    }
                }
                None => instances.push(Instance { of: j, k, region: read, rewired: vec![x] }),
            }
        }
    }
    if instances.is_empty() {
        return None;
    }
    if std::env::var_os("WV_PLAN_DUMP").is_some() {
        for inst in &instances {
            let names: Vec<&str> = inst.rewired.iter().map(|&x| g.nodes[x].label.as_str()).collect();
            eprintln!("expand: halo of {} at k={} over {:?} for {names:?}", g.nodes[inst.of].label, inst.k, inst.region);
        }
    }
    let mut nodes: Vec<GNode> = Vec::with_capacity(n * 2);
    let mut map: Vec<NodeId> = vec![usize::MAX; n];
    let mut halos: Vec<NodeId> = vec![usize::MAX; instances.len()];
    for i in 0..n {
        for (ix, inst) in instances.iter().enumerate() {
            if inst.rewired.iter().min() == Some(&i) {
                halos[ix] = emit_instance(g, frame, res, inst, ix, &map, &mut nodes);
            }
        }
        let node = &g.nodes[i];
        let inputs = node
            .inputs
            .iter()
            .map(|&j| match instances.iter().position(|inst| inst.of == j && inst.rewired.contains(&i)) {
                Some(ix) => halos[ix],
                None => map[j],
            })
            .collect();
        map[i] = nodes.len();
        nodes.push(GNode { op: node.op.clone(), inputs, label: node.label.clone() });
    }
    Some(FrameGraph::new(g.frame, g.background, nodes))
}

/// One instance's nodes, appended: the root, the cloned spine with its fill points and chain
/// clones, and the halo, whose index is returned. `map` gives the frame's nodes their new
/// indices for the halos' `of`.
fn emit_instance(g: &FrameGraph, frame: Rect, res: &Res, inst: &Instance, ix: usize, map: &[NodeId], nodes: &mut Vec<GNode>) -> NodeId {
    let mut spine = vec![inst.of];
    while let Some(&below) = g.nodes[*spine.last().expect("one node")].inputs.first() {
        spine.push(below);
    }
    spine.reverse();
    let mut region = inst.region;
    let mut cloned = vec![false; spine.len()];
    for (p, &s) in spine.iter().enumerate().rev() {
        let Op::Compose { offset, .. } = &g.nodes[s].op else { continue };
        let v = res.ext[g.nodes[s].inputs[1]] + Vec2::new(f64::from(offset[0]), f64::from(offset[1]));
        let foot = g.nodes[s].inputs.get(2).map_or(v, |&c| v.intersect(res.ext[c]));
        let Some(hit) = bands(region, frame).map(|b| foot.intersect(b)).filter(|h| !h.is_zero_area()).reduce(|a, b| a.union(b)) else { continue };
        cloned[p] = true;
        let reach = chain_reach(g, res, s, MEMBERSHIP_K);
        if std::env::var_os("WV_PLAN_DUMP").is_some() {
            eprintln!("expand: member {} foot {:?} hit {:?} reach {reach} region {:?}", g.nodes[s].label, foot, hit, region);
        }
        region = region.union(hit.inflate(reach, reach));
    }
    let mut push = |node: GNode| {
        nodes.push(node);
        nodes.len() - 1
    };
    let label = |s: NodeId| format!("{} @{ix}", g.nodes[s].label);
    let mut top = match &g.nodes[spine[0]].op {
        Op::Draw(_) => None,
        _ => Some(push(GNode { op: Op::Draw(Vec::new()), inputs: vec![], label: format!("root @{ix}") })),
    };
    for (p, &s) in spine.iter().enumerate() {
        match &g.nodes[s].op {
            Op::Draw(items) => {
                let inputs = top.map_or(Vec::new(), |t| vec![t]);
                top = Some(push(GNode { op: Op::Draw(items.clone()), inputs, label: label(s) }));
            }
            Op::Compose { .. } if cloned[p] => {
                let below = g.nodes[s].inputs[0];
                let fill = push(GNode { op: Op::Halo { of: map[below] }, inputs: vec![top.expect("a spine under a compose")], label: format!("fill of {} @{ix}", g.nodes[below].label) });
                let mut clones = HashMap::new();
                let value = clone_chain(g, g.nodes[s].inputs[1], fill, ix, &mut clones, &mut push);
                let mut inputs = vec![fill, value];
                if let Some(&c) = g.nodes[s].inputs.get(2) {
                    inputs.push(clone_chain(g, c, fill, ix, &mut clones, &mut push));
                }
                top = Some(push(GNode { op: g.nodes[s].op.clone(), inputs, label: label(s) }));
            }
            _ => {}
        }
    }
    push(GNode { op: Op::Halo { of: map[inst.of] }, inputs: vec![top.expect("a spine")], label: format!("halo of {} @{ix}", g.nodes[inst.of].label) })
}

/// Chain node `i` cloned into instance `ix` (memoised in `clones`): its spine reads go to the
/// instance's fill point `fill`, its resamples keep their targets (the resolution rules make a
/// clone's pair open no higher than its spine and close at it), its keys are the instance's own.
fn clone_chain(g: &FrameGraph, i: NodeId, fill: NodeId, ix: usize, clones: &mut HashMap<NodeId, NodeId>, push: &mut dyn FnMut(GNode) -> NodeId) -> NodeId {
    if g.is_spine(i) {
        return fill;
    }
    if let Some(&c) = clones.get(&i) {
        return c;
    }
    let node = &g.nodes[i];
    let inputs: Vec<NodeId> = node.inputs.iter().map(|&j| clone_chain(g, j, fill, ix, clones, push)).collect();
    let op = match &node.op {
        Op::Resample { target, key } => Op::Resample { target: *target, key: key ^ ((ix as u128 + 1) << 64) },
        op => op.clone(),
    };
    let c = push(GNode { op, inputs, label: format!("{} @{ix}", node.label) });
    clones.insert(i, c);
    c
}

/// How far, in frame pixels, the chain of compose `s` reads past its output when it runs no
/// higher than `k`: its heads' pads, summed.
fn chain_reach(g: &FrameGraph, res: &Res, s: NodeId, k: f32) -> f64 {
    let mut reach = 0.0;
    let mut cur = g.nodes[s].inputs[1];
    while !g.is_spine(cur) {
        let node = &g.nodes[cur];
        let kk = res.k[cur].min(k);
        reach += f64::from(pad_at(&node.op, kk)) / f64::from(kk);
        match node.inputs.first() {
            Some(&j) => cur = j,
            None => break,
        }
    }
    reach
}
