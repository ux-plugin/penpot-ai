//! The scheduler: frame graph in, frame plan out. Every decision about where and when is made
//! here, and the executor makes none.
//!
//! Seven steps, in order:
//! 1. **Demand.** Backward from the frame: a compose owes its demand to the state below and, less
//!    its offset, to its value; a neighbourhood op owes its input its own demand grown by its pad
//!    (a `Transparent` blur grows nothing — the clamp supplies zeros); a pointwise op passes its
//!    demand through; a scale owes its input its demand in the input's texels. A node's output
//!    rect is its demand clipped to its extent — the frame for the spine, and for a chain node
//!    whatever it reaches, past the frame included; a draw item that misses its draw's demand is
//!    dropped.
//! 2. **Capacity.** The store below the frame is a budget of texels. With demand known at every
//!    pair's target, each pair's resolution is decided in closed form, then demand runs again:
//!    the run between a pair may be no wider than the store, and no two adjacent links of it may
//!    together exceed half the budget — the other half holds everything drawn at round 0 (leaves
//!    and grounds), which a uniform step lowers first when they alone exceed it. Resolutions step
//!    down a ladder of halves, so a resample is a whole box; there is no floor. Across frames a
//!    pair keeps its resolution until the rule that set it has moved by a margin, so a zoom does
//!    not flicker.
//! 3. **Arms.** A chain is cut at its barriers: a head (a blur axis, a warp, a scatter, a scale)
//!    or a pointwise op over a leaf or the spine starts an arm, and the pointwise ops after it
//!    ride along while the value has no other reader. The compose folds into the arm that makes
//!    its value, which then writes the frame in place.
//! 4. **Serving** (ruling 13). A page arm that reads the spine past the frame reads a ground
//!    instead: one value per spine node, the union of every chain read of it, drawn once from the
//!    items below that node and overwritten by a copy of the frame rows where the two overlap,
//!    after the composes below have run. A scale of the spine carries its own ground, drawn at
//!    its resolution, and resamples the frame rows over it. Effects below the chain are absent
//!    past the frame.
//! 5. **Rounds.** An arm runs one round after everything it reads: a leaf is round 0, the spine
//!    at a node is the round of the last compose below it, an arm is its own round — and then
//!    each chain, in spine order, is shifted later by the least amount that keeps every round's
//!    live texels within the budget (first fit: chains that overlap in time only when they fit
//!    beside each other). Spine draws take the segment of the last compose below them. A tile
//!    runs every mark of a window in list order, so nothing else separates rounds.
//! 6. **Packing** (ruling 19, amended at R4). Every leaf, ground and arm output that is not a
//!    compose is a rect placed in the rows below the frame by [`StorePacker`], which hands out whole
//!    tiles and lets values whose lifetimes do not meet share them. Its origin splits back into the
//!    page fine folds rows by and the placement that rides the records.
//! 7. **Emission.** Clear (the frame and every ground rect to the background, the pages between
//!    to transparent), one front-end over the leaf and ground draws (each clipped to its
//!    store rect) and the spine in z-order (clipped to the frame once pages sit under it, so a
//!    shape reaching past the frame's bottom never paints a page) with a marker at every compose,
//!    and a marker per page arm; a ground's copy before the fine of the round after its copy
//!    round; one fine per round over that round's tiles; present. `params` holds one descriptor
//!    per arm and one tile list per round.

use std::collections::HashMap;

use crate::kurbo::{Affine, Rect, Vec2};

use crate::vello::bake::{self, Policy, REC_COUNT, REC_STRIDE};
use crate::vello::frame_graph::{pad_at, scale_rect, BlurAxis, ComposeMode, DrawItem, DrawStyle, EdgeClampStyle, FrameGraph, NodeId, Op};
use crate::vello::frame_plan::{DrawCmd, FramePlan, Pass, Tiles, Window};
use crate::vello::store_pack::StorePacker;
use crate::vello::units::{BlurEdge, UnitOp};

/// Pixel columns per tile. Must equal vello's `TILE_WIDTH`; the backend checks it at compile time.
pub const TILE_WIDTH: u32 = 16;
/// Pixel rows per tile. Must equal vello's `TILE_HEIGHT`; the backend checks it at compile time.
pub const TILE_HEIGHT: u32 = 16;
const TILE_W: f64 = TILE_WIDTH as f64;
const TILE_H: f64 = TILE_HEIGHT as f64;
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

/// The rows the store may hold below the frame, in frame heights, when the device allows them.
const STORE_PAGES: f64 = 4.0;
/// The share of the store's texels the budget counts on: the rest absorbs the packer's gaps.
const STORE_FILL: f64 = 0.75;
/// How far past the next rung the rule that lowered a pair must rise before the pair climbs back.
const CLIMB_MARGIN: f32 = 1.25;

/// The plan for `graph` on a `width × height` frame, on a device whose textures reach `max_dim`
/// texels a side. `memory` is what each pair ran at last frame, keyed by its `key`; the plan
/// reads it and writes what it chose.
#[must_use]
pub fn plan(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, memory: &mut HashMap<u128, f32>) -> FramePlan {
    Scheduler::new(graph, width, height, max_dim, memory).run()
}

/// The resolution a pair runs at this frame: `bound` is the highest its rules allow (the target
/// when none binds, and above it when they have slack), `prev` what it ran at last frame. It steps
/// down whenever the bound is below it, and climbs a rung only once the bound clears that rung by
/// [`CLIMB_MARGIN`]; never above `target`.
fn settle(target: f32, bound: f32, prev: Option<f32>) -> f32 {
    let mut k = target;
    while k > bound && k > f32::MIN_POSITIVE {
        k *= 0.5;
    }
    match prev {
        Some(p) if p < k && bound < p * 2.0 * CLIMB_MARGIN => p.max(k * 0.5).min(k),
        _ => k,
    }
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
/// spine node, drawn once over the whole rect, and whether the in-frame part is copied over them
/// from the frame rows once the spine is ready there — or left to a scale arm's resample.
#[derive(Clone, Debug)]
struct Ground {
    items: Vec<DrawItem>,
    copied: bool,
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
    frame: Rect,
    h: f64,
    /// The texels of store the plan counts on below the frame.
    budget: f64,
    /// What each pair ran at last frame and runs at this one, by its key.
    memory: &'a mut HashMap<u128, f32>,
    /// The resolution decided for each lowered pair, by its down node.
    lowered: HashMap<NodeId, f32>,
    /// The resolution each node's value runs at, a fraction of the frame's.
    k: Vec<f32>,
    /// A scale between equal resolutions is nothing: it is dropped and its readers read through it.
    elided: Vec<bool>,
    /// The node a reader really reads: itself, or what an elided scale reads.
    alias: Vec<NodeId>,
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
    /// The chain being lowered: its compose.
    chain: NodeId,
}

/// The largest whole-halving step at or above `x`: 1, 2, 4, ... .
fn ladder_up(x: f64) -> f64 {
    let mut s = 1.0;
    while s < x {
        s *= 2.0;
    }
    s
}

fn tile_round(r: Rect) -> Rect {
    Rect::new((r.x0 / TILE_W).floor() * TILE_W, (r.y0 / TILE_H).floor() * TILE_H, (r.x1 / TILE_W).ceil() * TILE_W, (r.y1 / TILE_H).ceil() * TILE_H)
}

fn union_into(slot: &mut Option<Rect>, r: Rect) {
    *slot = Some(slot.map_or(r, |s| s.union(r)));
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

fn is_head(op: &Op) -> bool {
    matches!(op, Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_) | Op::Scale { .. })
}

fn is_pointwise(op: &Op) -> bool {
    matches!(op, Op::Shade(_) | Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) | Op::Colour(_))
}

impl<'a> Scheduler<'a> {
    fn new(g: &'a FrameGraph, width: u32, height: u32, max_dim: u32, memory: &'a mut HashMap<u128, f32>) -> Self {
        let n = g.nodes.len();
        let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let pitch = (f64::from(height) / TILE_H).ceil() * TILE_H;
        let rows = (f64::from(max_dim) - pitch).max(0.0).min(STORE_PAGES * pitch);
        let mut s = Self {
            g,
            frame,
            h: f64::from(height),
            budget: rows * (frame.x1 / TILE_W).ceil() * TILE_W * STORE_FILL,
            memory,
            lowered: HashMap::new(),
            ext: Vec::new(),
            k: Vec::new(),
            elided: Vec::new(),
            alias: Vec::new(),
            demand: Vec::new(),
            out: Vec::new(),
            readers: Vec::new(),
            spine_round: HashMap::new(),
            arm_of: HashMap::new(),
            value_of: HashMap::new(),
            regs_leaf: HashMap::new(),
            ground_of: HashMap::new(),
            arms: Vec::new(),
            values: Vec::new(),
            pruned: HashMap::new(),
            chain: 0,
        };
        s.set_resolutions();
        s
    }

    /// Fix every node's resolution from the pairs' targets and what [`Self::decide`] lowered,
    /// and everything that follows from it: elision, aliases, readers, extents — and a demand
    /// pass yet to run.
    fn set_resolutions(&mut self) {
        let n = self.g.nodes.len();
        let lowered = &self.lowered;
        let k = self.g.resolutions_with(&|i, target| lowered.get(&i).copied().unwrap_or(target));
        let mut elided = vec![false; n];
        let mut alias: Vec<NodeId> = (0..n).collect();
        for (i, node) in self.g.nodes.iter().enumerate() {
            if let Op::Scale { .. } = node.op {
                if k[node.inputs[0]] == k[i] {
                    elided[i] = true;
                    alias[i] = alias[node.inputs[0]];
                }
            }
        }
        let mut readers = vec![Vec::new(); n];
        for (i, node) in self.g.nodes.iter().enumerate() {
            if elided[i] {
                continue;
            }
            for &j in &node.inputs {
                readers[alias[j]].push(i);
            }
        }
        self.ext = self.g.extents_at(&k);
        self.k = k;
        self.elided = elided;
        self.alias = alias;
        self.readers = readers;
        self.demand = vec![None; n];
        self.out = vec![Rect::ZERO; n];
        self.pruned.clear();
    }

    fn run(mut self) -> FramePlan {
        self.demand_pass();
        if self.decide() {
            self.set_resolutions();
            self.demand_pass();
        }
        self.build_arms();
        self.serve();
        self.fit_rounds();
        self.assign_pages();
        self.emit()
    }

    /// Whether scale `i` opens a pair: what it reads is not inside one.
    fn is_down(&self, i: NodeId) -> bool {
        let mut j = self.g.nodes[i].inputs[0];
        loop {
            let node = &self.g.nodes[j];
            if self.g.is_spine(j) || matches!(node.op, Op::Draw(_)) {
                return true;
            }
            if matches!(node.op, Op::Scale { .. }) {
                return false;
            }
            j = node.inputs[0];
        }
    }

    /// The links of the run pair `d` opens, in dependency order: the value each node between
    /// the pair makes, starting at the leaf drawn at the pair's resolution, the down node's own
    /// output, or — when the down node is nothing — the ops reading through it (what those read
    /// of the spine is the value the down node would make once lowered; [`Self::decide`] counts
    /// it); empty when nothing between the pair is demanded.
    fn links(&self, d: NodeId) -> Vec<NodeId> {
        let demanded = |i: NodeId| self.demand[i].is_some() && !self.out[i].is_zero_area();
        let mut links: Vec<NodeId> = Vec::new();
        if !self.elided[d] {
            links.push(d);
        } else if matches!(self.g.nodes[self.alias[d]].op, Op::Draw(_)) {
            links.push(self.alias[d]);
        } else {
            links.extend((0..self.g.nodes.len()).filter(|&r| self.g.nodes[r].inputs.contains(&d) && !matches!(self.g.nodes[r].op, Op::Scale { .. })));
        }
        links.retain(|&l| demanded(l));
        let mut i = 0;
        while i < links.len() {
            for &r in &self.readers[links[i]] {
                if matches!(self.g.nodes[r].op, Op::Scale { .. }) || links.contains(&r) || self.g.is_spine(r) {
                    continue;
                }
                if demanded(r) {
                    links.push(r);
                }
            }
            i += 1;
        }
        links
    }

    /// The texels drawn at round 0 as demand stands: every leaf that is a value, and every
    /// scale of the spine whose read leaves the frame (it carries a ground).
    fn static_area(&self) -> f64 {
        let mut area = 0.0;
        for i in 0..self.g.nodes.len() {
            if self.g.is_spine(i) || self.demand[i].is_none() || self.out[i].is_zero_area() || self.elided[i] {
                continue;
            }
            let node = &self.g.nodes[i];
            let counts = match &node.op {
                Op::Draw(_) => self.leaf_is_regs(i).is_none(),
                Op::Scale { .. } => self.g.is_spine(node.inputs[0]) && !self.frame.contains_rect(scale_rect(self.out[i], 1.0 / f64::from(self.k[i]))),
                _ => false,
            };
            if counts {
                area += self.out[i].area();
            }
        }
        area
    }

    /// Decide every pair's resolution from the demand at its target (step 2). Returns whether
    /// any pair now runs below its target, so demand must be measured again.
    fn decide(&mut self) -> bool {
        let half = self.budget / 2.0;
        let width = self.store_width();
        let statics = self.static_area();
        let valve = if statics > half { ladder_up((statics / half).sqrt()) } else { 1.0 };
        let mut seen: Vec<u128> = Vec::new();
        for d in 0..self.g.nodes.len() {
            let Op::Scale { target, key } = self.g.nodes[d].op else { continue };
            if !self.is_down(d) {
                continue;
            }
            let links = self.links(d);
            if links.is_empty() {
                continue;
            }
            let t = self.k[d];
            let mut widest = links.iter().map(|&l| self.out[l].width()).fold(0.0, f64::max);
            let mut peak: f64 = 0.0;
            if self.elided[d] && self.g.is_spine(self.g.nodes[d].inputs[0]) {
                for &l in links.iter().filter(|&&l| self.g.nodes[l].inputs.contains(&d)) {
                    let r = self.read_rect(l);
                    widest = widest.max(r.width());
                    peak = peak.max(r.area() + self.out[l].area());
                }
            }
            for &l in &links {
                let a = self.out[l].area();
                for &r in &self.readers[l] {
                    if links.contains(&r) {
                        peak = peak.max(a + self.out[r].area());
                    }
                }
                peak = peak.max(a);
            }
            let bound = f64::from(t) * (width / widest).min((half / peak).sqrt()) / valve;
            let k = settle(target, bound as f32, self.memory.get(&key).copied());
            seen.push(key);
            self.memory.insert(key, k);
            if k < t {
                self.lowered.insert(d, k);
            }
        }
        self.memory.retain(|key, _| seen.contains(key));
        !self.lowered.is_empty()
    }

    /// Input `n` of node `i`, read through any elided scale.
    fn input(&self, i: NodeId, n: usize) -> NodeId {
        self.alias[self.g.nodes[i].inputs[n]]
    }

    /// Every input of node `i`, read through any elided scale.
    fn inputs(&self, i: NodeId) -> Vec<NodeId> {
        self.g.nodes[i].inputs.iter().map(|&j| self.alias[j]).collect()
    }

    /// `r`, given in node `from`'s texels, in node `to`'s.
    fn in_space_of(&self, r: Rect, from: NodeId, to: NodeId) -> Rect {
        if self.k[from] == self.k[to] {
            r
        } else {
            scale_rect(r, f64::from(self.k[to] / self.k[from]))
        }
    }

    /// The extent a reader may see of node `i`: the frame for the spine (its rows hold the page
    /// colour everywhere), everything for a scale of the spine (its ground holds the page colour
    /// past the draws), a leaf's bounds plus the pixel its antialiased edge spills into, the
    /// node's own extent for any other chain value.
    fn visible_extent(&self, i: NodeId) -> Rect {
        let node = &self.g.nodes[i];
        if self.g.is_spine(i) {
            self.frame
        } else if matches!(node.op, Op::Scale { .. }) && self.g.is_spine(node.inputs[0]) {
            Rect::new(-1e9, -1e9, 1e9, 1e9)
        } else if matches!(node.op, Op::Draw(_)) {
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
            if self.elided[i] {
                union_into(&mut self.demand[node.inputs[0]], d);
                continue;
            }
            let out = match &node.op {
                Op::Compose { offset, .. } => {
                    let v = self.ext[node.inputs[1]] + Vec2::new(f64::from(offset[0]), f64::from(offset[1]));
                    let v = node.inputs.get(2).map_or(v, |&c| v.intersect(self.ext[c]));
                    d.intersect(v)
                }
                _ => d.intersect(self.visible_extent(i)),
            };
            let out = if self.g.is_spine(i) { tile_round(out).intersect(tile_round(self.frame)) } else { tile_round(out) };
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
            let k = self.k[i];
            match &node.op {
                Op::Draw(items) => {
                    let frame_out = scale_rect(out, 1.0 / f64::from(k));
                    let kept: Vec<DrawItem> = items.iter().filter(|it| overlaps(it.bounds, frame_out)).cloned().collect();
                    self.pruned.insert(i, kept);
                }
                Op::Blur { edge_clamp_style, .. } => {
                    let r = if *edge_clamp_style == EdgeClampStyle::Transparent { out } else { grown(pad_at(&node.op, k)) };
                    union_into(&mut self.demand[node.inputs[0]], r);
                }
                Op::Scale { .. } => {
                    let j = node.inputs[0];
                    union_into(&mut self.demand[j], scale_rect(out, f64::from(self.k[j] / k)));
                }
                Op::Warp(_) | Op::Scatter(_) => {
                    union_into(&mut self.demand[node.inputs[0]], grown(pad_at(&node.op, k)));
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
        !self.elided[i] && self.demand[i].is_some() && !self.out[i].is_zero_area()
    }

    /// Whether node `i` is a scale between different resolutions: an arm that resamples.
    fn is_scale(&self, i: NodeId) -> bool {
        matches!(self.g.nodes[i].op, Op::Scale { .. }) && !self.elided[i]
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
                    self.chain = i;
                    let value = self.input(i, 1);
                    let cov = self.g.nodes[i].inputs.get(2).map(|&c| self.alias[c]);
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

    /// The region node `i` reads of an input, in `i`'s own texels: its output grown by its pad.
    fn read_rect(&self, i: NodeId) -> Rect {
        let p = f64::from(pad_at(&self.g.nodes[i].op, self.k[i]));
        self.out[i].inflate(p, p)
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
                    Some(DrawStyle::Distance { decode }) => decode * self.k[i],
                    _ => 0.0,
                };
                let v = self.values.len();
                self.values.push(Value { node: i, rect: self.out[i], place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: items.first().cloned(), decode, ground: None });
                self.value_of.insert(i, v);
            }
            op if is_head(op) || is_pointwise(op) => {
                let in0 = self.input(i, 0);
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
        }
        if let Some(c) = arm.compose {
            for j in self.inputs(c) {
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

    /// The rect chain node `i` reads of its input `j`, in `j`'s texels: its output grown by its
    /// pad for a head, its output for a pointwise op, displaced for an `EraseBy` reference.
    fn read_of(&self, i: NodeId, j: NodeId) -> Rect {
        let node = &self.g.nodes[i];
        let r = match &node.op {
            Op::EraseBy(u) if node.inputs.get(1).map(|&x| self.alias[x]) == Some(j) => {
                let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                self.out[i] - shift
            }
            op if is_head(op) && self.input(i, 0) == j => self.read_rect(i),
            _ => self.out[i],
        };
        self.in_space_of(r, i, j)
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
            if arm.compose.is_some() || arm.nodes.first().is_some_and(|&i| self.is_scale(i)) {
                continue;
            }
            for &i in &arm.nodes {
                for j in self.inputs(i) {
                    if !self.g.is_spine(j) {
                        continue;
                    }
                    let r = tile_round(self.read_of(i, j));
                    let e = escapes.entry(j).or_default();
                    *e |= !(self.frame.x0 <= r.x0 && r.x1 <= self.frame.x1 && self.frame.y0 <= r.y0 && r.y1 <= self.frame.y1);
                    reads.entry(j).and_modify(|u| *u = u.union(r)).or_insert(r);
                }
            }
        }
        let mut nodes: Vec<NodeId> = reads.keys().copied().filter(|j| escapes[j]).collect();
        nodes.sort_unstable();
        for j in nodes {
            let rect = reads[&j];
            let items = self.spine_items_below(j, rect);
            let v = self.values.len();
            self.values.push(Value { node: j, rect, place: Vec2::ZERO, birth: 0, last_read: 0, page: 0, leaf: None, decode: 0.0, ground: Some(Ground { items, copied: true }) });
            self.ground_of.insert(j, v);
        }
    }

    /// The values arm `a` reads that were drawn at round 0: leaves and grounds.
    fn static_reads(&self, a: usize) -> Vec<usize> {
        let arm = &self.arms[a];
        let mut inputs: Vec<NodeId> = arm.nodes.iter().flat_map(|&i| self.inputs(i)).collect();
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
            if arm.compose.is_none() {
                if let Some(&v) = self.ground_of.get(&j) {
                    if !out.contains(&v) {
                        out.push(v);
                    }
                }
            }
        }
        out
    }

    /// The texels the output of arm `a` occupies: nothing for a compose, which writes the frame.
    fn out_area(&self, a: usize) -> f64 {
        match self.arms[a].nodes.last() {
            Some(&tail) if self.arms[a].compose.is_none() => self.out[tail].area(),
            _ => 0.0,
        }
    }

    /// Give every arm its round (step 5): its natural round, one after what it reads, then the
    /// whole chain shifted later by the least amount that keeps every round's live texels within
    /// the budget beside the chains placed before it. A value drawn at round 0 counts against
    /// every round until the last chain reading it is placed; a chain that fits nowhere within
    /// the rounds in use goes after them all.
    fn fit_rounds(&mut self) {
        let mut live: Vec<f64> = Vec::new();
        let mut unplaced: f64 = self.values.iter().filter(|v| v.birth == 0).map(|v| v.rect.area()).sum();
        let mut readers_left: HashMap<usize, usize> = HashMap::new();
        for a in 0..self.arms.len() {
            for v in self.static_reads(a) {
                *readers_left.entry(v).or_default() += 1;
            }
        }
        let mut chains: Vec<NodeId> = self.arms.iter().map(|a| a.chain).collect();
        chains.dedup();
        for c in chains {
            let arms: Vec<usize> = (0..self.arms.len()).filter(|&a| self.arms[a].chain == c).collect();
            for &a in &arms {
                let r = self.arm_round(a);
                self.arms[a].round = r;
            }
            let mut spans: Vec<(f64, u32, u32)> = Vec::new();
            let mut own: Vec<(usize, u32)> = Vec::new();
            for &a in &arms {
                let round = self.arms[a].round;
                let death = match self.arms[a].nodes.last() {
                    Some(&tail) => arms.iter().filter(|&&b| self.arms[b].nodes.iter().chain(self.arms[b].compose.as_ref()).any(|&i| self.inputs(i).contains(&tail))).map(|&b| self.arms[b].round).fold(round, u32::max),
                    None => round,
                };
                spans.push((self.out_area(a), round, death));
                for v in self.static_reads(a) {
                    match own.iter_mut().find(|(w, _)| *w == v) {
                        Some(slot) => slot.1 = slot.1.max(round),
                        None => own.push((v, round)),
                    }
                }
            }
            let own_total: f64 = own.iter().map(|&(v, _)| self.values[v].rect.area()).sum();
            let far = live.len() as u32;
            let first = arms.iter().map(|&a| self.arms[a].round).min().unwrap_or(0);
            let mut shift = 0u32;
            loop {
                let last = spans.iter().map(|s| s.2).max().unwrap_or(0) + shift;
                let fits = (0..=last).all(|r| {
                    let outs: f64 = spans.iter().filter(|s| s.1 + shift <= r && r <= s.2 + shift).map(|s| s.0).sum();
                    let statics: f64 = own.iter().filter(|&&(_, d)| r <= d + shift).map(|&(v, _)| self.values[v].rect.area()).sum();
                    live.get(r as usize).copied().unwrap_or(0.0) + unplaced - own_total + statics + outs <= self.budget
                });
                if fits || first + shift > far {
                    break;
                }
                shift += 1;
            }
            for &a in &arms {
                self.arms[a].round += shift;
            }
            let last = spans.iter().map(|s| s.2).max().unwrap_or(0) + shift;
            if live.len() <= last as usize {
                live.resize(last as usize + 1, 0.0);
            }
            for s in &spans {
                for r in s.1 + shift..=s.2 + shift {
                    live[r as usize] += s.0;
                }
            }
            for &(v, d) in &own {
                let left = readers_left.get_mut(&v).expect("a read static is counted");
                *left -= arms.iter().filter(|&&a| self.static_reads(a).contains(&v)).count();
                if *left == 0 {
                    unplaced -= self.values[v].rect.area();
                    for r in 0..=d + shift {
                        live[r as usize] += self.values[v].rect.area();
                    }
                }
            }
            let round = self.arms[*arms.last().expect("a chain has arms")].round;
            self.spine_round.insert(c, round);
            let mut s = c + 1;
            while s < self.g.nodes.len() && self.g.is_spine(s) && matches!(self.g.nodes[s].op, Op::Draw(_)) {
                self.spine_round.insert(s, round);
                s += 1;
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
            let v = self.values.len();
            self.values.push(Value { node: tail, rect: self.out[tail], place: Vec2::ZERO, birth: self.arms[a].round, last_read: self.arms[a].round, page: 0, leaf: None, decode: 0.0, ground: None });
            self.value_of.insert(tail, v);
            self.arms[a].out = Some(v);
            let head = self.arms[a].nodes[0];
            if self.is_scale(head) {
                let j = self.input(head, 0);
                if self.g.is_spine(j) {
                    let region = self.read_of(head, j);
                    let escapes = !(self.frame.x0 <= region.x0 && region.x1 <= self.frame.x1 && self.frame.y0 <= region.y0 && region.y1 <= self.frame.y1);
                    if escapes {
                        let items = self.spine_items_below(j, region);
                        self.values[v].ground = Some(Ground { items, copied: false });
                        self.values[v].birth = 0;
                    }
                }
            }
        }
        for a in 0..self.arms.len() {
            let round = self.arms[a].round;
            let mut inputs: Vec<NodeId> = self.arms[a].nodes.iter().flat_map(|&i| self.inputs(i)).collect();
            if let Some(c) = self.arms[a].compose {
                inputs.extend(self.inputs(c));
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
        let pitch = self.pitch();
        let mut packer = StorePacker::new((self.store_width() / TILE_W) as u32);
        for v in order {
            let (rect, birth, death) = (self.values[v].rect, self.values[v].birth, self.values[v].last_read);
            let [x, y] = packer.place((rect.width() / TILE_W).ceil() as u32, (rect.height() / TILE_H).ceil() as u32, birth, death);
            let origin = Vec2::new(f64::from(x) * TILE_W, pitch + f64::from(y) * TILE_H);
            let page = (origin.y / pitch).floor() as usize;
            self.values[v].page = page;
            self.values[v].place = origin - Vec2::new(0.0, page as f64 * pitch) - rect.origin().to_vec2();
        }
    }

    /// The store's width: the frame's, rounded up to whole tiles so a value against the right edge
    /// keeps its last column.
    fn store_width(&self) -> f64 {
        (self.frame.x1 / TILE_W).ceil() * TILE_W
    }

    /// How many pages the frame rents below its own rows: enough for the lowest value's rows.
    fn pages(&self) -> usize {
        let pitch = self.pitch();
        (0..self.values.len()).map(|v| (self.store_rect(v).y1 / pitch).ceil() as usize - 1).max().unwrap_or(0)
    }

    /// The page pitch: the frame height rounded up to whole tiles.
    fn pitch(&self) -> f64 {
        (self.h / TILE_H).ceil() * TILE_H
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
            if self.arms[a].compose.is_none() && !self.is_scale(self.arms[a].nodes[0]) {
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
                let d = shift * f64::from(self.k[self.values[v].node]) - self.values[v].place;
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
            Op::Warp(u) => UnitOp::Warp(bake::payload_at(u, self.k[i])),
            Op::Scatter(u) => UnitOp::Scatter(bake::payload_at(u, self.k[i])),
            Op::Shade(u) => UnitOp::Shade(bake::payload_at(u, self.k[i])),
            Op::MaskMix(u) => UnitOp::MaskMix(bake::payload_at(u, self.k[i])),
            Op::ClipToSource(u) => UnitOp::ClipToSource(u.clone()),
            Op::EraseBy(_) => UnitOp::EraseBy(Vec::new()),
            Op::Colour(_) | Op::Draw(_) | Op::Compose { .. } | Op::Scale { .. } => return None,
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
                    blur = Some((*sigma * self.k[i], *taps, *linear, *axis == BlurAxis::Y));
                    edge_coverage = *edge_clamp_style == EdgeClampStyle::Transparent;
                }
                Op::Scale { .. } => {
                    let j = self.input(i, 0);
                    let grounded = self.arms[a].out.is_some_and(|v| self.values[v].ground.is_some());
                    let past = if grounded { bake::SCALE_KEEP } else if self.rooted_in_leaf(i) { bake::SCALE_TRANSPARENT } else { bake::SCALE_CLAMP };
                    scale = Some((self.k[j] / self.k[i], past));
                }
                Op::Colour(c) => tint = Some([c[0], c[1], c[2], c[3]]),
                Op::MaskMix(u) if u.get(bake::PAYLOAD_PROGRAM_SLOT).copied() == Some(bake::PROGRAM_RADIAL) => program = Some(bake::PROGRAM_RADIAL),
                _ => {}
            }
            if let Some(u) = self.unit_of(i) {
                run.push(u);
            }
            if k == 0 {
                value = self.operand_for(a, self.input(i, 0), Vec2::ZERO, is_pointwise(&node.op));
                if let (Op::Warp(_), Some(&sdf)) = (&node.op, node.inputs.get(1)) {
                    let sdf = self.alias[sdf];
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
            let k = f64::from(self.k[v.node]);
            let origin = v.place + Vec2::new(0.0, v.page as f64 * pitch);
            let transform = if k == 1.0 { Affine::translate(origin) } else { Affine::translate(origin) * Affine::scale(k) };
            if let Some(item) = &v.leaf {
                let mut it = item.clone();
                it.bounds = scale_rect(self.out[v.node], 1.0 / k);
                draws.push(DrawCmd::Shapes { items: vec![it], transform, clip: Some(rect) });
                Self::tiles_of(rect, &mut tiles[0]);
            }
            if let Some(ground) = &v.ground {
                grounds.push(Pass::Clear { rect, colour: self.g.background.components });
                draws.push(DrawCmd::Shapes { items: ground.items.clone(), transform, clip: Some(rect) });
                Self::tiles_of(rect, &mut tiles[0]);
                let inside = v.rect.intersect(self.frame);
                if ground.copied && !inside.is_zero_area() {
                    let copy_round = self.ready(v.node, inside);
                    if (copy_round as usize) < rounds as usize {
                        copies[copy_round as usize + 1].push(Pass::Copy { src: inside, dst: inside + origin });
                    }
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
        FramePlan { store: (self.store_width() as u32, store_h as u32), page: pitch as u32, params, passes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peniko::Color;
    use crate::vello::frame_graph::{DrawStyle, GNode, BLUR_TAPS};

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
        let mut memory = HashMap::new();
        let mut s = Scheduler::new(&g, 640, 480, 8192, &mut memory);
        s.demand_pass();
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
        assert!(s.store_rect(sil).y0 >= s.pitch() && s.store_rect(bx).y0 >= s.pitch(), "values sit below the frame rows");
    }

    #[test]
    fn the_plan_validates_and_lists_tiles_per_round() {
        let g = graph();
        let p = plan(&g, 640, 480, 8192, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(p.store, (640, 480 * 2));
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
        let plain = plan(&graph(), 640, 480, 8192, &mut HashMap::new());
        let paired = plan(&scaled_graph(1.0), 640, 480, 8192, &mut HashMap::new());
        assert_eq!(paired.store, plain.store);
        assert_eq!(paired.params, plain.params);
        assert_eq!(paired.passes.len(), plain.passes.len());
        assert_eq!(paired.shape(), plain.shape());
    }

    #[test]
    fn a_half_pair_runs_its_run_at_half_and_resamples_at_its_ends() {
        let g = scaled_graph(0.5);
        let mut memory = HashMap::new();
        let mut s = Scheduler::new(&g, 640, 480, 8192, &mut memory);
        assert!(s.elided[2], "a leaf's downscale is the leaf drawn at half");
        assert!(!s.elided[5] && !s.elided[8] && !s.elided[10]);
        assert_eq!((s.k[1], s.k[3], s.k[4], s.k[5], s.k[9], s.k[10]), (0.5, 0.5, 0.5, 1.0, 0.5, 1.0));
        s.demand_pass();
        s.build_arms();
        s.serve();
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
        let p = plan(&g, 640, 480, 8192, &mut HashMap::new());
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
    fn a_run_wider_than_the_store_is_lowered_until_it_fits() {
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
        let mut s = Scheduler::new(&g, 640, 480, 8192, &mut memory);
        s.demand_pass();
        assert!(s.out[2].width() > 640.0, "at target 1 the backdrop the blur needs is wider than the store: {:?}", s.out[2]);
        assert!(s.decide());
        s.set_resolutions();
        s.demand_pass();
        assert_eq!(s.k[2], 0.25, "two rungs down fit");
        assert!(s.out[1].width() <= 640.0 && s.out[2].width() <= 640.0, "{:?} {:?}", s.out[1], s.out[2]);
        assert!(!s.elided[1], "the pair is now real");
        assert_eq!(memory.get(&7), Some(&0.25), "the pair remembers what it ran at");
        let mut memory = HashMap::from([(7u128, 0.25f32)]);
        let s2 = Scheduler::new(&g, 640, 480, 8192, &mut memory);
        drop(s2);
        assert_eq!(memory.get(&7), Some(&0.25), "an untouched memory keeps last frame");
    }

    #[test]
    fn chains_are_placed_first_fit_within_the_budget() {
        let g = shadows(3, 4.0, EdgeClampStyle::Transparent);
        let mut roomy = HashMap::new();
        let wide = Scheduler::new(&g, 640, 480, 8192, &mut roomy);
        let mut wide = wide;
        wide.demand_pass();
        assert!(!wide.decide(), "three small shadows need no lowering with room to spare");
        wide.build_arms();
        wide.serve();
        wide.fit_rounds();
        let natural: Vec<u32> = wide.arms.iter().map(|a| a.round).collect();
        assert_eq!(natural, vec![1, 2, 1, 2, 1, 2], "disjoint chains run side by side: {natural:?}");

        let mut tight = HashMap::new();
        let mut s = Scheduler::new(&g, 640, 480, 480 + 64, &mut tight);
        s.demand_pass();
        if s.decide() {
            s.set_resolutions();
            s.demand_pass();
        }
        s.build_arms();
        s.serve();
        s.fit_rounds();
        s.assign_pages();
        let rounds: Vec<(NodeId, u32)> = s.arms.iter().map(|a| (a.chain, a.round)).collect();
        let last = rounds.iter().map(|r| r.1).max().unwrap();
        assert!(last > 3, "a tight budget serialises the chains: {rounds:?}");
        for r in 0..=last {
            let live: f64 = s.values.iter().filter(|v| v.birth <= r && r <= v.last_read).map(|v| v.rect.area()).sum();
            assert!(live <= s.budget, "round {r} holds {live} texels of a {} budget", s.budget);
        }
        assert!(rounds.windows(2).all(|w| w[0].0 != w[1].0 || w[0].1 < w[1].1), "each chain still runs in order: {rounds:?}");
    }

    #[test]
    fn demand_prunes_what_the_frame_never_sees() {
        let mut g = graph();
        let Op::Draw(items) = &mut g.nodes[0].op else { unreachable!() };
        items.push(body(9, Rect::new(2000.0, 2000.0, 2100.0, 2100.0)));
        let p = plan(&g, 640, 480, 8192, &mut HashMap::new());
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let ground = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if *transform == Affine::IDENTITY && items.iter().any(|i| i.shape == 1) => Some(items),
            _ => None,
        }).expect("the ground draw");
        assert!(ground.iter().all(|it| it.shape != 9), "an off-frame item is dropped");
    }
}
