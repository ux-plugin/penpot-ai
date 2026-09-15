//! The scheduler: frame graph in, frame plan out. Every decision about where and when is made
//! here, and the executor makes none.
//!
//! Six steps, in order:
//! 1. **Demand.** Backward from the frame: a compose owes its demand to the state below and, less
//!    its offset, to its value; a neighbourhood op owes its input its own demand grown by its pad
//!    (a `Transparent` blur grows nothing — the clamp supplies zeros); a pointwise op passes its
//!    demand through. A node's output rect is its demand clipped to its extent — the frame for
//!    the spine, and for a chain node whatever it reaches, past the frame included, no wider than
//!    a page; a draw item that misses its draw's demand is dropped.
//! 2. **Arms.** A chain is cut at its barriers: a head (a blur axis, a warp, a scatter) or a
//!    pointwise op over a leaf or the spine starts an arm, and the pointwise ops after it ride
//!    along while the value has no other reader. The compose folds into the arm that makes its
//!    value, which then writes the frame in place.
//! 3. **Rounds.** An arm runs one round after everything it reads: a leaf is round 0, the spine
//!    at a node is the round of the last compose below it, an arm is its own round. Spine draws
//!    take the segment of the last compose below them. A tile runs every mark of a window in
//!    list order, so nothing else separates rounds.
//! 4. **Serving** (ruling 13). A page arm that reads the spine past the frame reads a ground
//!    instead: one value per spine node, the union of every chain read of it, drawn once from the
//!    items below that node and overwritten by a copy of the frame rows where the two overlap,
//!    after the composes below have run. Effects below the chain are absent past the frame.
//! 5. **Pages** (ruling 19). Every leaf, ground and arm output that is not a compose is a rect
//!    slid to the top-left of a page (its placement rides its records); a value takes the lowest
//!    page where nothing alive overlaps its rows, spanning the next page when taller than one,
//!    and rows are free again once their last reader has run.
//! 6. **Emission.** Clear (the frame and every ground rect to the background, the pages between
//!    to transparent), one front-end over the leaf and ground draws (each clipped to its
//!    store rect) and the spine in z-order (clipped to the frame once pages sit under it, so a
//!    shape reaching past the frame's bottom never paints a page) with a marker at every compose,
//!    and a marker per page arm; a ground's copy before the fine of the round after its copy
//!    round; one fine per round over that round's tiles; present. `params` holds one descriptor
//!    per arm and one tile list per round.

use std::collections::HashMap;

use crate::kurbo::{Affine, Rect, Vec2};

use crate::vello::bake::{self, Policy, REC_COUNT, REC_STRIDE};
use crate::vello::frame_graph::{pad, BlurAxis, ComposeMode, DrawItem, DrawStyle, EdgeClampStyle, FrameGraph, NodeId, Op};
use crate::vello::frame_plan::{DrawCmd, FramePlan, Pass, Tiles, Window};
use crate::vello::units::{BlurEdge, UnitOp};

const TILE: f64 = 16.0;
/// Descriptor floats per arm: the 26-float header and the operand records.
const DESC_FLOATS: usize = 26 + REC_COUNT * REC_STRIDE;
/// Operand record sources, as `fine.wgsl` reads them: absent, a store rect, the tile's registers,
/// the marker's silhouette.
const SRC_NONE: f32 = 0.0;
const SRC_STORE: f32 = 1.0;
const SRC_REGS: f32 = 2.0;
const SRC_AREA: f32 = 3.0;
/// Operand record roles.
const REC_VALUE: usize = 0;
const REC_REF: usize = 1;
const REC_COVERAGE: usize = 2;
const REC_DISTANCE: usize = 3;
const REC_OUTPUT: usize = 4;

/// The plan for `graph` on a `width × height` frame.
#[must_use]
pub fn plan(graph: &FrameGraph, width: u32, height: u32) -> FramePlan {
    Scheduler::new(graph, width, height).run()
}

/// Where an arm reads one operand from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Operand {
    None,
    /// The tile's own registers: the state the tile holds.
    Regs,
    /// The marker's own rasterised silhouette.
    Area,
    /// A value in the store, read displaced by `shift` (frame px).
    Value { v: usize, shift: Vec2 },
    /// The frame rows themselves.
    Frame,
}

/// A value the frame materialises: a leaf drawn at round 0, an arm's output, or a served ground.
#[derive(Clone, Debug)]
struct Value {
    /// The graph node whose result this is; a ground's is the spine node it stands for.
    node: NodeId,
    /// Frame coordinates, tile-aligned; a chain value may reach past the frame.
    rect: Rect,
    /// Where the rect sits on its page: store `= rect + place + (0, page·pitch)`. A value is
    /// slid to its page's top-left corner, so `place = -rect.origin`.
    place: Vec2,
    /// The first round whose rows the value occupies (0 for anything drawn by the front-end).
    birth: u32,
    last_read: u32,
    /// The first page the value's rows start on; a value taller than a page spans the next.
    page: usize,
    /// The leaf item this value draws, if it is a leaf.
    leaf: Option<DrawItem>,
    /// A distance leaf's decode, for its readers' records.
    decode: f32,
    /// A served ground: the spine's state below its node over `rect`, drawn from the scene
    /// where it leaves the frame and copied from the frame rows where it does not.
    ground: Option<Ground>,
}

/// What serves a chain's reads of the spine past the frame (ruling 13): the items below the
/// spine node, drawn once over the whole rect, and the round after which the in-frame part can be
/// copied over them from the frame rows.
#[derive(Clone, Debug)]
struct Ground {
    items: Vec<DrawItem>,
    copy_round: u32,
}

#[derive(Clone, Debug)]
struct Arm {
    /// Chain nodes in run order; the last one is the value the arm makes.
    nodes: Vec<NodeId>,
    /// The compose this arm lands, if it does.
    compose: Option<NodeId>,
    round: u32,
    /// The store value this arm writes, unless it composes.
    out: Option<usize>,
    value: Operand,
    reference: Operand,
    coverage: Operand,
    distance: Operand,
    /// The shape whose silhouette masks the marker when any operand is `Regs`.
    mask_shape: Option<u128>,
    params_off: u32,
}

struct Scheduler<'a> {
    g: &'a FrameGraph,
    frame: Rect,
    h: f64,
    ext: Vec<Rect>,
    demand: Vec<Option<Rect>>,
    out: Vec<Rect>,
    readers: Vec<Vec<NodeId>>,
    /// Round of the last compose at or below each spine node.
    spine_round: HashMap<NodeId, u32>,
    /// The arm each chain node belongs to.
    arm_of: HashMap<NodeId, usize>,
    /// The value each leaf or arm-tail node produces.
    value_of: HashMap<NodeId, usize>,
    /// Leaves served by the marker's own silhouette rather than a rect.
    regs_leaf: HashMap<NodeId, u128>,
    /// The ground value serving each spine node that a chain reads past the frame.
    ground_of: HashMap<NodeId, usize>,
    arms: Vec<Arm>,
    values: Vec<Value>,
    pruned: HashMap<NodeId, Vec<DrawItem>>,
}

fn tile_round(r: Rect) -> Rect {
    Rect::new((r.x0 / TILE).floor() * TILE, (r.y0 / TILE).floor() * TILE, (r.x1 / TILE).ceil() * TILE, (r.y1 / TILE).ceil() * TILE)
}

fn union_into(slot: &mut Option<Rect>, r: Rect) {
    *slot = Some(slot.map_or(r, |s| s.union(r)));
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

fn is_head(op: &Op) -> bool {
    matches!(op, Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_))
}

fn is_pointwise(op: &Op) -> bool {
    matches!(op, Op::Shade(_) | Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) | Op::Colour(_))
}

impl<'a> Scheduler<'a> {
    fn new(g: &'a FrameGraph, width: u32, height: u32) -> Self {
        let n = g.nodes.len();
        let mut readers = vec![Vec::new(); n];
        for (i, node) in g.nodes.iter().enumerate() {
            for &j in &node.inputs {
                readers[j].push(i);
            }
        }
        let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        Self {
            g,
            frame,
            h: f64::from(height),
            ext: g.extents(),
            demand: vec![None; n],
            out: vec![Rect::ZERO; n],
            readers,
            spine_round: HashMap::new(),
            arm_of: HashMap::new(),
            value_of: HashMap::new(),
            regs_leaf: HashMap::new(),
            ground_of: HashMap::new(),
            arms: Vec::new(),
            values: Vec::new(),
            pruned: HashMap::new(),
        }
    }

    fn run(mut self) -> FramePlan {
        self.demand_pass();
        self.build_arms();
        self.serve();
        self.assign_pages();
        self.emit()
    }

    /// A chain rect no wider than a page: what reaches past the frame on either side is kept
    /// only as far as the page has room for it beside the in-frame part.
    fn clamp_x(&self, r: Rect) -> Rect {
        let w = self.frame.width();
        if r.width() <= w {
            return r;
        }
        let inf = Rect::new(r.x0.max(self.frame.x0), r.y0, r.x1.min(self.frame.x1), r.y1);
        let avail = w - inf.width();
        let left = (inf.x0 - r.x0).min(((avail / 2.0) / TILE).floor() * TILE);
        let right = (r.x1 - inf.x1).min(avail - left);
        Rect::new(inf.x0 - left, r.y0, inf.x1 + right, r.y1)
    }

    /// The extent a reader may see of node `i`: the frame for the spine (its rows hold the page
    /// colour everywhere), a leaf's bounds plus the pixel its antialiased edge spills into, the
    /// node's own extent for any other chain value.
    fn visible_extent(&self, i: NodeId) -> Rect {
        if self.g.is_spine(i) {
            self.frame
        } else if matches!(self.g.nodes[i].op, Op::Draw(_)) {
            self.ext[i].inflate(1.0, 1.0)
        } else {
            self.ext[i]
        }
    }

    fn demand_pass(&mut self) {
        let n = self.g.nodes.len();
        self.demand[n - 1] = Some(self.frame);
        for i in (0..n).rev() {
            let Some(d) = self.demand[i] else { continue };
            let node = &self.g.nodes[i];
            let out = match &node.op {
                Op::Compose { offset, .. } => {
                    let v = self.ext[node.inputs[1]] + Vec2::new(f64::from(offset[0]), f64::from(offset[1]));
                    let v = node.inputs.get(2).map_or(v, |&c| v.intersect(self.ext[c]));
                    d.intersect(v)
                }
                _ => d.intersect(self.visible_extent(i)),
            };
            let out = if self.g.is_spine(i) { tile_round(out).intersect(tile_round(self.frame)) } else { self.clamp_x(tile_round(out)) };
            self.out[i] = out;
            if matches!(node.op, Op::Draw(_) | Op::Compose { .. }) {
                if let Some(&below) = node.inputs.first() {
                    union_into(&mut self.demand[below], d);
                }
            }
            if out.is_zero_area() {
                continue;
            }
            let grown = |p: f32| out.inflate(f64::from(p), f64::from(p));
            match &node.op {
                Op::Draw(items) => {
                    let kept: Vec<DrawItem> = items.iter().filter(|it| overlaps(it.bounds, out)).cloned().collect();
                    self.pruned.insert(i, kept);
                }
                Op::Blur { edge_clamp_style, .. } => {
                    let r = if *edge_clamp_style == EdgeClampStyle::Transparent { out } else { grown(pad(&node.op)) };
                    union_into(&mut self.demand[node.inputs[0]], r);
                }
                Op::Warp(_) | Op::Scatter(_) => {
                    union_into(&mut self.demand[node.inputs[0]], grown(pad(&node.op)));
                    if let Some(&sdf) = node.inputs.get(1) {
                        union_into(&mut self.demand[sdf], out);
                    }
                }
                Op::EraseBy(u) => {
                    union_into(&mut self.demand[node.inputs[0]], out);
                    let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                    union_into(&mut self.demand[node.inputs[1]], out - shift);
                }
                Op::Shade(_) | Op::MaskMix(_) | Op::ClipToSource(_) | Op::Colour(_) => {
                    for &j in &node.inputs {
                        union_into(&mut self.demand[j], out);
                    }
                }
                Op::Compose { offset, .. } => {
                    union_into(&mut self.demand[node.inputs[1]], out - Vec2::new(f64::from(offset[0]), f64::from(offset[1])));
                    if let Some(&cov) = node.inputs.get(2) {
                        union_into(&mut self.demand[cov], out);
                    }
                }
            }
        }
    }

    fn live(&self, i: NodeId) -> bool {
        self.demand[i].is_some() && !self.out[i].is_zero_area()
    }

    /// Whether leaf `i` can ride the marker's own silhouette: analytic coverage, no spread, read
    /// only by pointwise ops or composes that land on the frame, never displaced.
    fn leaf_is_regs(&self, i: NodeId) -> Option<u128> {
        let Op::Draw(items) = &self.g.nodes[i].op else { return None };
        let [item] = items.as_slice() else { return None };
        let DrawStyle::Coverage { analytic: true, spread } = item.style else { return None };
        if spread != 0.0 {
            return None;
        }
        let ok = self.readers[i].iter().all(|&r| match &self.g.nodes[r].op {
            Op::Compose { offset, .. } => *offset == [0.0; 2] && self.g.nodes[r].inputs[1..].contains(&i),
            Op::EraseBy(_) => self.g.nodes[r].inputs[0] == i && self.g.nodes[r].inputs[1] != i && self.reads_land_on_frame(r),
            Op::Colour(_) | Op::ClipToSource(_) => self.g.nodes[r].inputs[0] == i && self.reads_land_on_frame(r),
            _ => false,
        });
        ok.then_some(item.shape)
    }

    /// A pointwise chain from `i` whose only reader chain ends in a compose with no head in between:
    /// its arm lands on the frame, where the marker's silhouette is available.
    fn reads_land_on_frame(&self, i: NodeId) -> bool {
        let mut cur = i;
        loop {
            let [r] = self.readers[cur].as_slice() else { return false };
            match &self.g.nodes[*r].op {
                Op::Compose { .. } => return self.g.nodes[*r].inputs[1] == cur,
                op if is_pointwise(op) => cur = *r,
                _ => return false,
            }
        }
    }

    fn build_arms(&mut self) {
        let n = self.g.nodes.len();
        for i in 0..n {
            if !self.live(i) {
                continue;
            }
            if let Some(shape) = self.leaf_is_regs(i) {
                self.regs_leaf.insert(i, shape);
            }
        }
        let mut current = 0u32;
        for i in 0..n {
            if !self.live(i) || !self.g.is_spine(i) {
                continue;
            }
            match &self.g.nodes[i].op {
                Op::Draw(_) => {
                    self.spine_round.insert(i, current);
                }
                Op::Compose { .. } => {
                    let value = self.g.nodes[i].inputs[1];
                    let cov = self.g.nodes[i].inputs.get(2).copied();
                    self.lower_chain(value);
                    if let Some(c) = cov {
                        self.lower_chain(c);
                    }
                    let round = self.compose(i, value);
                    current = round;
                    self.spine_round.insert(i, round);
                }
                _ => {}
            }
        }
    }

    /// The round after which node `i`'s result can be read over `r`: an arm's own round, a leaf's
    /// round 0, and for the spine the round of the last live compose or draw below `i` that
    /// touches `r` (a pruned compose has no arm and is walked past).
    fn ready(&self, i: NodeId, r: Rect) -> u32 {
        if self.g.is_spine(i) {
            let mut s = i;
            loop {
                let node = &self.g.nodes[s];
                match &node.op {
                    Op::Compose { .. } if overlaps(self.out[s], r) => {
                        if let Some(&a) = self.arm_of.get(&s) {
                            return self.arms[a].round;
                        }
                    }
                    Op::Draw(_) => {
                        let painted = self.pruned.get(&s).is_some_and(|items| items.iter().any(|it| overlaps(it.bounds, r)));
                        if painted {
                            return self.spine_round[&s];
                        }
                    }
                    _ => {}
                }
                match node.inputs.first() {
                    Some(&below) => s = below,
                    None => return 0,
                }
            }
        }
        if let Some(&a) = self.arm_of.get(&i) {
            return self.arms[a].round;
        }
        0
    }

    /// The region node `i` reads of an input: its output grown by its own pad.
    fn read_rect(&self, i: NodeId) -> Rect {
        let p = f64::from(pad(&self.g.nodes[i].op));
        self.out[i].inflate(p, p)
    }

    /// Lower every chain node reachable from `i` into arms and values, depth first.
    fn lower_chain(&mut self, i: NodeId) {
        if self.g.is_spine(i) || self.arm_of.contains_key(&i) || self.value_of.contains_key(&i) || !self.live(i) {
            return;
        }
        for &j in &self.g.nodes[i].inputs.clone() {
            self.lower_chain(j);
        }
        let node = &self.g.nodes[i];
        match &node.op {
            Op::Draw(items) => {
                if self.regs_leaf.contains_key(&i) {
                    return;
                }
                let decode = match items.first().map(|it| it.style) {
                    Some(DrawStyle::Distance { decode }) => decode,
                    _ => 0.0,
                };
                let v = self.values.len();
                self.values.push(Value { node: i, rect: self.out[i], place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: items.first().cloned(), decode, ground: None });
                self.value_of.insert(i, v);
            }
            op if is_head(op) || is_pointwise(op) => {
                let in0 = node.inputs[0];
                let joins = is_pointwise(op)
                    && self.arm_of.get(&in0).is_some_and(|&a| {
                        self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == in0 && self.readers[in0].len() == 1
                    });
                if joins {
                    let a = self.arm_of[&in0];
                    self.arms[a].nodes.push(i);
                    self.arm_of.insert(i, a);
                    let r = self.arm_round(a);
                    self.arms[a].round = r;
                } else {
                    let a = self.arms.len();
                    self.arms.push(Arm {
                        nodes: vec![i],
                        compose: None,
                        round: 0,
                        out: None,
                        value: Operand::None,
                        reference: Operand::None,
                        coverage: Operand::None,
                        distance: Operand::None,
                        mask_shape: None,
                        params_off: 0,
                    });
                    self.arm_of.insert(i, a);
                    let r = self.arm_round(a);
                    self.arms[a].round = r;
                }
            }
            _ => unreachable!("a compose is on the spine"),
        }
    }

    /// One more than the latest round any node of arm `a`, its compose included, reads from
    /// outside the arm over the region it reads.
    fn arm_round(&self, a: usize) -> u32 {
        let arm = &self.arms[a];
        let mut r = 0;
        for &i in &arm.nodes {
            for &j in &self.g.nodes[i].inputs {
                if self.arm_of.get(&j) == Some(&a) {
                    continue;
                }
                r = r.max(self.ready(j, self.read_rect(i)));
            }
        }
        if let Some(c) = arm.compose {
            for &j in &self.g.nodes[c].inputs {
                if self.arm_of.get(&j) == Some(&a) {
                    continue;
                }
                r = r.max(self.ready(j, self.out[c]));
            }
        }
        r + 1
    }

    /// Land compose `c`: fold it into its value's arm when that arm has no other reader, else give
    /// it a headless arm of its own. Returns the compose's round.
    fn compose(&mut self, c: NodeId, value: NodeId) -> u32 {
        let foldable = self.arm_of.get(&value).is_some_and(|&a| {
            self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == value && self.readers[value].len() == 1
        });
        let a = if foldable {
            self.arm_of[&value]
        } else {
            let a = self.arms.len();
            self.arms.push(Arm {
                nodes: vec![],
                compose: None,
                round: 0,
                out: None,
                value: Operand::None,
                reference: Operand::None,
                coverage: Operand::None,
                distance: Operand::None,
                mask_shape: None,
                params_off: 0,
            });
            a
        };
        self.arms[a].compose = Some(c);
        self.arm_of.insert(c, a);
        let r = self.arm_round(a);
        self.arms[a].round = r;
        r
    }

    /// The rect chain node `i` reads of its input `j`: its output grown by its pad for a head, its
    /// output for a pointwise op, displaced for an `EraseBy` reference.
    fn read_of(&self, i: NodeId, j: NodeId) -> Rect {
        let node = &self.g.nodes[i];
        match &node.op {
            Op::EraseBy(u) if node.inputs.get(1) == Some(&j) => {
                let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                self.out[i] - shift
            }
            op if is_head(op) && node.inputs[0] == j => self.read_rect(i),
            _ => self.out[i],
        }
    }

    /// Every item the spine paints at or below node `j` that touches `r`, in z-order.
    fn spine_items_below(&self, j: NodeId, r: Rect) -> Vec<DrawItem> {
        let mut groups: Vec<Vec<DrawItem>> = Vec::new();
        let mut s = Some(j);
        while let Some(i) = s {
            if let Op::Draw(items) = &self.g.nodes[i].op {
                groups.push(items.iter().filter(|it| overlaps(it.bounds, r)).cloned().collect());
            }
            s = self.g.nodes[i].inputs.first().copied();
        }
        groups.into_iter().rev().flatten().collect()
    }

    /// Serve the spine to every page arm that reads it past the frame (ruling 13): one ground
    /// value per spine node, sized to the union of all its chain reads, drawn from the scene once
    /// and overwritten by a copy of the frame rows where the two overlap.
    fn serve(&mut self) {
        let mut reads: HashMap<NodeId, Rect> = HashMap::new();
        let mut escapes: HashMap<NodeId, bool> = HashMap::new();
        for arm in &self.arms {
            if arm.compose.is_some() {
                continue;
            }
            for &i in &arm.nodes {
                for &j in &self.g.nodes[i].inputs {
                    if !self.g.is_spine(j) {
                        continue;
                    }
                    let r = self.clamp_x(tile_round(self.read_of(i, j)));
                    let e = escapes.entry(j).or_default();
                    *e |= !(self.frame.x0 <= r.x0 && r.x1 <= self.frame.x1 && self.frame.y0 <= r.y0 && r.y1 <= self.frame.y1);
                    reads.entry(j).and_modify(|u| *u = u.union(r)).or_insert(r);
                }
            }
        }
        let mut nodes: Vec<NodeId> = reads.keys().copied().filter(|j| escapes[j]).collect();
        nodes.sort_unstable();
        for j in nodes {
            let rect = self.clamp_x(reads[&j]);
            let inside = rect.intersect(self.frame);
            let copy_round = if inside.is_zero_area() { 0 } else { self.ready(j, inside) };
            let items = self.spine_items_below(j, rect);
            let v = self.values.len();
            self.values.push(Value { node: j, rect, place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: None, decode: 0.0, ground: Some(Ground { items, copy_round }) });
            self.ground_of.insert(j, v);
        }
    }

    /// Give every non-compose arm its value, mark every value's last reader, and pack the values
    /// onto pages.
    fn assign_pages(&mut self) {
        for a in 0..self.arms.len() {
            if self.arms[a].compose.is_some() {
                continue;
            }
            let tail = *self.arms[a].nodes.last().expect("an arm has nodes");
            let v = self.values.len();
            self.values.push(Value { node: tail, rect: self.out[tail], place: Vec2::ZERO, birth: self.arms[a].round, last_read: self.arms[a].round, page: 0, leaf: None, decode: 0.0, ground: None });
            self.value_of.insert(tail, v);
            self.arms[a].out = Some(v);
        }
        for a in 0..self.arms.len() {
            let round = self.arms[a].round;
            let mut inputs: Vec<NodeId> = self.arms[a].nodes.iter().flat_map(|&i| self.g.nodes[i].inputs.clone()).collect();
            if let Some(c) = self.arms[a].compose {
                inputs.extend(self.g.nodes[c].inputs.iter().copied());
            }
            for j in inputs {
                if let Some(&v) = self.value_of.get(&j) {
                    self.values[v].last_read = self.values[v].last_read.max(round);
                }
                if self.arms[a].compose.is_none() {
                    if let Some(&v) = self.ground_of.get(&j) {
                        self.values[v].last_read = self.values[v].last_read.max(round);
                    }
                }
            }
        }
        let mut order: Vec<usize> = (0..self.values.len()).collect();
        order.sort_by_key(|&v| (self.values[v].birth, v));
        let mut placed: Vec<usize> = Vec::new();
        for v in order {
            let rect = self.values[v].rect;
            self.values[v].place = Vec2::new(-rect.x0, -rect.y0);
            let birth = self.values[v].birth;
            let mut page = 1;
            loop {
                self.values[v].page = page;
                let mine = self.store_rect(v);
                let clash = placed.iter().any(|&o| {
                    let ov = &self.values[o];
                    overlaps(self.store_rect(o), mine) && ov.last_read >= birth
                });
                if !clash {
                    break;
                }
                page += 1;
            }
            placed.push(v);
        }
    }

    /// How many pages the frame rents below its own rows: enough for the lowest value's rows.
    fn pages(&self) -> usize {
        let pitch = self.pitch();
        (0..self.values.len()).map(|v| (self.store_rect(v).y1 / pitch).ceil() as usize - 1).max().unwrap_or(0)
    }

    /// The page pitch: the frame height rounded up to whole tiles.
    fn pitch(&self) -> f64 {
        (self.h / TILE).ceil() * TILE
    }

    /// A value's rect in store texels: its frame rect slid by its placement, down by its page.
    fn store_rect(&self, v: usize) -> Rect {
        let val = &self.values[v];
        val.rect + val.place + Vec2::new(0.0, val.page as f64 * self.pitch())
    }

    /// Where arm `a` reads node `j`: the spine is the tile's own registers when a pointwise read
    /// lands on the frame, its served ground when a page arm reads it past the frame, and the
    /// frame rect otherwise; a silhouette leaf is the marker's area; any other value is its store
    /// rect.
    fn operand_for(&self, a: usize, j: NodeId, shift: Vec2, pointwise: bool) -> Operand {
        if self.g.is_spine(j) {
            if pointwise && self.arms[a].compose.is_some() && shift == Vec2::ZERO {
                return Operand::Regs;
            }
            if self.arms[a].compose.is_none() {
                if let Some(&v) = self.ground_of.get(&j) {
                    return Operand::Value { v, shift };
                }
            }
            return Operand::Frame;
        }
        if self.regs_leaf.contains_key(&j) {
            return Operand::Area;
        }
        match self.value_of.get(&j) {
            Some(&v) => Operand::Value { v, shift },
            None => Operand::None,
        }
    }

    fn record(&self, op: Operand, decode: f32) -> [f32; REC_STRIDE] {
        let mut r = [0.0f32; REC_STRIDE];
        match op {
            Operand::None => r[0] = SRC_NONE,
            Operand::Regs => r[0] = SRC_REGS,
            Operand::Area => r[0] = SRC_AREA,
            Operand::Value { v, shift } => {
                let s = self.store_rect(v);
                let d = shift - self.values[v].place;
                r = [SRC_STORE, s.x0 as f32, s.y0 as f32, s.x1 as f32, s.y1 as f32, d.x as f32, d.y as f32, decode];
            }
            Operand::Frame => {
                let f = self.frame;
                r = [SRC_STORE, f.x0 as f32, f.y0 as f32, f.x1 as f32, f.y1 as f32, 0.0, 0.0, 0.0];
            }
        }
        r
    }

    fn unit_of(&self, i: NodeId) -> Option<UnitOp> {
        Some(match &self.g.nodes[i].op {
            Op::Blur { sigma, axis, linear, edge_clamp_style } => UnitOp::Blur {
                sigma: *sigma,
                linear: *linear,
                axis: match axis {
                    BlurAxis::X => crate::vello::units::BlurAxis::X,
                    BlurAxis::Y => crate::vello::units::BlurAxis::Y,
                },
                edge: match edge_clamp_style {
                    EdgeClampStyle::Extend => BlurEdge::Backdrop,
                    EdgeClampStyle::Transparent => BlurEdge::Coverage,
                },
            },
            Op::Warp(u) => UnitOp::Warp(u.clone()),
            Op::Scatter(u) => UnitOp::Scatter(u.clone()),
            Op::Shade(u) => UnitOp::Shade(u.clone()),
            Op::MaskMix(u) => UnitOp::MaskMix(u.clone()),
            Op::ClipToSource(u) => UnitOp::ClipToSource(u.clone()),
            Op::EraseBy(_) => UnitOp::EraseBy(Vec::new()),
            Op::Colour(_) | Op::Draw(_) | Op::Compose { .. } => return None,
        })
    }

    /// Fill arm `a`'s operands and serialise its descriptor into `params`.
    fn bake_arm(&mut self, a: usize, params: &mut Vec<f32>) {
        let nodes = self.arms[a].nodes.clone();
        let compose = self.arms[a].compose;
        let mut value = Operand::None;
        let mut reference = Operand::None;
        let mut coverage = Operand::None;
        let mut distance = Operand::None;
        let mut mask_shape = None;
        let mut tint: Option<[f32; 4]> = None;
        let mut run: Vec<UnitOp> = Vec::new();
        let mut edge_coverage = false;
        let mut blur: Option<(f32, bool, bool)> = None;
        let mut program: Option<f32> = None;
        for (k, &i) in nodes.iter().enumerate() {
            let node = &self.g.nodes[i];
            match &node.op {
                Op::Blur { sigma, linear, axis, edge_clamp_style } => {
                    blur = Some((*sigma, *linear, *axis == BlurAxis::Y));
                    edge_coverage = *edge_clamp_style == EdgeClampStyle::Transparent;
                }
                Op::Colour(c) => tint = Some([c[0], c[1], c[2], c[3]]),
                Op::MaskMix(u) if u.get(bake::PAYLOAD_PROGRAM_SLOT).copied() == Some(bake::PROGRAM_RADIAL) => program = Some(bake::PROGRAM_RADIAL),
                _ => {}
            }
            if let Some(u) = self.unit_of(i) {
                run.push(u);
            }
            if k == 0 {
                value = self.operand_for(a, node.inputs[0], Vec2::ZERO, is_pointwise(&node.op));
                if let (Op::Warp(_), Some(&sdf)) = (&node.op, node.inputs.get(1)) {
                    let dec = self.value_of.get(&sdf).map_or(0.0, |&v| self.values[v].decode);
                    distance = self.operand_for(a, sdf, Vec2::ZERO, true);
                    if let Operand::Value { .. } = distance {
                        self.values[self.value_of[&sdf]].decode = dec;
                    }
                }
            }
            match &node.op {
                Op::EraseBy(u) => {
                    let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                    reference = self.operand_for(a, node.inputs[1], shift, true);
                }
                Op::MaskMix(_) | Op::ClipToSource(_) => {
                    reference = self.operand_for(a, node.inputs[1], Vec2::ZERO, true);
                }
                _ => {}
            }
        }
        let mut policy = Policy { raw: compose.is_none(), edge_coverage, ..Policy::default() };
        if let Some(c) = compose {
            let Op::Compose { mode, colour, offset } = &self.g.nodes[c].op else { unreachable!() };
            let cnode = &self.g.nodes[c];
            if nodes.is_empty() {
                value = self.operand_for(a, cnode.inputs[1], Vec2::new(f64::from(offset[0]), f64::from(offset[1])), true);
            } else if let Operand::Value { v, .. } = value {
                value = Operand::Value { v, shift: Vec2::new(f64::from(offset[0]), f64::from(offset[1])) };
            }
            if let Some(&cv) = cnode.inputs.get(2) {
                coverage = self.operand_for(a, cv, Vec2::ZERO, true);
            }
            match (mode, colour) {
                (ComposeMode::Over, Some(c)) => {
                    policy.colour_over = true;
                    tint = Some(*c);
                }
                (ComposeMode::Over, None) => policy.value_over = true,
                (ComposeMode::MaskedMix, _) => {}
            }
            for &j in &cnode.inputs[1..] {
                if let Some(&shape) = self.regs_leaf.get(&j) {
                    mask_shape = Some(shape);
                }
            }
        }
        for &i in &nodes {
            for &j in &self.g.nodes[i].inputs {
                if let Some(&shape) = self.regs_leaf.get(&j) {
                    mask_shape = Some(shape);
                }
            }
        }
        let mut desc = match blur {
            Some((sigma, linear, axis_y)) => bake::blur_arm(sigma, linear, axis_y, policy, tint.filter(|_| policy.colour_over)),
            None => bake::arm_descriptor(&run, policy, program),
        };
        if let Some(t) = tint {
            if !policy.colour_over {
                desc[0] = (desc[0] as u32 | bake::bits::TINT) as f32;
            }
            desc[14..18].copy_from_slice(&t);
        }
        let mut rec = [[0.0f32; 4]; 12];
        bake::stamp_field_anchor(&desc, &mut rec);
        let (out_rect, out_place) = match self.arms[a].out {
            Some(v) => (self.store_rect(v), self.values[v].place),
            None => (self.out[compose.expect("an arm composes or writes a value")], Vec2::ZERO),
        };
        let mut records = [[0.0f32; REC_STRIDE]; REC_COUNT];
        records[REC_VALUE] = self.record(value, 0.0);
        records[REC_REF] = self.record(reference, 0.0);
        records[REC_COVERAGE] = self.record(coverage, 0.0);
        let dec = match distance {
            Operand::Value { v, .. } => self.values[v].decode,
            _ => 0.0,
        };
        records[REC_DISTANCE] = self.record(distance, dec);
        records[REC_OUTPUT] = [SRC_STORE, out_rect.x0 as f32, out_rect.y0 as f32, out_rect.x1 as f32, out_rect.y1 as f32, out_place.x as f32, out_place.y as f32, 0.0];
        records[5][0] = rec[10][0];
        records[5][1] = rec[10][1];
        let off = params.len();
        params.extend_from_slice(&desc);
        for r in &records {
            params.extend_from_slice(r);
        }
        debug_assert_eq!(params.len() - off, DESC_FLOATS);
        let arm = &mut self.arms[a];
        arm.value = value;
        arm.reference = reference;
        arm.coverage = coverage;
        arm.distance = distance;
        arm.mask_shape = mask_shape;
        arm.params_off = off as u32;
    }

    fn tiles_of(r: Rect, out: &mut Vec<u32>) {
        let r = tile_round(r);
        let (x0, y0, x1, y1) = ((r.x0 / TILE) as u32, (r.y0 / TILE) as u32, (r.x1 / TILE) as u32, (r.y1 / TILE) as u32);
        for y in y0..y1 {
            for x in x0..x1 {
                out.push(0x4000_0000 | (y << 16) | x);
            }
        }
    }

    fn emit(mut self) -> FramePlan {
        let mut params: Vec<f32> = Vec::new();
        for a in 0..self.arms.len() {
            self.bake_arm(a, &mut params);
        }
        let pages = self.pages();
        let pitch = self.pitch();
        let store_h = pitch * (1 + pages) as f64;
        let rounds = self.arms.iter().map(|a| a.round + 1).max().unwrap_or(1);

        let mut draws: Vec<DrawCmd> = Vec::new();
        let mut grounds: Vec<Pass> = Vec::new();
        let mut copies: Vec<Vec<Pass>> = vec![Vec::new(); rounds as usize + 1];
        let mut tiles: Vec<Vec<u32>> = vec![Vec::new(); rounds as usize];
        Self::tiles_of(self.frame, &mut tiles[0]);
        for (vi, v) in self.values.iter().enumerate() {
            let rect = self.store_rect(vi);
            let transform = Affine::translate(v.place + Vec2::new(0.0, v.page as f64 * pitch));
            if let Some(item) = &v.leaf {
                let mut it = item.clone();
                it.bounds = self.out[v.node];
                draws.push(DrawCmd::Shapes { items: vec![it], transform, clip: Some(rect) });
                Self::tiles_of(rect, &mut tiles[0]);
            }
            if let Some(ground) = &v.ground {
                grounds.push(Pass::Clear { rect, colour: self.g.background.components });
                draws.push(DrawCmd::Shapes { items: ground.items.clone(), transform, clip: Some(rect) });
                Self::tiles_of(rect, &mut tiles[0]);
                let inside = v.rect.intersect(self.frame);
                if !inside.is_zero_area() && (ground.copy_round as usize) < rounds as usize {
                    copies[ground.copy_round as usize + 1].push(Pass::Copy { src: inside, dst: inside + v.place + Vec2::new(0.0, v.page as f64 * pitch) });
                }
            }
        }
        for i in 0..self.g.nodes.len() {
            if !self.live(i) || !self.g.is_spine(i) {
                continue;
            }
            match &self.g.nodes[i].op {
                Op::Draw(_) => {
                    let items = self.pruned.get(&i).cloned().unwrap_or_default();
                    if items.is_empty() {
                        continue;
                    }
                    let seg = self.spine_round[&i] as usize;
                    for it in &items {
                        Self::tiles_of(it.bounds.intersect(self.frame), &mut tiles[seg]);
                    }
                    draws.push(DrawCmd::Shapes { items, transform: Affine::IDENTITY, clip: (pages > 0).then_some(self.frame) });
                }
                Op::Compose { .. } => {
                    let a = self.arm_of[&i];
                    let arm = &self.arms[a];
                    let footprint = self.out[i];
                    Self::tiles_of(footprint, &mut tiles[arm.round as usize]);
                    draws.push(DrawCmd::Marker {
                        shape: arm.mask_shape.unwrap_or(0),
                        transform: Affine::IDENTITY,
                        eid: if arm.mask_shape.is_some() { bake::EID_MASKED } else { bake::EID_MATERIALIZE },
                        seg_after: arm.round,
                        round: arm.round,
                        footprint,
                        ctl: 0,
                        params_off: arm.params_off,
                    });
                }
                _ => {}
            }
        }
        let mut page_arms: Vec<usize> = (0..self.arms.len()).filter(|&a| self.arms[a].compose.is_none()).collect();
        page_arms.sort_by_key(|&a| self.arms[a].round);
        for a in page_arms {
            let arm = &self.arms[a];
            let footprint = self.store_rect(arm.out.expect("a page arm writes a value"));
            Self::tiles_of(footprint, &mut tiles[arm.round as usize]);
            draws.push(DrawCmd::Marker {
                shape: 0,
                transform: Affine::IDENTITY,
                eid: bake::EID_MATERIALIZE,
                seg_after: arm.round,
                round: arm.round,
                footprint,
                ctl: 0,
                params_off: arm.params_off,
            });
        }

        let mut passes = vec![Pass::Clear { rect: self.frame, colour: self.g.background.components }];
        if pages > 0 {
            passes.push(Pass::Clear { rect: Rect::new(0.0, self.h, self.frame.x1, store_h), colour: [0.0; 4] });
        }
        passes.append(&mut grounds);
        passes.push(Pass::Frontend { draws });
        for (r, list) in tiles.iter_mut().enumerate() {
            passes.append(&mut copies[r]);
            list.sort_unstable();
            list.dedup();
            let off = params.len() as u32;
            params.extend(list.iter().map(|&w| f32::from_bits(w)));
            let r = r as u32;
            passes.push(Pass::Fine { window: Window { rounds: (r, r + 1), tiles: Tiles::List { off, n: list.len() as u32 } } });
        }
        passes.push(Pass::Present { from: self.frame });
        FramePlan { store: (self.frame.x1 as u32, store_h as u32), page: pitch as u32, params, passes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peniko::Color;
    use crate::vello::frame_graph::{GNode, DrawStyle};

    fn body(shape: u128, r: Rect) -> DrawItem {
        DrawItem { shape, style: DrawStyle::Body, bounds: r }
    }

    fn cov(shape: u128, r: Rect) -> DrawItem {
        DrawItem { shape, style: DrawStyle::Coverage { analytic: true, spread: 0.0 }, bounds: r }
    }

    /// A ground, one path with a soft drop shadow, one glass over it.
    fn graph() -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let b = Rect::new(100.0, 100.0, 300.0, 260.0);
        let g = Rect::new(200.0, 200.0, 400.0, 380.0);
        FrameGraph {
            frame,
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Draw(vec![cov(2, b)]), inputs: vec![], label: "sil".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::X, linear: false, edge_clamp_style: EdgeClampStyle::Transparent }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::Y, linear: false, edge_clamp_style: EdgeClampStyle::Transparent }, inputs: vec![2], label: "by".into() },
                GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![0, 3], label: "drop".into() },
                GNode { op: Op::Draw(vec![body(2, b)]), inputs: vec![4], label: "body".into() },
                GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![5], label: "warp".into() },
                GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![6], label: "shade".into() },
                GNode { op: Op::MaskMix(vec![0.0; 24]), inputs: vec![7, 5], label: "mix".into() },
                GNode { op: Op::Draw(vec![cov(3, g)]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![5, 8, 9], label: "glass".into() },
            ],
        }
    }

    #[test]
    fn rounds_are_dependency_depth_and_values_take_pages() {
        let g = graph();
        g.validate().expect("valid");
        let s = Scheduler::new(&g, 640, 480);
        let mut s = s;
        s.demand_pass();
        s.build_arms();
        s.assign_pages();
        let arms: Vec<(Vec<NodeId>, Option<NodeId>, u32)> = s.arms.iter().map(|a| (a.nodes.clone(), a.compose, a.round)).collect();
        assert_eq!(arms[0], (vec![2], None, 1), "blur X reads the round-0 silhouette");
        assert_eq!(arms[1], (vec![3], Some(4), 2), "blur Y lands the drop shadow");
        assert_eq!(arms[2], (vec![6, 7, 8], Some(10), 3), "the lens is one arm landing the glass after the body draws");
        assert_eq!(s.pages(), 2, "the silhouette and the blur-X value are alive together");
        let sil = s.values.iter().find(|v| v.node == 1).unwrap();
        let bx = s.values.iter().find(|v| v.node == 2).unwrap();
        assert_eq!((sil.birth, sil.last_read, sil.page), (0, 1, 1));
        assert_eq!((bx.birth, bx.last_read, bx.page), (1, 2, 2));
    }

    #[test]
    fn the_plan_validates_and_lists_tiles_per_round() {
        let g = graph();
        let p = plan(&g, 640, 480);
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(p.store, (640, 480 * 3));
        let fines: Vec<&Pass> = p.passes.iter().filter(|p| matches!(p, Pass::Fine { .. })).collect();
        assert_eq!(fines.len(), 4, "rounds 0..3");
        for (r, f) in fines.iter().enumerate() {
            let Pass::Fine { window } = f else { unreachable!() };
            assert_eq!(window.rounds, (r as u32, r as u32 + 1));
            let Tiles::List { n, .. } = window.tiles else { panic!("a tile list per round") };
            assert!(n > 0);
        }
        let shape = p.shape();
        assert_eq!(shape.markers, 3);
        assert_eq!(shape.rounds, 4);
    }

    #[test]
    fn demand_prunes_what_the_frame_never_sees() {
        let mut g = graph();
        let Op::Draw(items) = &mut g.nodes[0].op else { unreachable!() };
        items.push(body(9, Rect::new(2000.0, 2000.0, 2100.0, 2100.0)));
        let p = plan(&g, 640, 480);
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let ground = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if *transform == Affine::IDENTITY && items.iter().any(|i| i.shape == 1) => Some(items),
            _ => None,
        }).expect("the ground draw");
        assert!(ground.iter().all(|it| it.shape != 9), "an off-frame item is dropped");
    }
}
