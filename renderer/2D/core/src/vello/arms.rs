//! Step 4: what the frame computes and what it holds. A chain is cut at its barriers into
//! [`Arm`]s — a head (a blur axis, a warp, a scatter, a resample) or a pointwise op over a leaf or
//! the spine starts an arm, and the pointwise ops after it ride along while the value has no
//! other reader; the compose folds into the arm that makes its value — and every arm writes a
//! [`Value`]: its tail's, or the rows of the spine its compose lands on. The frame's rows are
//! value 0; a halo spine's rows are one value shared by its root, its fill points and its halos.
//! Nothing here knows when an arm runs or where a value sits.

use crate::kurbo::Rect;

use crate::vello::frame_graph::{DrawItem, DrawStyle, NodeId, Op};
use crate::vello::resolve::Resolved;

/// What a value is, and so how it comes to hold what it holds.
#[derive(Clone, Debug)]
pub(crate) enum Kind {
    /// The frame's rows: value 0, which every compose on the frame's spine writes in place.
    Rows,
    /// A halo spine's rows: cleared to the background, drawn from these items by its root,
    /// written in place by its spine's composes, filled from the node each halo continues.
    Root(Vec<DrawItem>),
    /// A leaf drawn into its rect at its resolution; a distance leaf's decode rides along for
    /// its readers' records.
    Leaf { item: DrawItem, decode: f32 },
    /// A leaf the marker's own silhouette stands in for: analytic coverage of one shape, read
    /// only where the marker draws it. It has no rows of its own.
    Silhouette(u128),
    /// An arm's output.
    Out,
}

/// Rows the frame materialises.
#[derive(Clone, Debug)]
pub(crate) struct Value {
    /// The graph node whose result this is; a halo spine's is its lowest halo.
    pub node: NodeId,
    /// Frame coordinates, tile-aligned; a chain value may reach past the frame.
    pub rect: Rect,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub(crate) struct Arm {
    /// Chain nodes in run order; the last one is the value the arm makes.
    pub nodes: Vec<NodeId>,
    /// The compose this arm lands, if it does.
    pub compose: Option<NodeId>,
    /// The compose (or halo) whose chain this arm belongs to.
    pub chain: NodeId,
    /// The value the arm writes: its tail's, or the rows of the spine its compose lands on.
    pub out: usize,
}

/// The arms and values of a resolved graph.
pub(crate) struct Work {
    pub values: Vec<Value>,
    pub arms: Vec<Arm>,
    /// The arm each chain node, landed compose and filled halo belongs to.
    pub arm_of: Vec<Option<usize>>,
    /// The value each node's result is held in: a leaf's own, an arm tail's, the rows of the
    /// spine a spine node stands on (value 0 on the frame's).
    pub value_of: Vec<Option<usize>>,
}

pub(crate) fn is_head(op: &Op) -> bool {
    matches!(op, Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_) | Op::Resample { .. })
}

pub(crate) fn is_pointwise(op: &Op) -> bool {
    matches!(op, Op::Shade(_) | Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) | Op::Colour(_))
}

impl Work {
    pub fn of(cx: &Resolved) -> Work {
        let n = cx.g.nodes.len();
        let mut w = Work { values: vec![Value { node: n - 1, rect: cx.store.frame, kind: Kind::Rows }], arms: Vec::new(), arm_of: vec![None; n], value_of: vec![None; n] };
        for i in 0..n {
            if !cx.live(i) {
                continue;
            }
            if let Some(shape) = w.leaf_is_regs(cx, i) {
                w.value_of[i] = Some(w.push_value(Value { node: i, rect: cx.dem.out[i], kind: Kind::Silhouette(shape) }));
            }
        }
        for i in 0..n {
            if !cx.live(i) || !cx.g.is_spine(i) {
                continue;
            }
            match cx.g.nodes[i].op {
                Op::Compose { .. } => {
                    let value = cx.input(i, 1);
                    let cov = cx.g.nodes[i].inputs.get(2).map(|&c| cx.res.alias[c]);
                    w.lower_chain(cx, i, value);
                    if let Some(c) = cov {
                        w.lower_chain(cx, i, c);
                    }
                    w.compose(cx, i, value);
                }
                Op::Halo { .. } => w.halo(cx, i),
                _ => {}
            }
        }
        for j in (0..n).filter(|&j| cx.g.is_spine(j)) {
            w.value_of[j] = match cx.halo_of(j) {
                Some(h) => w.value_of[h],
                None => Some(0),
            };
        }
        for a in 0..w.arms.len() {
            w.arms[a].out = match w.arms[a].compose {
                Some(c) => w.value_of[c].unwrap_or(0),
                None => {
                    let tail = *w.arms[a].nodes.last().expect("an arm has nodes");
                    match w.value_of[tail] {
                        Some(v) => v,
                        None => {
                            let v = w.push_value(Value { node: tail, rect: cx.dem.out[tail], kind: Kind::Out });
                            w.value_of[tail] = Some(v);
                            v
                        }
                    }
                }
            };
        }
        w
    }

    fn push_value(&mut self, v: Value) -> usize {
        self.values.push(v);
        self.values.len() - 1
    }

    fn push_arm(&mut self, nodes: Vec<NodeId>, chain: NodeId) -> usize {
        self.arms.push(Arm { nodes, compose: None, chain, out: usize::MAX });
        self.arms.len() - 1
    }

    /// The spine whose rows arm `a`'s head reads, and the rows it reads of them in that spine's
    /// texels: a resample of a spine, or a halo filled from the spine node it continues. Such an
    /// arm runs as a snapshot mark in the spine's tiles rather than over its own rows
    /// (`bake::bits::SNAPSHOT`), so what it reads is the state at its place in z.
    pub fn snapshot_of(&self, cx: &Resolved, a: usize) -> Option<(NodeId, Rect)> {
        let &head = self.arms[a].nodes.first()?;
        match cx.g.nodes[head].op {
            Op::Resample { .. } => {
                let j = cx.input(head, 0);
                cx.g.is_spine(j).then(|| (j, cx.in_space_of(cx.read_rect(head), head, j)))
            }
            Op::Halo { of } => Some((of, cx.in_space_of(cx.inside_of(head, cx.dem.out[head]), head, of))),
            _ => None,
        }
    }

    /// The values arm `a` reads: leaves, silhouettes, spines' rows and other arms' outputs.
    pub fn reads_of(&self, cx: &Resolved, a: usize) -> Vec<usize> {
        let arm = &self.arms[a];
        let mut inputs: Vec<NodeId> = arm.nodes.iter().flat_map(|&i| cx.read_nodes(i)).collect();
        if let Some(c) = arm.compose {
            inputs.extend(cx.inputs(c));
        }
        let mut out = Vec::new();
        for j in inputs {
            if let Some(v) = self.value_of[j] {
                if !out.contains(&v) {
                    out.push(v);
                }
            }
        }
        out
    }

    /// Whether the chain holding node `i` is rooted in a drawn leaf rather than the spine, so
    /// its values are transparent past their rects.
    pub fn rooted_in_leaf(cx: &Resolved, i: NodeId) -> bool {
        let mut cur = i;
        loop {
            let node = &cx.g.nodes[cur];
            if cx.g.is_spine(cur) {
                return false;
            }
            if matches!(node.op, Op::Draw(_)) {
                return true;
            }
            match node.inputs.first() {
                Some(&j) => cur = j,
                None => return true,
            }
        }
    }

    /// Whether leaf `i` can ride the marker's own silhouette: analytic coverage, no spread, read
    /// only by pointwise ops or composes that land on the frame, never displaced.
    fn leaf_is_regs(&self, cx: &Resolved, i: NodeId) -> Option<u128> {
        let Op::Draw(items) = &cx.g.nodes[i].op else { return None };
        let [item] = items.as_slice() else { return None };
        let DrawStyle::Coverage { analytic: true, spread } = item.style else { return None };
        if spread != 0.0 {
            return None;
        }
        let ok = cx.res.readers[i].iter().all(|&r| match &cx.g.nodes[r].op {
            Op::Compose { offset, .. } => *offset == [0.0; 2] && cx.g.nodes[r].inputs[1..].contains(&i),
            Op::EraseBy(_) => cx.g.nodes[r].inputs[0] == i && cx.g.nodes[r].inputs[1] != i && Self::reads_land_on_frame(cx, r),
            Op::Colour(_) | Op::ClipToSource(_) => cx.g.nodes[r].inputs[0] == i && Self::reads_land_on_frame(cx, r),
            _ => false,
        });
        ok.then_some(item.shape)
    }

    /// A pointwise chain from `i` whose only reader chain ends in a compose with no head in between:
    /// its arm lands on the frame, where the marker's silhouette is available.
    fn reads_land_on_frame(cx: &Resolved, i: NodeId) -> bool {
        let mut cur = i;
        loop {
            let [r] = cx.res.readers[cur].as_slice() else { return false };
            match &cx.g.nodes[*r].op {
                Op::Compose { .. } => return cx.g.nodes[*r].inputs[1] == cur,
                op if is_pointwise(op) => cur = *r,
                _ => return false,
            }
        }
    }

    /// Give halo `h` its value — one per spine, shared by every halo on it and by its root: the
    /// rows the spine's nodes demand, joined, that the root draws into and the spine's composes
    /// write. Where `h`'s rect overlaps the frame it is filled from `of` by an arm of the halo's
    /// own: a snapshot of `of`'s tiles at the halo's place in z, resampled to the halo's
    /// resolution over the rows inside the frame, the drawn rows past it kept.
    fn halo(&mut self, cx: &Resolved, h: NodeId) {
        let root = cx.spines.root[h];
        let v = match self.value_of[root] {
            Some(v) => v,
            None => {
                let items = cx.dem.kept[root].clone();
                let rect = (0..cx.g.nodes.len())
                    .filter(|&s| cx.live(s) && cx.g.is_spine(s) && cx.spines.root[s] == root)
                    .map(|s| cx.dem.out[s])
                    .reduce(|a, b| a.union(b))
                    .unwrap_or(cx.dem.out[h]);
                let v = self.push_value(Value { node: h, rect, kind: Kind::Root(items) });
                self.value_of[root] = Some(v);
                v
            }
        };
        self.value_of[h] = Some(v);
        if !cx.fill_read(h) || cx.inside_of(h, cx.dem.out[h]).is_zero_area() {
            return;
        }
        let a = self.push_arm(vec![h], h);
        self.arm_of[h] = Some(a);
    }

    /// Lower every chain node reachable from `i` into arms and values, depth first, for the
    /// chain of compose `chain`.
    fn lower_chain(&mut self, cx: &Resolved, chain: NodeId, i: NodeId) {
        if cx.g.is_spine(i) || self.arm_of[i].is_some() || self.value_of[i].is_some() || !cx.live(i) {
            return;
        }
        for j in cx.inputs(i) {
            self.lower_chain(cx, chain, j);
        }
        let node = &cx.g.nodes[i];
        match &node.op {
            Op::Draw(items) => {
                let decode = match items.first().map(|it| it.style) {
                    Some(DrawStyle::Distance { decode }) => decode * cx.res.k[i],
                    _ => 0.0,
                };
                let item = items.first().cloned().expect("a leaf draws an item");
                let v = self.push_value(Value { node: i, rect: cx.dem.out[i], kind: Kind::Leaf { item, decode } });
                self.value_of[i] = Some(v);
            }
            op if is_head(op) || is_pointwise(op) => {
                let in0 = cx.input(i, 0);
                let joins = is_pointwise(op)
                    && self.arm_of[in0].is_some_and(|a| self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == in0 && cx.res.readers[in0].len() == 1);
                if joins {
                    let a = self.arm_of[in0].unwrap();
                    self.arms[a].nodes.push(i);
                    self.arm_of[i] = Some(a);
                } else {
                    let a = self.push_arm(vec![i], chain);
                    self.arm_of[i] = Some(a);
                }
            }
            _ => unreachable!("a compose is on the spine"),
        }
    }

    /// Land compose `c`: fold it into its value's arm when that arm has no other reader, else give
    /// it a headless arm of its own.
    fn compose(&mut self, cx: &Resolved, c: NodeId, value: NodeId) {
        let foldable = self.arm_of[value].is_some_and(|a| self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == value && cx.res.readers[value].len() == 1);
        let a = if foldable { self.arm_of[value].unwrap() } else { self.push_arm(vec![], c) };
        self.arms[a].compose = Some(c);
        self.arm_of[c] = Some(a);
    }
}
