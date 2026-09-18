//! The scheduler: frame graph in, frame plan out. Every decision about where and when is made
//! here, and the executor makes none.
//!
//! Eight steps, in order:
//! 1. **Demand.** Backward from the frame: a compose owes its demand to the state below and, less
//!    its offset, to its value; a neighbourhood op owes its input its own demand grown by its pad
//!    (a `Transparent` blur grows nothing — the clamp supplies zeros); a pointwise op passes its
//!    demand through; a scale owes its input its demand in the input's texels. A node's output
//!    rect is its demand clipped to its extent — the frame for the spine, and for a chain node
//!    whatever it reaches, past the frame included; a draw item that misses its draw's demand is
//!    dropped.
//! 2. **Capacity.** The store below the frame is a budget of texels (the preset's pages, capped
//!    by the device). With demand known at every
//!    pair's target, each pair's resolution is decided in closed form, then demand runs again:
//!    the run between a pair may be no wider than the store, and no two adjacent links of it
//!    (the leaf or halo it starts from included) may together exceed the budget: a chain is
//!    lowered only when it could not fit the store alone; chains that cannot share a round run
//!    one after the other. Resolutions step down a ladder of halves, so a
//!    resample is a whole box; there is no floor. Across frames a pair keeps its resolution until
//!    the rule that set it has moved by a margin, so a zoom does not flicker.
//! 3. **Expansion** (DAG++, [`Scheduler::expanded`]). Every read of the frame's spine that
//!    escapes the frame is rerouted through a [`Op::Halo`]: an instance per spine node read and
//!    resolution read at, whose spine draws the scene there at that resolution with the chains
//!    composed below cloned over fill points of their level, so effects below a chain are present
//!    past the frame. The graph is expanded at the decided resolutions, decided again with the
//!    halos counted, and expanded again if that lowered anything. Steps 4–8 run on DAG++.
//! 4. **Arms.** A chain is cut at its barriers: a head (a blur axis, a warp, a scatter, a scale)
//!    or a pointwise op over a leaf or the spine starts an arm, and the pointwise ops after it
//!    ride along while the value has no other reader. The compose folds into the arm that makes
//!    its value, which then writes its spine's rows in place: the frame, or a halo's value.
//!    A halo spine has one value, the rows its nodes demand joined; every halo on it is filled
//!    from the frame where it overlaps it, by a copy at the frame's resolution or a keep-scale
//!    arm below it, once the node it continues is ready there.
//! 5. **Rounds.** An arm runs one round after everything it reads: the spine at a node is the
//!    round of the last compose below it, a halo the later of its fill and its spine, an arm is
//!    its own round, and a leaf or halo root is drawn
//!    the round before its first reader — then each chain, in spine order, is shifted later by
//!    the least amount that keeps every round's live texels within the budget (first fit: chains
//!    overlap in time only when they fit beside each other). Nothing but the frame is drawn at
//!    round 0 by right: a value's draw is sequenced into its round by a boundary marker in its
//!    tiles, the way spine draws take the segment of the last compose below them. A tile runs
//!    every mark of a window in list order, so nothing else separates rounds.
//! 6. **Packing** (ruling 19, amended at R4). Every leaf, halo and arm output that is not a
//!    compose is a rect placed in the rows below the frame by [`StorePacker`], which hands out whole
//!    tiles and lets values whose lifetimes do not meet share them. Its origin splits back into the
//!    page fine folds rows by and the placement that rides the records.
//! 7. **Emission.** Clear (the frame to the background, the pages to transparent), one front-end
//!    over the spine in z-order (clipped to the frame once pages
//!    sit under it, so a shape reaching past the frame's bottom never paints a page) with a
//!    marker at every compose, then the page work in round order: each leaf and halo root draw
//!    behind its boundary marker (each clipped to its store rect), a halo spine's draws and
//!    compose markers under the halo's transform, and a marker per page arm; before each round's
//!    fine, the clears of the rects drawn in it (a leaf's to transparent, a halo's to the
//!    background — the tiles may have held an earlier value) and the copies filling the halos
//!    whose node became ready the round before; one fine per round over that round's tiles;
//!    present. `params` holds one descriptor per arm and one tile list per round.

use std::collections::HashMap;

use crate::kurbo::{Affine, Rect, Vec2};

use crate::vello::bake::{self, Policy, REC_COUNT, REC_STRIDE};
use crate::vello::frame_graph::{scale_rect, BlurAxis, ComposeMode, DrawItem, DrawStyle, EdgeClampStyle, FrameGraph, NodeId, Op};
use crate::vello::halo;
use crate::vello::resolve::{overlaps, tile_round, Demand, Res, Spines, Store};
use crate::vello::frame_plan::{self, DrawCmd, FramePlan, Pass, Tiles, Window};
use crate::vello::store_pack::StorePacker;
use crate::vello::units::{BlurEdge, UnitOp};

/// Pixel columns per tile. Must equal vello's `TILE_WIDTH`; the backend checks it at compile time.
pub const TILE_WIDTH: u32 = 16;
/// Pixel rows per tile. Must equal vello's `TILE_HEIGHT`; the backend checks it at compile time.
pub const TILE_HEIGHT: u32 = 16;
pub(crate) const TILE_W: f64 = TILE_WIDTH as f64;
pub(crate) const TILE_H: f64 = TILE_HEIGHT as f64;
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

/// The plan for `graph` on a `width × height` frame, on a device whose textures reach `max_dim`
/// texels a side, with `pages` frame heights of store below the frame (the preset's; the device
/// caps it). `memory` is what each pair ran at last frame, keyed by its `key`; the plan reads it
/// and writes what it chose.
#[must_use]
pub fn plan(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64, memory: &mut HashMap<u128, f32>) -> FramePlan {
    let expanded = expanded(graph, width, height, max_dim, pages);
    let mut s = Scheduler::new(expanded.as_ref().unwrap_or(graph), width, height, max_dim, pages);
    s.resolve(memory);
    s.run()
}

/// The graph `plan` schedules for `graph` on a `width × height` frame: DAG++, the graph with every
/// read of the frame's spine past the frame rerouted through a [`Op::Halo`] (see
/// [`halo::expand`]); `None` when no read escapes and the graph is planned as it is.
#[must_use]
pub fn expanded(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64) -> Option<FrameGraph> {
    let store = Store::for_graph(graph, width, height, max_dim, pages);
    let spines = Spines::of(graph);
    let res = Res::targets(graph);
    let dem = Demand::of(graph, store.frame, &res, &spines);
    halo::expand(graph, store.frame, &res, &dem, &spines)
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

/// A value the frame materialises: a leaf, an arm's output, or a halo spine's rows.
#[derive(Clone, Debug)]
struct Value {
    /// The graph node whose result this is; a halo spine's is its lowest halo.
    node: NodeId,
    /// Frame coordinates, tile-aligned; a chain value may reach past the frame.
    rect: Rect,
    /// Where the rect sits on its page: store `= rect + place + (0, page·pitch)`. A value is
    /// slid to its page's top-left corner, so `place = -rect.origin`.
    place: Vec2,
    /// The first round whose rows the value occupies: the round the front-end's segment draws a
    /// leaf or halo root in, or the round an arm's mark writes it.
    birth: u32,
    last_read: u32,
    /// The first page the value's rows start on; a value taller than a page spans the next.
    page: usize,
    /// The leaf item this value draws, if it is a leaf.
    leaf: Option<DrawItem>,
    /// A distance leaf's decode, for its readers' records.
    decode: f32,
    /// A halo spine's value: the items its root draws, cleared to the background first.
    root: Option<Vec<DrawItem>>,
}

#[derive(Clone, Debug)]
struct Arm {
    /// Chain nodes in run order; the last one is the value the arm makes.
    nodes: Vec<NodeId>,
    /// The compose this arm lands, if it does.
    compose: Option<NodeId>,
    /// The compose whose chain this arm belongs to.
    chain: NodeId,
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
    store: Store,
    spines: Spines,
    res: Res,
    dem: Demand,
    /// The arm each chain node belongs to.
    arm_of: HashMap<NodeId, usize>,
    /// The value each leaf or arm-tail node produces.
    value_of: HashMap<NodeId, usize>,
    /// Leaves served by the marker's own silhouette rather than a rect.
    regs_leaf: HashMap<NodeId, u128>,
    arms: Vec<Arm>,
    values: Vec<Value>,
    /// The chain being lowered: its compose.
    chain: NodeId,
}



fn is_head(op: &Op) -> bool {
    matches!(op, Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_) | Op::Scale { .. })
}

fn is_pointwise(op: &Op) -> bool {
    matches!(op, Op::Shade(_) | Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) | Op::Colour(_))
}

impl<'a> Scheduler<'a> {
    fn new(g: &'a FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64) -> Self {
        let store = Store::for_graph(g, width, height, max_dim, pages);
        let spines = Spines::of(g);
        let res = Res::targets(g);
        let dem = Demand::of(g, store.frame, &res, &spines);
        Self { g, store, spines, res, dem, arm_of: HashMap::new(), value_of: HashMap::new(), regs_leaf: HashMap::new(), arms: Vec::new(), values: Vec::new(), chain: 0 }
    }

    /// The capacity decision on the demand at the pairs' targets, and demand again at what it
    /// decided.
    fn resolve(&mut self, memory: &mut HashMap<u128, f32>) {
        if let Some(res) = self.res.decide(self.g, &self.dem, &self.store, memory) {
            self.res = res;
            self.dem = Demand::of(self.g, self.store.frame, &self.res, &self.spines);
        }
    }

    fn live(&self, i: NodeId) -> bool {
        self.dem.live(&self.res, i)
    }

    fn input(&self, i: NodeId, n: usize) -> NodeId {
        self.res.input(self.g, i, n)
    }

    fn inputs(&self, i: NodeId) -> Vec<NodeId> {
        self.res.inputs(self.g, i)
    }

    fn in_space_of(&self, r: Rect, from: NodeId, to: NodeId) -> Rect {
        self.res.in_space_of(r, from, to)
    }

    fn inside_of(&self, i: NodeId, r: Rect) -> Rect {
        self.res.inside_of(self.g, &self.spines, self.store.frame, i, r)
    }

    fn read_rect(&self, i: NodeId) -> Rect {
        self.dem.read_rect(self.g, &self.res, i)
    }

    /// The plan, once [`Self::resolve`] has settled every resolution and demand.
    fn run(mut self) -> FramePlan {
        self.build_arms();
        self.fit_rounds();
        self.assign_pages();
        if std::env::var_os("WV_PLAN_DUMP").is_some() {
            eprint!("{}", self.schedule_dump());
        }
        self.emit()
    }

    /// The schedule as text, one line per arm in round order: round, chain (its compose's label),
    /// the resolution its nodes run at, the nodes, and the value's rect and texels — then one
    /// line per round with the texels live in it.
    fn schedule_dump(&self) -> String {
        let mut arms: Vec<usize> = (0..self.arms.len()).collect();
        arms.sort_by_key(|&a| (self.arms[a].round, a));
        let mut s = String::from("schedule\n");
        for a in arms {
            let arm = &self.arms[a];
            let k = arm.nodes.first().map_or(1.0, |&i| self.res.k[i]);
            let labels: Vec<&str> = arm.nodes.iter().map(|&i| self.g.nodes[i].label.as_str()).collect();
            let rect = arm.out.map(|v| self.values[v].rect);
            s.push_str(&format!(
                "  r{:<3} {:<26} k={:<5} [{}]{}{}\n",
                arm.round,
                self.g.nodes[arm.chain].label,
                k,
                labels.join(", "),
                arm.compose.map_or(String::new(), |c| format!(" → {}", self.g.nodes[c].label)),
                rect.map_or(String::new(), |r| format!(" out {}x{}", r.width(), r.height())),
            ));
        }
        let rounds = self.arms.iter().map(|a| a.round + 1).max().unwrap_or(1);
        for r in 0..rounds {
            let live: f64 = self.values.iter().filter(|v| v.birth <= r && r <= v.last_read).map(|v| v.rect.area()).sum();
            let n = self.values.iter().filter(|v| v.birth <= r && r <= v.last_read).count();
            s.push_str(&format!("  round {r:<3} live {:>5.0}k texels in {n} values\n", live / 1000.0));
        }
        for (i, v) in self.values.iter().enumerate() {
            let kind = match (&v.leaf, &v.root) {
                (Some(_), _) => "leaf".to_string(),
                (None, Some(items)) => format!("halo×{}", items.len()),
                (None, None) => "arm".to_string(),
            };
            s.push_str(&format!(
                "  v{i:<3} {:<26} {kind:<11} rounds {}..{} page {} at {:?} rect {:?}\n",
                self.g.nodes[v.node].label, v.birth, v.last_read, v.page, v.place, v.rect
            ));
        }
        s
    }

    /// The halo value spine node `j` is held in: a halo's own, the halo above a spine under one,
    /// nothing on the frame's spine.
    fn halo_value(&self, j: NodeId) -> Option<usize> {
        let h = if matches!(self.g.nodes[j].op, Op::Halo { .. }) { Some(j) } else { self.spines.halo_of[j] };
        h.and_then(|h| self.value_of.get(&h).copied())
    }

    /// Where an arm reads spine node `j` from: the frame rows, or the halo value it stands in.
    fn spine_operand(&self, j: NodeId, shift: Vec2) -> Operand {
        match self.halo_value(j) {
            Some(v) => Operand::Value { v, shift },
            None => Operand::Frame,
        }
    }

    /// Where spine node `j`'s rows start in the store: the halo value's origin under a halo,
    /// nothing on the frame's spine.
    fn spine_origin(&self, j: NodeId) -> Vec2 {
        match self.halo_value(j) {
            Some(v) => self.values[v].place + Vec2::new(0.0, self.values[v].page as f64 * self.store.pitch),
            None => Vec2::ZERO,
        }
    }

    /// Whether halo `h` is filled: a live chain node reads it. A fill point under a clone that
    /// nothing demands would be filled for nobody; the fill above it covers the same rows.
    fn fill_read(&self, h: NodeId) -> bool {
        self.res.readers[h].iter().any(|&r| !self.g.is_spine(r) && self.live(r))
    }

    /// The nodes `i` reads: its inputs, and for a halo the spine node it continues.
    fn read_nodes(&self, i: NodeId) -> Vec<NodeId> {
        let mut nodes = self.inputs(i);
        if let Op::Halo { of } = self.g.nodes[i].op {
            nodes.push(of);
        }
        nodes
    }

    /// Whether the chain holding node `i` is rooted in a drawn leaf rather than the spine, so
    /// its values are transparent past their rects.
    fn rooted_in_leaf(&self, i: NodeId) -> bool {
        let mut cur = i;
        loop {
            let node = &self.g.nodes[cur];
            if self.g.is_spine(cur) {
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
    fn leaf_is_regs(&self, i: NodeId) -> Option<u128> {
        let Op::Draw(items) = &self.g.nodes[i].op else { return None };
        let [item] = items.as_slice() else { return None };
        let DrawStyle::Coverage { analytic: true, spread } = item.style else { return None };
        if spread != 0.0 {
            return None;
        }
        let ok = self.res.readers[i].iter().all(|&r| match &self.g.nodes[r].op {
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
            let [r] = self.res.readers[cur].as_slice() else { return false };
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
        for i in 0..n {
            if !self.live(i) || !self.g.is_spine(i) {
                continue;
            }
            match self.g.nodes[i].op {
                Op::Compose { .. } => {
                    self.chain = i;
                    let value = self.input(i, 1);
                    let cov = self.g.nodes[i].inputs.get(2).map(|&c| self.res.alias[c]);
                    self.lower_chain(value);
                    if let Some(c) = cov {
                        self.lower_chain(c);
                    }
                    self.compose(i, value);
                }
                Op::Halo { of } => self.halo(i, of),
                _ => {}
            }
        }
    }

    /// Give halo `h` its value — one per spine, shared by every halo on it and by its root: the
    /// rows the spine's nodes demand, joined, that the root draws into and the spine's composes
    /// write. Where `h`'s rect overlaps the frame it is filled from `of`: by one copy when the
    /// two run at one resolution, else by an arm of the halo's own that resamples `of` over the
    /// drawn rows and keeps them where the source leaves the frame.
    fn halo(&mut self, h: NodeId, of: NodeId) {
        let root = self.g.spine_root(h);
        let v = match self.value_of.get(&root) {
            Some(&v) => v,
            None => {
                let items = self.dem.kept[root].clone();
                let rect = (0..self.g.nodes.len())
                    .filter(|&s| self.live(s) && self.g.is_spine(s) && self.g.spine_root(s) == root)
                    .map(|s| self.dem.out[s])
                    .reduce(|a, b| a.union(b))
                    .unwrap_or(self.dem.out[h]);
                let v = self.values.len();
                self.values.push(Value { node: h, rect, place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: None, decode: 0.0, root: Some(items) });
                self.value_of.insert(root, v);
                v
            }
        };
        self.value_of.insert(h, v);
        if self.res.k[of] == self.res.k[h] || !self.fill_read(h) || self.inside_of(h, self.dem.out[h]).is_zero_area() {
            return;
        }
        let a = self.arms.len();
        self.arms.push(Arm {
            nodes: vec![h],
            compose: None,
            chain: h,
            round: 0,
            out: Some(v),
            value: Operand::None,
            reference: Operand::None,
            coverage: Operand::None,
            distance: Operand::None,
            mask_shape: None,
            params_off: 0,
        });
        self.arm_of.insert(h, a);
        let r = self.arm_round(a);
        self.arms[a].round = r;
    }

    /// The round after which node `i`'s result can be read over `r`: an arm's own round, a leaf's
    /// round 0, and for the spine the round of the last live compose below `i` that touches `r`
    /// (a pruned compose has no arm and is walked past). A spine draw has no round of its own:
    /// a tile's segment advances only at the markers binned into it, so the draw's items are
    /// painted over `r` in whatever round the last compose touching `r` gave those tiles — two
    /// chains over disjoint ground run in the same rounds even with draws between them.
    fn ready(&self, i: NodeId, r: Rect) -> u32 {
        if let Op::Halo { of } = self.g.nodes[i].op {
            if let Some(&a) = self.arm_of.get(&i) {
                return self.arms[a].round;
            }
            let inside = self.inside_of(i, self.dem.out[i]);
            let filled = self.ready(of, self.in_space_of(inside, i, of));
            return filled.max(self.ready(self.g.nodes[i].inputs[0], r));
        }
        if self.g.is_spine(i) {
            let mut s = i;
            loop {
                let node = &self.g.nodes[s];
                if let Op::Compose { .. } = &node.op {
                    if overlaps(self.dem.out[s], r) {
                        if let Some(&a) = self.arm_of.get(&s) {
                            return self.arms[a].round;
                        }
                    }
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

    /// Lower every chain node reachable from `i` into arms and values, depth first.
    fn lower_chain(&mut self, i: NodeId) {
        if self.g.is_spine(i) || self.arm_of.contains_key(&i) || self.value_of.contains_key(&i) || !self.live(i) {
            return;
        }
        for j in self.inputs(i) {
            self.lower_chain(j);
        }
        let node = &self.g.nodes[i];
        match &node.op {
            Op::Draw(items) => {
                if self.regs_leaf.contains_key(&i) {
                    return;
                }
                let decode = match items.first().map(|it| it.style) {
                    Some(DrawStyle::Distance { decode }) => decode * self.res.k[i],
                    _ => 0.0,
                };
                let v = self.values.len();
                self.values.push(Value { node: i, rect: self.dem.out[i], place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: items.first().cloned(), decode, root: None });
                self.value_of.insert(i, v);
            }
            op if is_head(op) || is_pointwise(op) => {
                let in0 = self.input(i, 0);
                let joins = is_pointwise(op)
                    && self.arm_of.get(&in0).is_some_and(|&a| {
                        self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == in0 && self.res.readers[in0].len() == 1
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
                        chain: self.chain,
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
            for j in self.inputs(i) {
                if self.arm_of.get(&j) == Some(&a) {
                    continue;
                }
                r = r.max(self.ready(j, self.in_space_of(self.read_rect(i), i, j)));
            }
            if let Op::Halo { of } = self.g.nodes[i].op {
                let inside = self.inside_of(i, self.dem.out[i]);
                r = r.max(self.ready(of, self.in_space_of(inside, i, of)));
            }
        }
        if let Some(c) = arm.compose {
            for j in self.inputs(c) {
                if self.arm_of.get(&j) == Some(&a) {
                    continue;
                }
                r = r.max(self.ready(j, self.dem.out[c]));
            }
        }
        r + 1
    }

    /// Land compose `c`: fold it into its value's arm when that arm has no other reader, else give
    /// it a headless arm of its own. Returns the compose's round.
    fn compose(&mut self, c: NodeId, value: NodeId) -> u32 {
        let foldable = self.arm_of.get(&value).is_some_and(|&a| {
            self.arms[a].compose.is_none() && *self.arms[a].nodes.last().unwrap() == value && self.res.readers[value].len() == 1
        });
        let a = if foldable {
            self.arm_of[&value]
        } else {
            let a = self.arms.len();
            self.arms.push(Arm {
                nodes: vec![],
                compose: None,
                chain: self.chain,
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

    /// The values arm `a` reads that are drawn rather than computed: leaves and halo spines.
    fn static_reads(&self, a: usize) -> Vec<usize> {
        let arm = &self.arms[a];
        let mut inputs: Vec<NodeId> = arm.nodes.iter().flat_map(|&i| self.read_nodes(i)).collect();
        if let Some(c) = arm.compose {
            inputs.extend(self.inputs(c));
        }
        let mut out = Vec::new();
        for j in inputs {
            if let Some(&v) = self.value_of.get(&j) {
                if self.values[v].leaf.is_some() && !out.contains(&v) {
                    out.push(v);
                }
            }
            if let Some(v) = self.halo_value(j) {
                if !out.contains(&v) {
                    out.push(v);
                }
            }
        }
        out
    }

    /// The texels the output of arm `a` occupies: nothing for a compose, which writes the frame,
    /// nor for a halo's arm, which writes the halo value it stands on.
    fn out_area(&self, a: usize) -> f64 {
        match self.arms[a].nodes.last() {
            Some(&tail) if self.arms[a].compose.is_none() && !matches!(self.g.nodes[tail].op, Op::Halo { .. }) => self.dem.out[tail].area(),
            _ => 0.0,
        }
    }

    /// Give every arm its round and every leaf or halo root its draw round (step 5): a chain's
    /// natural rounds, one after what each arm reads, its values drawn the round before their
    /// first reader, then the whole chain shifted later by the least amount that keeps every
    /// round's live texels within the budget beside the chains placed before it. A halo read
    /// by several chains is drawn for the first and kept for the rest. A distance leaf is baked
    /// by the executor ahead of every round, so it is born at 0 whatever its reader. A chain
    /// that fits nowhere within the rounds in use goes after them all.
    fn fit_rounds(&mut self) {
        let mut live: Vec<f64> = Vec::new();
        let mut drawn: Vec<bool> = vec![false; self.values.len()];
        let mut chains: Vec<NodeId> = self.arms.iter().map(|a| a.chain).collect();
        chains.dedup();
        for c in chains {
            let arms: Vec<usize> = (0..self.arms.len()).filter(|&a| self.arms[a].chain == c).collect();
            for &a in &arms {
                let r = self.arm_round(a);
                self.arms[a].round = r;
            }
            let mut spans: Vec<(f64, u32, u32)> = Vec::new();
            let mut own: Vec<(usize, u32, u32)> = Vec::new();
            for &a in &arms {
                let round = self.arms[a].round;
                let death = match self.arms[a].nodes.last() {
                    Some(&tail) => arms.iter().filter(|&&b| self.arms[b].nodes.iter().chain(self.arms[b].compose.as_ref()).any(|&i| self.inputs(i).contains(&tail))).map(|&b| self.arms[b].round).fold(round, u32::max),
                    None => round,
                };
                spans.push((self.out_area(a), round, death));
                for v in self.static_reads(a) {
                    match own.iter_mut().find(|(w, _, _)| *w == v) {
                        Some(slot) => {
                            slot.1 = slot.1.min(round.saturating_sub(1));
                            slot.2 = slot.2.max(round);
                        }
                        None => own.push((v, round.saturating_sub(1), round)),
                    }
                }
            }
            let baked: Vec<bool> = self.values.iter().map(|v| matches!(v.leaf, Some(DrawItem { style: DrawStyle::Distance { .. }, .. }))).collect();
            let far = live.len() as u32;
            let first = arms.iter().map(|&a| self.arms[a].round).min().unwrap_or(0);
            let mut shift = 0u32;
            loop {
                let lo = |v: usize, b: u32| if drawn[v] { self.values[v].birth } else if baked[v] { 0 } else { b + shift };
                let last = spans.iter().map(|s| s.2).chain(own.iter().map(|o| o.2)).max().unwrap_or(0) + shift;
                let fits = (0..=last).all(|r| {
                    let outs: f64 = spans.iter().filter(|s| s.1 + shift <= r && r <= s.2 + shift).map(|s| s.0).sum();
                    let statics: f64 = own
                        .iter()
                        .filter(|&&(v, b, d)| lo(v, b) <= r && r <= d + shift && !(drawn[v] && r <= self.values[v].last_read))
                        .map(|&(v, _, _)| self.values[v].rect.area())
                        .sum();
                    live.get(r as usize).copied().unwrap_or(0.0) + statics + outs <= self.store.budget()
                });
                if fits || first + shift > far {
                    break;
                }
                shift += 1;
            }
            for &a in &arms {
                self.arms[a].round += shift;
            }
            let last = spans.iter().map(|s| s.2).chain(own.iter().map(|o| o.2)).max().unwrap_or(0) + shift;
            if live.len() <= last as usize {
                live.resize(last as usize + 1, 0.0);
            }
            for s in &spans {
                for r in s.1 + shift..=s.2 + shift {
                    live[r as usize] += s.0;
                }
            }
            for &(v, b, d) in &own {
                let from = if drawn[v] { self.values[v].last_read + 1 } else if baked[v] { 0 } else { b + shift };
                for r in from..=d + shift {
                    live[r as usize] += self.values[v].rect.area();
                }
                if !drawn[v] {
                    self.values[v].birth = if baked[v] { 0 } else { b + shift };
                    drawn[v] = true;
                }
                self.values[v].last_read = self.values[v].last_read.max(d + shift);
            }
        }
    }

    /// Give every non-compose arm its value, mark every value's last reader, and pack the values
    /// into the rows below the frame.
    fn assign_pages(&mut self) {
        for a in 0..self.arms.len() {
            if self.arms[a].compose.is_some() {
                continue;
            }
            let tail = *self.arms[a].nodes.last().expect("an arm has nodes");
            if let Some(&v) = self.value_of.get(&tail) {
                self.arms[a].out = Some(v);
                continue;
            }
            let v = self.values.len();
            self.values.push(Value { node: tail, rect: self.dem.out[tail], place: Vec2::ZERO, birth: self.arms[a].round, last_read: self.arms[a].round, page: 0, leaf: None, decode: 0.0, root: None });
            self.value_of.insert(tail, v);
            self.arms[a].out = Some(v);
        }
        for a in 0..self.arms.len() {
            let round = self.arms[a].round;
            let mut inputs: Vec<NodeId> = self.arms[a].nodes.iter().flat_map(|&i| self.read_nodes(i)).collect();
            if let Some(c) = self.arms[a].compose {
                inputs.extend(self.inputs(c));
            }
            for j in inputs {
                if let Some(&v) = self.value_of.get(&j) {
                    self.values[v].last_read = self.values[v].last_read.max(round);
                }
                if let Some(v) = self.halo_value(j) {
                    self.values[v].last_read = self.values[v].last_read.max(round);
                }
            }
        }
        let mut order: Vec<usize> = (0..self.values.len()).collect();
        order.sort_by_key(|&v| (self.values[v].birth, v));
        let pitch = self.store.pitch;
        let mut packer = StorePacker::new((self.store.width / TILE_W) as u32);
        for v in order {
            let (rect, birth, death) = (self.values[v].rect, self.values[v].birth, self.values[v].last_read);
            let [x, y] = packer.place((rect.width() / TILE_W).ceil() as u32, (rect.height() / TILE_H).ceil() as u32, birth, death);
            let origin = Vec2::new(f64::from(x) * TILE_W, pitch + f64::from(y) * TILE_H);
            let page = (origin.y / pitch).floor() as usize;
            self.values[v].page = page;
            self.values[v].place = origin - Vec2::new(0.0, page as f64 * pitch) - rect.origin().to_vec2();
        }
    }

    /// How many pages the frame rents below its own rows: enough for the lowest value's rows.
    fn pages(&self) -> usize {
        let pitch = self.store.pitch;
        (0..self.values.len()).map(|v| (self.store_rect(v).y1 / pitch).ceil() as usize - 1).max().unwrap_or(0)
    }

    /// A value's rect in store texels: its frame rect slid by its placement, down by its page.
    fn store_rect(&self, v: usize) -> Rect {
        let val = &self.values[v];
        val.rect + val.place + Vec2::new(0.0, val.page as f64 * self.store.pitch)
    }

    /// Where arm `a` reads node `j`: the spine is the tile's own registers when a pointwise read
    /// lands on the rows the arm writes, and the rows of the spine `j` stands in otherwise (the
    /// frame, or a halo's value); a silhouette leaf is the marker's area; any other value is its
    /// store rect.
    fn operand_for(&self, a: usize, j: NodeId, shift: Vec2, pointwise: bool) -> Operand {
        if self.g.is_spine(j) {
            if pointwise && self.arms[a].compose.is_some() && shift == Vec2::ZERO {
                return Operand::Regs;
            }
            return self.spine_operand(j, shift);
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
                let d = shift * f64::from(self.res.k[self.values[v].node]) - self.values[v].place;
                r = [SRC_STORE, s.x0 as f32, s.y0 as f32, s.x1 as f32, s.y1 as f32, d.x as f32, d.y as f32, decode];
            }
            Operand::Frame => {
                let f = self.store.frame;
                r = [SRC_STORE, f.x0 as f32, f.y0 as f32, f.x1 as f32, f.y1 as f32, 0.0, 0.0, 0.0];
            }
        }
        r
    }

    fn unit_of(&self, i: NodeId) -> Option<UnitOp> {
        Some(match &self.g.nodes[i].op {
            Op::Blur { sigma, axis, linear, edge_clamp_style, .. } => UnitOp::Blur {
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
            Op::Warp(u) => UnitOp::Warp(bake::payload_at(u, self.res.k[i])),
            Op::Scatter(u) => UnitOp::Scatter(bake::payload_at(u, self.res.k[i])),
            Op::Shade(u) => UnitOp::Shade(bake::payload_at(u, self.res.k[i])),
            Op::MaskMix(u) => UnitOp::MaskMix(bake::payload_at(u, self.res.k[i])),
            Op::ClipToSource(u) => UnitOp::ClipToSource(u.clone()),
            Op::EraseBy(_) => UnitOp::EraseBy(Vec::new()),
            Op::Colour(_) | Op::Draw(_) | Op::Compose { .. } | Op::Scale { .. } | Op::Halo { .. } => return None,
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
        let mut blur: Option<(f32, u32, bool, bool)> = None;
        let mut program: Option<f32> = None;
        let mut scale: Option<(f32, f32)> = None;
        for (k, &i) in nodes.iter().enumerate() {
            let node = &self.g.nodes[i];
            match &node.op {
                Op::Blur { sigma, linear, axis, edge_clamp_style, taps } => {
                    blur = Some((*sigma * self.res.k[i], *taps, *linear, *axis == BlurAxis::Y));
                    edge_coverage = *edge_clamp_style == EdgeClampStyle::Transparent;
                }
                Op::Scale { .. } => {
                    let j = self.input(i, 0);
                    let past = if self.rooted_in_leaf(i) { bake::SCALE_TRANSPARENT } else { bake::SCALE_CLAMP };
                    scale = Some((self.res.k[j] / self.res.k[i], past));
                }
                Op::Colour(c) => tint = Some([c[0], c[1], c[2], c[3]]),
                Op::MaskMix(u) if u.get(bake::PAYLOAD_PROGRAM_SLOT).copied() == Some(bake::PROGRAM_RADIAL) => program = Some(bake::PROGRAM_RADIAL),
                Op::Halo { of } => scale = Some((self.res.k[*of] / self.res.k[i], bake::SCALE_KEEP)),
                _ => {}
            }
            if let Some(u) = self.unit_of(i) {
                run.push(u);
            }
            if k == 0 {
                value = match node.op {
                    Op::Halo { of } => self.spine_operand(of, Vec2::ZERO),
                    _ => self.operand_for(a, self.input(i, 0), Vec2::ZERO, is_pointwise(&node.op)),
                };
                if let (Op::Warp(_), Some(&sdf)) = (&node.op, node.inputs.get(1)) {
                    let sdf = self.res.alias[sdf];
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
                    reference = self.operand_for(a, self.input(i, 1), shift, true);
                }
                Op::MaskMix(_) | Op::ClipToSource(_) => {
                    reference = self.operand_for(a, self.input(i, 1), Vec2::ZERO, true);
                }
                _ => {}
            }
        }
        let mut policy = Policy { raw: compose.is_none(), edge_coverage, ..Policy::default() };
        if let Some(c) = compose {
            let Op::Compose { mode, colour, offset } = &self.g.nodes[c].op else { unreachable!() };
            let cnode = &self.g.nodes[c];
            if nodes.is_empty() {
                value = self.operand_for(a, self.input(c, 1), Vec2::new(f64::from(offset[0]), f64::from(offset[1])), true);
            } else if let Operand::Value { v, .. } = value {
                value = Operand::Value { v, shift: Vec2::new(f64::from(offset[0]), f64::from(offset[1])) };
            }
            if cnode.inputs.len() > 2 {
                coverage = self.operand_for(a, self.input(c, 2), Vec2::ZERO, true);
            }
            match (mode, colour) {
                (ComposeMode::Over, Some(c)) => {
                    policy.colour_over = true;
                    tint = Some(*c);
                }
                (ComposeMode::Over, None) => policy.value_over = true,
                (ComposeMode::MaskedMix, _) => {}
            }
            for j in self.inputs(c).into_iter().skip(1) {
                if let Some(&shape) = self.regs_leaf.get(&j) {
                    mask_shape = Some(shape);
                }
            }
        }
        for &i in &nodes {
            for j in self.inputs(i) {
                if let Some(&shape) = self.regs_leaf.get(&j) {
                    mask_shape = Some(shape);
                }
            }
        }
        let mut desc = match blur {
            Some((sigma, taps, linear, axis_y)) => bake::blur_arm(sigma, taps, linear, axis_y, policy, tint.filter(|_| policy.colour_over)),
            None => bake::arm_descriptor(&run, policy, program),
        };
        if let Some((ratio, past)) = scale {
            desc[0] = (desc[0] as u32 | bake::bits::SCALE) as f32;
            desc[2] = ratio;
            desc[3] = past;
        }
        if let Some(t) = tint {
            if !policy.colour_over {
                desc[0] = (desc[0] as u32 | bake::bits::TINT) as f32;
            }
            desc[14..18].copy_from_slice(&t);
        }
        let mut rec = [[0.0f32; 4]; 12];
        bake::stamp_field_anchor(&desc, &mut rec);
        let (out_rect, out_place) = match self.arms[a].out.or_else(|| compose.and_then(|c| self.halo_value(c))) {
            Some(v) => (self.store_rect(v), self.values[v].place),
            None => (self.dem.out[compose.expect("an arm composes or writes a value")], Vec2::ZERO),
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
        let (x0, y0, x1, y1) = ((r.x0 / TILE_W) as u32, (r.y0 / TILE_H) as u32, (r.x1 / TILE_W) as u32, (r.y1 / TILE_H) as u32);
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
        let pitch = self.store.pitch;
        let store_h = pitch * (1 + pages) as f64;
        let rounds = self.arms.iter().map(|a| a.round + 1).max().unwrap_or(1);

        let mut draws: Vec<DrawCmd> = Vec::new();
        let mut copies: Vec<Vec<Pass>> = vec![Vec::new(); rounds as usize + 1];
        let mut tiles: Vec<Vec<u32>> = vec![Vec::new(); rounds as usize];
        Self::tiles_of(self.store.frame, &mut tiles[0]);
        let mut work: Vec<u32> = vec![0; rounds as usize];
        work[0] |= frame_plan::work::PAINT;
        for arm in &self.arms {
            let w = &mut work[arm.round as usize];
            for &i in &arm.nodes {
                *w |= match &self.g.nodes[i].op {
                    Op::Scale { .. } | Op::Halo { .. } => frame_plan::work::SCALE,
                    Op::Warp(_) => frame_plan::work::WARP,
                    Op::Blur { .. } => frame_plan::work::BLUR,
                    Op::Scatter(_) => frame_plan::work::SCATTER,
                    _ => frame_plan::work::POINTWISE,
                };
            }
            if arm.compose.is_some() {
                *w |= frame_plan::work::POINTWISE;
            }
        }
        let mut page_work: Vec<(u32, u32, Vec<DrawCmd>)> = Vec::new();
        for (vi, v) in self.values.iter().enumerate() {
            let rect = self.store_rect(vi);
            let k = f64::from(self.res.k[v.node]);
            let origin = v.place + Vec2::new(0.0, v.page as f64 * pitch);
            let transform = if k == 1.0 { Affine::translate(origin) } else { Affine::translate(origin) * Affine::scale(k) };
            let items = match (&v.leaf, &v.root) {
                (Some(item), _) => {
                    if v.birth > 0 {
                        copies[v.birth as usize].push(Pass::Clear { rect, colour: [0.0; 4] });
                    }
                    let mut it = item.clone();
                    it.bounds = scale_rect(self.dem.out[v.node], 1.0 / k);
                    vec![it]
                }
                (None, Some(items)) => {
                    copies[v.birth as usize].push(Pass::Clear { rect, colour: self.g.background.components });
                    items.clone()
                }
                (None, None) => continue,
            };
            Self::tiles_of(rect, &mut tiles[v.birth as usize]);
            work[v.birth as usize] |= frame_plan::work::DRAW;
            let mut cmds = Vec::new();
            if v.birth > 0 {
                cmds.push(DrawCmd::Marker {
                    shape: 0,
                    transform: Affine::IDENTITY,
                    eid: bake::EID_BOUNDARY,
                    seg_after: v.birth,
                    round: v.birth,
                    footprint: rect,
                    ctl: 0,
                    params_off: 0,
                });
            }
            cmds.push(DrawCmd::Clip { rect });
            cmds.push(DrawCmd::Shapes { items, transform });
            cmds.push(DrawCmd::Unclip);
            page_work.push((v.birth, 0, cmds));
        }
        for i in 0..self.g.nodes.len() {
            let (Some(h), Op::Draw(_)) = (self.spines.halo_of[i], &self.g.nodes[i].op) else { continue };
            if self.g.nodes[i].inputs.is_empty() || !self.live(i) {
                continue;
            }
            let items = self.dem.kept[i].clone();
            if items.is_empty() {
                continue;
            }
            let v = self.value_of[&h];
            let birth = self.values[v].birth;
            let origin = self.values[v].place + Vec2::new(0.0, self.values[v].page as f64 * pitch);
            let k = f64::from(self.res.k[i]);
            let rect = self.dem.out[i] + origin;
            let round = self.ready(i, self.dem.out[i]).max(birth);
            Self::tiles_of(rect, &mut tiles[round as usize]);
            work[round as usize] |= frame_plan::work::DRAW;
            let transform = Affine::translate(origin) * Affine::scale(k);
            page_work.push((round, if round > birth { 2 } else { 0 }, vec![DrawCmd::Clip { rect }, DrawCmd::Shapes { items, transform }, DrawCmd::Unclip]));
        }
        for h in 0..self.g.nodes.len() {
            let Op::Halo { of } = self.g.nodes[h].op else { continue };
            if !self.live(h) || self.res.k[of] != self.res.k[h] || !self.fill_read(h) {
                continue;
            }
            let inside = self.inside_of(h, self.dem.out[h]);
            if inside.is_zero_area() {
                continue;
            }
            let v = self.value_of[&h];
            let copy_round = self.ready(h, inside).max(self.values[v].birth);
            if (copy_round as usize) < rounds as usize {
                let origin = self.values[v].place + Vec2::new(0.0, self.values[v].page as f64 * pitch);
                copies[copy_round as usize + 1].push(Pass::Copy { src: inside + self.spine_origin(of), dst: inside + origin });
            }
        }
        if pages > 0 {
            draws.push(DrawCmd::Clip { rect: Rect::new(0.0, 0.0, self.store.width, pitch) });
        }
        for i in 0..self.g.nodes.len() {
            if !self.live(i) || !self.g.is_spine(i) || self.spines.halo_of[i].is_some() {
                continue;
            }
            match &self.g.nodes[i].op {
                Op::Draw(_) => {
                    let items = self.dem.kept[i].clone();
                    if items.is_empty() {
                        continue;
                    }
                    draws.push(DrawCmd::Shapes { items, transform: Affine::IDENTITY });
                }
                Op::Compose { .. } => {
                    let a = self.arm_of[&i];
                    let arm = &self.arms[a];
                    let footprint = self.dem.out[i];
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
        if pages > 0 {
            draws.push(DrawCmd::Unclip);
        }
        for i in 0..self.g.nodes.len() {
            let (Some(h), Op::Compose { .. }) = (self.spines.halo_of[i], &self.g.nodes[i].op) else { continue };
            if !self.live(i) {
                continue;
            }
            let a = self.arm_of[&i];
            let arm = &self.arms[a];
            let vh = self.value_of[&h];
            let origin = self.values[vh].place + Vec2::new(0.0, self.values[vh].page as f64 * pitch);
            let k = f64::from(self.res.k[i]);
            let footprint = self.dem.out[i] + origin;
            Self::tiles_of(footprint, &mut tiles[arm.round as usize]);
            let marker = DrawCmd::Marker {
                shape: arm.mask_shape.unwrap_or(0),
                transform: Affine::translate(origin) * Affine::scale(k),
                eid: if arm.mask_shape.is_some() { bake::EID_MASKED } else { bake::EID_MATERIALIZE },
                seg_after: arm.round,
                round: arm.round,
                footprint,
                ctl: 0,
                params_off: arm.params_off,
            };
            page_work.push((arm.round, 1, vec![marker]));
        }
        for a in (0..self.arms.len()).filter(|&a| self.arms[a].compose.is_none()) {
            let arm = &self.arms[a];
            let footprint = self.store_rect(arm.out.expect("a page arm writes a value"));
            Self::tiles_of(footprint, &mut tiles[arm.round as usize]);
            let marker = DrawCmd::Marker {
                shape: 0,
                transform: Affine::IDENTITY,
                eid: bake::EID_MATERIALIZE,
                seg_after: arm.round,
                round: arm.round,
                footprint,
                ctl: 0,
                params_off: arm.params_off,
            };
            page_work.push((arm.round, 1, vec![marker]));
        }
        page_work.sort_by_key(|w| (w.0, w.1));
        draws.extend(page_work.into_iter().flat_map(|w| w.2));

        let mut passes = vec![Pass::Clear { rect: self.store.frame, colour: self.g.background.components }];
        if pages > 0 {
            passes.push(Pass::Clear { rect: Rect::new(0.0, self.store.frame.y1, self.store.width, store_h), colour: [0.0; 4] });
        }
        passes.push(Pass::Frontend { draws });
        for (r, list) in tiles.iter_mut().enumerate() {
            passes.append(&mut copies[r]);
            list.sort_unstable();
            list.dedup();
            let off = params.len() as u32;
            params.extend(list.iter().map(|&w| f32::from_bits(w)));
            let r = r as u32;
            passes.push(Pass::Fine { window: Window { rounds: (r, r + 1), tiles: Tiles::List { off, n: list.len() as u32 } }, work: work[r as usize] });
        }
        passes.push(Pass::Present { from: self.store.frame });
        FramePlan { store: (self.store.width as u32, store_h as u32), page: pitch as u32, params, passes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peniko::Color;
    use crate::vello::frame_graph::{DrawStyle, GNode, BLUR_TAPS};
    use crate::vello::resolve::settle;

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
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::X, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::Y, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![2], label: "by".into() },
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
    fn rounds_are_dependency_depth_and_live_values_share_a_page_apart() {
        let g = graph();
        g.validate().expect("valid");
        let mut s = Scheduler::new(&g, 640, 480, 8192, 4.0);
        s.build_arms();
        s.assign_pages();
        let arms: Vec<(Vec<NodeId>, Option<NodeId>, u32)> = s.arms.iter().map(|a| (a.nodes.clone(), a.compose, a.round)).collect();
        assert_eq!(arms[0], (vec![2], None, 1), "blur X reads the round-0 silhouette");
        assert_eq!(arms[1], (vec![3], Some(4), 2), "blur Y lands the drop shadow");
        assert_eq!(arms[2], (vec![6, 7, 8], Some(10), 3), "the lens is one arm landing the glass after the body draws");
        assert_eq!(s.pages(), 1, "both values fit beside each other on the first page");
        let sil = s.values.iter().position(|v| v.node == 1).unwrap();
        let bx = s.values.iter().position(|v| v.node == 2).unwrap();
        assert_eq!((s.values[sil].birth, s.values[sil].last_read), (0, 1));
        assert_eq!((s.values[bx].birth, s.values[bx].last_read), (1, 2));
        assert!(!overlaps(s.store_rect(sil), s.store_rect(bx)), "values alive in the same round never share a texel");
        assert!(s.store_rect(sil).y0 >= s.store.pitch && s.store_rect(bx).y0 >= s.store.pitch, "values sit below the frame rows");
    }

    #[test]
    fn the_plan_validates_and_lists_tiles_per_round() {
        let g = graph();
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(p.store, (640 + 2 * 96, 480 * 2), "the frame plus the shadow's two blur rings and their rounding on each side, whole tiles; two pages");
        let fines: Vec<&Pass> = p.passes.iter().filter(|p| matches!(p, Pass::Fine { .. })).collect();
        assert_eq!(fines.len(), 4, "rounds 0..3");
        for (r, f) in fines.iter().enumerate() {
            let Pass::Fine { window, .. } = f else { unreachable!() };
            assert_eq!(window.rounds, (r as u32, r as u32 + 1));
            let Tiles::List { n, .. } = window.tiles else { panic!("a tile list per round") };
            assert!(n > 0);
        }
        let shape = p.shape();
        assert_eq!(shape.markers, 3);
        assert_eq!(shape.rounds, 4);
    }

    /// Two nested backdrop gathers: a background glass `A` over the ground, and a downscaled glass
    /// `B` whose own backdrop is `A`'s output (a frost lens over another lens). `B`'s mask (`rb`)
    /// crosses the right frame edge, so `B`'s downscale reads `A` past the frame: the read the
    /// expansion reroutes through a halo.
    fn nested_gathers() -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let ra = Rect::new(100.0, 100.0, 300.0, 260.0);
        let rb = Rect::new(520.0, 150.0, 700.0, 360.0);
        let key = 0x99;
        let warp = |input| GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![input], label: "warp".into() };
        let shade = |input| GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![input], label: "shade".into() };
        FrameGraph {
            frame,
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                warp(0),
                shade(1),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![0, 2, 3], label: "glassA".into() },
                GNode { op: Op::Scale { target: 0.5, key }, inputs: vec![4], label: "down".into() },
                warp(5),
                shade(6),
                GNode { op: Op::Scale { target: 1.0, key }, inputs: vec![7], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, rb)]), inputs: vec![], label: "maskB".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![4, 8, 9], label: "glassB".into() },
            ],
        }
    }

    #[test]
    fn nested_gathers_plan_and_validate() {
        let p = plan(&nested_gathers(), 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert!(p.shape().markers >= 2, "both glasses land their compose: {}", p.shape().markers);
    }

    /// [`nested_gathers`] expanded by hand into DAG++ with glass `A`'s mask crossing the right
    /// edge too: `B`'s downscale reads `A` past the frame, so it reads a [`Op::Halo`] of `A`
    /// instead, whose spine is a root draw of the ground body, a fill point of the ground's
    /// in-frame state for the clone's sampling ring, and a clone of `A`'s chain (its mask leaf
    /// cloned) composed over it. `target` is `B`'s pair.
    fn halo_graph(target: f32) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let page = Rect::new(0.0, 0.0, 800.0, 480.0);
        let ra = Rect::new(500.0, 100.0, 700.0, 300.0);
        let rb = Rect::new(520.0, 150.0, 700.0, 360.0);
        let key = 0x99;
        let warp = |input| GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![input], label: "warp".into() };
        let shade = |input| GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![input], label: "shade".into() };
        let glass = |below, value, mask, label: &str| GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![below, value, mask], label: label.into() };
        FrameGraph {
            frame,
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![body(1, page)]), inputs: vec![], label: "ground".into() },
                warp(0),
                shade(1),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA".into() },
                glass(0, 2, 3, "glassA"),
                GNode { op: Op::Draw(vec![body(1, page)]), inputs: vec![], label: "root".into() },
                GNode { op: Op::Halo { of: 0 }, inputs: vec![5], label: "fill".into() },
                warp(6),
                shade(7),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA'".into() },
                glass(6, 8, 9, "glassA'"),
                GNode { op: Op::Halo { of: 4 }, inputs: vec![10], label: "halo".into() },
                GNode { op: Op::Scale { target, key }, inputs: vec![11], label: "down".into() },
                warp(12),
                shade(13),
                GNode { op: Op::Scale { target: 1.0, key }, inputs: vec![14], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, rb)]), inputs: vec![], label: "maskB".into() },
                glass(4, 15, 16, "glassB"),
            ],
        }
    }

    #[test]
    fn a_halo_continues_the_spine_past_the_frame_at_its_readers_resolution() {
        let g = halo_graph(0.5);
        g.validate().unwrap_or_else(|e| panic!("{e}"));
        let k = g.resolutions();
        assert_eq!((k[11], k[10], k[6], k[5], k[7], k[9]), (0.5, 0.5, 0.5, 0.5, 0.5, 0.5), "the halo, its spine, its fill point, the clone chain and its leaf run at the reader's k");
        assert_eq!((k[4], k[0], k[3]), (1.0, 1.0, 1.0), "the frame's spine and A's own leaf stay at 1");
        let mut s = Scheduler::new(&g, 640, 480, 8192, 4.0);
        s.build_arms();
        s.fit_rounds();
        s.assign_pages();
        let halo = s.value_of[&11];
        assert_eq!((s.value_of[&6], s.value_of[&5]), (halo, halo), "one value per spine: the fill point and the root share the halo's");
        let items: Vec<u128> = s.values[halo].root.as_ref().expect("the halo value is drawn from its root").iter().map(|it| it.shape).collect();
        assert_eq!(items, vec![1], "the root's items, pruned to the halo");
        assert!(s.dem.out[11].x1 > 320.0 && s.dem.out[11].x0 < 320.0, "the halo straddles the frame's right edge in half texels: {:?}", s.dem.out[11]);
        assert!(s.dem.out[10].x0 >= 320.0, "the clone composes only past the frame: {:?}", s.dem.out[10]);
        assert!(s.dem.out[6].x0 < 320.0 && s.dem.out[6].x1 > 320.0, "the fill point holds the clone's sampling ring inside the frame: {:?}", s.dem.out[6]);
        assert!(s.dem.out[5].x0 >= 320.0, "the root draws only past the frame: {:?}", s.dem.out[5]);
        assert_eq!(s.values[halo].rect, s.dem.out[6].union(s.dem.out[11]), "the value is what its spine demands, joined");
        assert!(s.dem.wanted[4].is_some_and(|d| d.x0 < 640.0 && d.x1 <= 640.0), "A is demanded in-frame for the halo's fill: {:?}", s.dem.wanted[4]);
        let (lower, clone, fill, outer) = (s.arm_of[&6], s.arm_of[&7], s.arm_of[&11], s.arm_of[&13]);
        assert_eq!((s.arms[lower].round, s.arms[clone].round, s.arms[fill].round, s.arms[outer].round), (1, 2, 3, 4), "the ring's fill, the clone chain, the halo's fill over it, then B's chain");
        assert_eq!((s.arms[lower].out, s.arms[fill].out), (Some(halo), Some(halo)), "both fills write the halo value");
        assert_eq!((s.values[halo].birth, s.values[halo].last_read), (0, 4), "drawn at 0, alive until B's warp has read it");
        let mut params = Vec::new();
        for a in 0..s.arms.len() {
            s.bake_arm(a, &mut params);
        }
        assert_eq!((s.arms[lower].value, s.arms[fill].value), (Operand::Frame, Operand::Frame), "the fills resample the frame rows");
        assert_eq!(s.arms[clone].value, Operand::Value { v: halo, shift: Vec2::ZERO }, "the clone's warp reads the halo value as its spine");
        assert_eq!(s.arms[outer].value, Operand::Value { v: halo, shift: Vec2::ZERO }, "B's warp reads the halo, not the frame");
        let desc = &params[s.arms[fill].params_off as usize..];
        assert_eq!((desc[0] as u32 & bake::bits::SCALE, desc[2], desc[3]), (bake::bits::SCALE, 2.0, bake::SCALE_KEEP), "a keep-scale by two");
    }

    #[test]
    fn a_halo_at_the_spines_resolution_is_one_copy() {
        let g = halo_graph(1.0);
        let mut s = Scheduler::new(&g, 640, 480, 8192, 4.0);
        s.build_arms();
        assert!(!s.arm_of.contains_key(&6) && !s.arm_of.contains_key(&11), "no fill arms at k 1");
        let p = plan_as_is(&g);
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        let mut fines = 0;
        let mut copies = Vec::new();
        for pass in &p.passes {
            match pass {
                Pass::Fine { .. } => fines += 1,
                Pass::Copy { src, dst } => copies.push((fines, *src, *dst)),
                _ => {}
            }
        }
        let [(ring_at, ring, ring_dst), (top_at, src, dst)] = copies[..] else { panic!("one copy per fill point: {copies:?}") };
        assert!(src.x1 <= 640.0 && src.y1 <= 480.0 && src.x0 >= 448.0, "copied from the frame rows where the halo overlaps them: {src:?}");
        assert!(ring.x1 <= 640.0 && ring.x0 >= 592.0 && ring.x0 > src.x0, "the ring is copied where the clone samples inside the frame edge, within the top's region: {ring:?}");
        assert!(dst.y0 >= 480.0 && ring_dst.y0 >= 480.0, "into the halo's page rows: {dst:?} {ring_dst:?}");
        assert_eq!((ring_at, top_at), (1, 2), "the ring after round 0 (the ground), the top after round 1 (both glass-A composes) and before B's chain in round 2");
        let frame_draws = p.passes.iter().filter_map(|p| match p { Pass::Frontend { draws } => Some(draws), _ => None }).next().unwrap();
        let identity_shapes = frame_draws.iter().filter(|d| matches!(d, DrawCmd::Shapes { transform, .. } if *transform == Affine::IDENTITY)).count();
        assert_eq!(identity_shapes, 1, "the frame draws the ground once; the root draws only into the halo");
    }

    #[test]
    fn a_halved_halo_plans_and_validates() {
        let p = plan_as_is(&halo_graph(0.5));
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert!(p.passes.iter().all(|p| !matches!(p, Pass::Copy { .. })), "the fill is an arm, not a copy");
        let frame_draws = p.passes.iter().filter_map(|p| match p { Pass::Frontend { draws } => Some(draws), _ => None }).next().unwrap();
        let halved = frame_draws.iter().filter(|d| matches!(d, DrawCmd::Shapes { transform, .. } if transform.as_coeffs()[0] == 0.5)).count();
        assert_eq!(halved, 1, "the root is drawn once at half resolution");
    }

    /// The plan of `g` as it is: no expansion.
    fn plan_as_is(g: &FrameGraph) -> FramePlan {
        let mut memory = HashMap::new();
        let mut s = Scheduler::new(g, 640, 480, 8192, 4.0);
        s.resolve(&mut memory);
        s.run()
    }

    fn halos(g: &FrameGraph) -> Vec<(NodeId, NodeId)> {
        g.nodes.iter().enumerate().filter_map(|(i, n)| match n.op { Op::Halo { of } => Some((i, of)), _ => None }).collect()
    }

    #[test]
    fn expansion_reroutes_the_escaping_read_through_a_halo_over_a_root_draw() {
        let g = nested_gathers();
        let x = expanded(&g, 640, 480, 8192, 4.0).expect("B reads A past the right edge");
        x.validate().unwrap_or_else(|e| panic!("{e}\n{}", crate::vello::graph_build::dump(&x)));
        let [(h, of)] = halos(&x)[..] else { panic!("one halo: {:?}", halos(&x)) };
        assert_eq!(x.nodes[of].label, "glassA", "the halo is of glass A");
        let root = x.spine_root(h);
        assert!(root != 0 && matches!(x.nodes[root].op, Op::Draw(ref items) if items.len() == 1 && items[0].shape == 1), "its spine roots at a draw of the ground: {}", x.nodes[root].label);
        assert_eq!(x.nodes[h].inputs, vec![root], "A's mask sits inside the frame, so nothing of A is cloned: the halo stands on the root");
        let down = x.nodes.iter().position(|n| n.label == "down").unwrap();
        assert_eq!(x.nodes[down].inputs, vec![h], "B's downscale reads the halo");
        assert!(x.nodes.iter().all(|n| n.label != "glassA @0"), "no clone of A");
        assert_eq!(x.nodes.len(), g.nodes.len() + 2, "a root and a halo");
        assert_eq!(x.resolutions()[h], 0.5, "the halo runs at B's k");
        plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new()).validate().unwrap_or_else(|e| panic!("{e}"));
    }

    #[test]
    fn expansion_clones_the_chains_whose_footprint_reaches_past_the_frame() {
        let mut g = nested_gathers();
        let Op::Draw(items) = &mut g.nodes[3].op else { unreachable!() };
        items[0].bounds = Rect::new(500.0, 100.0, 700.0, 300.0);
        let x = expanded(&g, 640, 480, 8192, 4.0).expect("both reads escape");
        x.validate().unwrap_or_else(|e| panic!("{e}\n{}", crate::vello::graph_build::dump(&x)));
        let hs = halos(&x);
        let of_a = hs.iter().filter(|&&(_, of)| x.nodes[of].label == "glassA").count();
        let of_ground = hs.iter().filter(|&&(_, of)| x.nodes[of].label == "ground").count();
        assert_eq!((of_a, of_ground), (1, 2), "a halo of A for B, a halo of the ground for A's own read, and the clone's fill point: {hs:?}");
        let clone = x.nodes.iter().position(|n| n.label == "glassA @1").expect("A cloned into B's instance");
        let fill = x.nodes[clone].inputs[0];
        assert!(matches!(x.nodes[fill].op, Op::Halo { of } if x.nodes[of].label == "ground"), "the clone stands on a fill point of the ground");
        let k = x.resolutions();
        assert_eq!((k[clone], k[fill]), (0.5, 0.5), "the clone runs at B's k");
        let mask = x.nodes[clone].inputs[2];
        assert!(x.nodes[mask].label.starts_with("maskA @"), "the clone's mask is its own leaf: {}", x.nodes[mask].label);
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
    }

    /// [`graph`] with a scale pair of `target` around the shadow's blurs and another around the
    /// lens's warp.
    fn scaled_graph(target: f32) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let b = Rect::new(100.0, 100.0, 300.0, 260.0);
        let g = Rect::new(200.0, 200.0, 400.0, 380.0);
        let blur = |axis, input| GNode { op: Op::Blur { sigma: 4.0, axis, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![input], label: String::new() };
        let scale = |target, input| GNode { op: Op::Scale { target, key: 0 }, inputs: vec![input], label: String::new() };
        let g = FrameGraph {
            frame,
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Draw(vec![cov(2, b)]), inputs: vec![], label: "sil".into() },
                scale(target, 1),
                blur(BlurAxis::X, 2),
                blur(BlurAxis::Y, 3),
                scale(1.0, 4),
                GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![0, 5], label: "drop".into() },
                GNode { op: Op::Draw(vec![body(2, b)]), inputs: vec![6], label: "body".into() },
                scale(target, 7),
                GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![8], label: "warp".into() },
                scale(1.0, 9),
                GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![10], label: "shade".into() },
                GNode { op: Op::MaskMix(vec![0.0; 24]), inputs: vec![11, 7], label: "mix".into() },
                GNode { op: Op::Draw(vec![cov(3, g)]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![7, 12, 13], label: "glass".into() },
            ],
        };
        g.validate().expect("valid");
        g
    }

    #[test]
    fn a_pair_between_equal_resolutions_is_nothing() {
        let plain = plan(&graph(), 640, 480, 8192, 4.0, &mut HashMap::new());
        let paired = plan(&scaled_graph(1.0), 640, 480, 8192, 4.0, &mut HashMap::new());
        assert_eq!(paired.store, plain.store);
        assert_eq!(paired.params, plain.params);
        assert_eq!(paired.passes.len(), plain.passes.len());
        assert_eq!(paired.shape(), plain.shape());
    }

    #[test]
    fn a_half_pair_runs_its_run_at_half_and_resamples_at_its_ends() {
        let g = scaled_graph(0.5);
        let mut s = Scheduler::new(&g, 640, 480, 8192, 4.0);
        assert!(s.res.elided[2], "a leaf's downscale is the leaf drawn at half");
        assert!(!s.res.elided[5] && !s.res.elided[8] && !s.res.elided[10]);
        assert_eq!((s.res.k[1], s.res.k[3], s.res.k[4], s.res.k[5], s.res.k[9], s.res.k[10]), (0.5, 0.5, 0.5, 1.0, 0.5, 1.0));
        s.build_arms();
        s.assign_pages();
        let mut params = Vec::new();
        for a in 0..s.arms.len() {
            s.bake_arm(a, &mut params);
        }
        let arms: Vec<(Vec<NodeId>, Option<NodeId>)> = s.arms.iter().map(|a| (a.nodes.clone(), a.compose)).collect();
        assert_eq!(arms[0], (vec![3], None), "blur X at half");
        assert_eq!(arms[1], (vec![4], None), "blur Y at half");
        assert_eq!(arms[2], (vec![5], Some(6)), "the upscale lands the shadow");
        assert_eq!(arms[3], (vec![8], None), "the downscale of the body's backdrop is its own arm");
        assert_eq!(arms[4], (vec![9], None), "the warp at half");
        assert_eq!(arms[5], (vec![10, 11, 12], Some(14)), "the upscale heads the lens's tail");
        assert!(matches!(s.arms[3].value, Operand::Frame), "a downscale of the spine reads the frame rows");
        let sil = s.values.iter().position(|v| v.node == 1).unwrap();
        let by = s.values.iter().position(|v| v.node == 4).unwrap();
        assert_eq!(s.values[sil].rect, Rect::new(48.0, 48.0, 160.0, 144.0), "the silhouette at half, with its AA, in tiles");
        assert_eq!(s.values[by].rect, Rect::new(16.0, 16.0, 192.0, 160.0), "the blur at half, padded twice by the half-resolution pad");
        let desc = |a: usize| &params[s.arms[a].params_off as usize..][..4];
        let at = |a: usize| (desc(a)[0] as u32 & bake::bits::SCALE != 0, desc(a)[2], desc(a)[3]);
        assert_eq!(at(2), (true, 0.5, bake::SCALE_TRANSPARENT), "up from a transparent chain");
        assert_eq!(at(3), (true, 2.0, bake::SCALE_CLAMP), "down from the spine, inside the frame");
        assert_eq!(at(5), (true, 0.5, bake::SCALE_CLAMP), "up from the backdrop chain");
        assert!(!at(0).0);
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let leaf = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if items.iter().any(|i| i.shape == 2 && matches!(i.style, DrawStyle::Coverage { .. })) => Some(*transform),
            _ => None,
        }).expect("the silhouette draw");
        let c = leaf.as_coeffs();
        assert_eq!((c[0], c[3]), (0.5, 0.5), "the leaf is drawn at half");
    }

    /// `n` drop shadows of sigma `sigma`, each under its own scale pair, over one ground.
    fn shadows(n: usize, sigma: f32, edge: EdgeClampStyle) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let mut nodes = vec![GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() }];
        for i in 0..n {
            let b = Rect::new(20.0 + 250.0 * i as f64, 100.0, 120.0 + 250.0 * i as f64, 260.0);
            let spine = nodes.len() - 1;
            let sil = nodes.len();
            nodes.push(GNode { op: Op::Draw(vec![cov(2 + i as u128, b)]), inputs: vec![], label: "sil".into() });
            nodes.push(GNode { op: Op::Scale { target: 1.0, key: i as u128 }, inputs: vec![sil], label: "down".into() });
            nodes.push(GNode { op: Op::Blur { sigma, axis: BlurAxis::X, linear: false, edge_clamp_style: edge, taps: BLUR_TAPS }, inputs: vec![sil + 1], label: "bx".into() });
            nodes.push(GNode { op: Op::Blur { sigma, axis: BlurAxis::Y, linear: false, edge_clamp_style: edge, taps: BLUR_TAPS }, inputs: vec![sil + 2], label: "by".into() });
            nodes.push(GNode { op: Op::Scale { target: 1.0, key: i as u128 }, inputs: vec![sil + 3], label: "up".into() });
            nodes.push(GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![spine, sil + 4], label: "drop".into() });
        }
        let g = FrameGraph { frame, background: Color::WHITE, nodes };
        g.validate().expect("valid");
        g
    }

    #[test]
    fn a_pair_settles_down_the_ladder_and_climbs_only_with_margin() {
        assert_eq!(settle(1.0, 0.3, None), 0.25);
        assert_eq!(settle(0.5, 0.7, None), 0.5, "never above the target");
        assert_eq!(settle(1.0, 0.6, Some(0.25)), 0.25, "the bound has not cleared the next rung by the margin");
        assert_eq!(settle(1.0, 0.7, Some(0.25)), 0.5, "it has now");
        assert_eq!(settle(1.0, 0.2, Some(0.5)), 0.125, "lowering is immediate");
        assert_eq!(settle(1.0, 3.0, Some(0.5)), 1.0, "a bound with slack climbs all the way");
    }

    #[test]
    fn the_store_is_as_wide_as_the_frame_plus_the_widest_ring_so_only_area_lowers_a_run() {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let g = FrameGraph {
            frame,
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Scale { target: 1.0, key: 7 }, inputs: vec![0], label: "down".into() },
                GNode { op: Op::Blur { sigma: 100.0, axis: BlurAxis::X, linear: true, edge_clamp_style: EdgeClampStyle::Extend, taps: BLUR_TAPS }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 100.0, axis: BlurAxis::Y, linear: true, edge_clamp_style: EdgeClampStyle::Extend, taps: BLUR_TAPS }, inputs: vec![2], label: "by".into() },
                GNode { op: Op::Scale { target: 1.0, key: 7 }, inputs: vec![3], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, Rect::new(100.0, 100.0, 540.0, 380.0))]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![0, 4, 5], label: "blur".into() },
            ],
        };
        g.validate().expect("valid");
        let mut memory = HashMap::new();
        let mut s = Scheduler::new(&g, 640, 480, 8192, 4.0);
        assert_eq!(s.store.width, 640.0 + 2.0 * 672.0, "two σ100 blurs read 308 px past their output each, plus a tile of rounding per read: the store grows by that ring on both sides");
        assert!(s.dem.out[2].width() > 640.0 && s.dem.out[2].width() <= s.store.width, "at target 1 the backdrop the blur needs is wider than the frame and no wider than the store: {:?}", s.dem.out[2]);
        s.resolve(&mut memory);
        assert_eq!(s.res.k[2], 0.5, "the pair's two links together exceed the store's texels: one rung down fits");
        assert!(s.dem.out[1].area() + s.dem.out[2].area() <= s.store.budget(), "{:?} {:?}", s.dem.out[1], s.dem.out[2]);
        assert!(!s.res.elided[1], "the pair is now real");
        assert_eq!(memory.get(&7), Some(&0.5), "the pair remembers what it ran at");
        let mut memory = HashMap::from([(7u128, 0.5f32)]);
        let mut s2 = Scheduler::new(&g, 640, 480, 8192, 4.0);
        s2.resolve(&mut memory);
        assert_eq!(memory.get(&7), Some(&0.5), "the same frame keeps last frame's resolution");
        let c = Scheduler::new(&g, 640, 480, 640, 4.0);
        assert_eq!(c.store.width, 640.0, "a device that cannot hold the ring caps the store at the frame's width, never below it");
    }

    #[test]
    fn chains_are_placed_first_fit_within_the_budget() {
        let g = shadows(3, 4.0, EdgeClampStyle::Transparent);
        let mut roomy = HashMap::new();
        let mut wide = Scheduler::new(&g, 640, 480, 8192, 4.0);
        let targets = wide.res.k.clone();
        wide.resolve(&mut roomy);
        assert_eq!(wide.res.k, targets, "three small shadows need no lowering with room to spare");
        wide.build_arms();
        wide.fit_rounds();
        let natural: Vec<u32> = wide.arms.iter().map(|a| a.round).collect();
        assert_eq!(natural, vec![1, 2, 1, 2, 1, 2], "disjoint chains run side by side: {natural:?}");

        let mut tight = HashMap::new();
        let mut s = Scheduler::new(&g, 640, 480, 480 + 64, 4.0);
        s.resolve(&mut tight);
        s.build_arms();
        s.fit_rounds();
        s.assign_pages();
        let rounds: Vec<(NodeId, u32)> = s.arms.iter().map(|a| (a.chain, a.round)).collect();
        let last = rounds.iter().map(|r| r.1).max().unwrap();
        assert!(last > 3, "a tight budget serialises the chains: {rounds:?}");
        for r in 0..=last {
            let live: f64 = s.values.iter().filter(|v| v.birth <= r && r <= v.last_read).map(|v| v.rect.area()).sum();
            assert!(live <= s.store.budget(), "round {r} holds {live} texels of a {} budget", s.store.budget());
        }
        assert!(rounds.windows(2).all(|w| w[0].0 != w[1].0 || w[0].1 < w[1].1), "each chain still runs in order: {rounds:?}");
    }

    #[test]
    fn demand_prunes_what_the_frame_never_sees() {
        let mut g = graph();
        let Op::Draw(items) = &mut g.nodes[0].op else { unreachable!() };
        items.push(body(9, Rect::new(2000.0, 2000.0, 2100.0, 2100.0)));
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let ground = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if *transform == Affine::IDENTITY && items.iter().any(|i| i.shape == 1) => Some(items),
            _ => None,
        }).expect("the ground draw");
        assert!(ground.iter().all(|it| it.shape != 9), "an off-frame item is dropped");
    }
}
