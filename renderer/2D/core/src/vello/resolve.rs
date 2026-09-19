//! The plan's first stages, each a value the next borrows: the [`Store`] a frame is built for,
//! the [`Spines`] of a graph, the [`Res`]olution every node runs at, and the [`Demand`] on every
//! node at that resolution — bundled as the [`Resolved`] graph every later stage reads. Nothing
//! here decides when or where anything runs.

use std::collections::HashMap;

use crate::kurbo::{Rect, Vec2};

use crate::vello::frame_graph::{pad_at, read_region, scale_rect, DrawItem, EdgeClampStyle, FrameGraph, NodeId, Op};
use crate::vello::scheduler::{TILE_H, TILE_W};

/// How far past the next rung the rule that lowered a pair must rise before the pair climbs back.
const CLIMB_MARGIN: f32 = 1.25;

/// A rect no demand reaches the edge of.
pub(crate) fn everything() -> Rect {
    Rect::new(-1e9, -1e9, 1e9, 1e9)
}

pub(crate) fn tile_round(r: Rect) -> Rect {
    Rect::new((r.x0 / TILE_W).floor() * TILE_W, (r.y0 / TILE_H).floor() * TILE_H, (r.x1 / TILE_W).ceil() * TILE_W, (r.y1 / TILE_H).ceil() * TILE_H)
}

fn union_into(slot: &mut Option<Rect>, r: Rect) {
    *slot = Some(slot.map_or(r, |s| s.union(r)));
}

pub(crate) fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/// What `r` holds past `f`, as the bands of `r` left of, right of, above and below `f` that are
/// not empty (they overlap at the corners).
pub(crate) fn bands(r: Rect, f: Rect) -> impl Iterator<Item = Rect> {
    [
        Rect::new(r.x0, r.y0, f.x0.min(r.x1), r.y1),
        Rect::new(f.x1.max(r.x0), r.y0, r.x1, r.y1),
        Rect::new(r.x0, r.y0, r.x1, f.y0.min(r.y1)),
        Rect::new(r.x0, f.y1.max(r.y0), r.x1, r.y1),
    ]
    .into_iter()
    .filter(|b| b.x1 > b.x0 && b.y1 > b.y0)
}

/// The bounds of what `r` holds past `f`: nothing when `f` covers it. Exact when `r` leaves `f`
/// on one side; at a corner it covers the inside too.
pub(crate) fn outside(r: Rect, f: Rect) -> Rect {
    bands(r, f).reduce(|a, b| a.union(b)).unwrap_or(Rect::ZERO)
}

/// How far, in frame pixels, the chain of compose `s` reads past its output at full resolution:
/// its heads' pads, summed, each with the tile its read is rounded out to.
fn chain_ring(g: &FrameGraph, s: NodeId) -> f64 {
    let mut ring = 0.0;
    let mut cur = g.nodes[s].inputs[1];
    while !g.is_spine(cur) {
        let node = &g.nodes[cur];
        let pad = f64::from(pad_at(&node.op, 1.0));
        if pad > 0.0 {
            ring += pad + TILE_W;
        }
        match node.inputs.first() {
            Some(&j) => cur = j,
            None => break,
        }
    }
    ring
}

/// The resolution a pair runs at this frame: `bound` is the highest its rules allow (the target
/// when none binds, and above it when they have slack), `prev` what it ran at last frame. It steps
/// down whenever the bound is below it, and climbs a rung only once the bound clears that rung by
/// [`CLIMB_MARGIN`]; never above `target`.
pub(crate) fn settle(target: f32, bound: f32, prev: Option<f32>) -> f32 {
    let mut k = target;
    while k > bound && k > f32::MIN_POSITIVE {
        k *= 0.5;
    }
    match prev {
        Some(p) if p < k && bound < p * 2.0 * CLIMB_MARGIN => p.max(k * 0.5).min(k),
        _ => k,
    }
}

/// The store a frame is built for: one texture, the frame rows on top, `rows` texel rows of pool
/// under them, `width` texels wide — the frame's plus, on each side, the widest ring any chain in
/// the graph reads past its output at full resolution, so a value that is the frame grown by its
/// pads fits at k 1; capped by the device's texture dimension, never below the frame. Whole tiles.
pub(crate) struct Store {
    pub frame: Rect,
    pub width: f64,
    /// The page pitch: the frame height rounded up to whole tiles.
    pub pitch: f64,
    pub rows: f64,
}

impl Store {
    pub fn for_graph(g: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64) -> Store {
        let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let pitch = (f64::from(height) / TILE_H).ceil() * TILE_H;
        let rows = (f64::from(max_dim) - pitch).max(0.0).min(pages * pitch);
        let ring = (0..g.nodes.len()).filter(|&s| matches!(g.nodes[s].op, Op::Compose { .. })).map(|s| chain_ring(g, s)).fold(0.0, f64::max);
        let margin = ((ring + TILE_W) / TILE_W).ceil() * TILE_W;
        let frame_w = (frame.x1 / TILE_W).ceil() * TILE_W;
        let width = (frame_w + 2.0 * margin).min((f64::from(max_dim) / TILE_W).floor() * TILE_W).max(frame_w);
        Store { frame, width, pitch, rows }
    }

}

/// Which spine each node stands on: for every node on a spine under an [`Op::Halo`], the nearest
/// halo above it; `None` on the frame's spine, off the spines, and for a halo itself.
pub(crate) struct Spines {
    pub halo_of: Vec<Option<NodeId>>,
    /// Per node, the root of the spine it stands on: node 0 on the frame's, a halo's draw
    /// otherwise, the node itself off the spines.
    pub root: Vec<NodeId>,
}

impl Spines {
    pub fn of(g: &FrameGraph) -> Spines {
        let n = g.nodes.len();
        let mut halo_of = vec![None; n];
        for i in 0..n {
            if !matches!(g.nodes[i].op, Op::Halo { .. }) {
                continue;
            }
            let mut s = g.nodes[i].inputs[0];
            loop {
                if matches!(g.nodes[s].op, Op::Halo { .. }) {
                    break;
                }
                halo_of[s] = Some(i);
                match g.nodes[s].inputs.first() {
                    Some(&below) if g.is_spine(s) => s = below,
                    _ => break,
                }
            }
        }
        let mut root: Vec<NodeId> = (0..n).collect();
        for i in 0..n {
            if let (Some(&below), true) = (g.nodes[i].inputs.first(), g.is_spine(i)) {
                root[i] = root[below];
            }
        }
        Spines { halo_of, root }
    }

    /// Whether node `i` is a halo or stands on a spine under one.
    pub fn under_halo(&self, g: &FrameGraph, i: NodeId) -> bool {
        self.halo_of[i].is_some() || matches!(g.nodes[i].op, Op::Halo { .. })
    }

    /// The rows spine node `i` writes, in its own texels: the frame for the frame's spine, and
    /// nothing less than everything for a halo and the spine under it (its rows are whatever the
    /// spine's nodes demand, joined).
    pub fn rect(&self, g: &FrameGraph, i: NodeId, frame: Rect) -> Rect {
        if self.under_halo(g, i) {
            everything()
        } else {
            frame
        }
    }
}

/// The spine node whose state node `i` stands on: a halo's `of`, any other node itself.
pub(crate) fn stands_on(g: &FrameGraph, i: NodeId) -> NodeId {
    match g.nodes[i].op {
        Op::Halo { of } => of,
        _ => i,
    }
}

/// Every node's resolution and what follows from it alone: which scales are nothing, what a
/// reader really reads, who reads whom, and every extent.
pub(crate) struct Res {
    /// The resolution each node's value runs at, a fraction of the frame's.
    pub k: Vec<f32>,
    /// A scale between equal resolutions is nothing: it is dropped and its readers read through it.
    pub elided: Vec<bool>,
    /// The node a reader really reads: itself, or what an elided scale reads.
    pub alias: Vec<NodeId>,
    pub readers: Vec<Vec<NodeId>>,
    pub ext: Vec<Rect>,
}

impl Res {
    /// At the pairs' targets, with `lowered` pairs at what they were lowered to.
    pub fn at(g: &FrameGraph, lowered: &HashMap<NodeId, f32>) -> Res {
        let n = g.nodes.len();
        let k = g.resolutions_with(&|i, target| lowered.get(&i).copied().unwrap_or(target));
        let mut elided = vec![false; n];
        let mut alias: Vec<NodeId> = (0..n).collect();
        for (i, node) in g.nodes.iter().enumerate() {
            if let Op::Scale { .. } = node.op {
                if k[node.inputs[0]] == k[i] {
                    elided[i] = true;
                    alias[i] = alias[node.inputs[0]];
                }
            }
        }
        let mut readers = vec![Vec::new(); n];
        for (i, node) in g.nodes.iter().enumerate() {
            if elided[i] {
                continue;
            }
            for &j in &node.inputs {
                readers[alias[j]].push(i);
            }
        }
        let ext = g.extents_at(&k);
        Res { k, elided, alias, readers, ext }
    }

    /// At the pairs' targets.
    pub fn targets(g: &FrameGraph) -> Res {
        Self::at(g, &HashMap::new())
    }

    /// Input `n` of node `i`, read through any elided scale.
    pub fn input(&self, g: &FrameGraph, i: NodeId, n: usize) -> NodeId {
        self.alias[g.nodes[i].inputs[n]]
    }

    /// Every input of node `i`, read through any elided scale.
    pub fn inputs(&self, g: &FrameGraph, i: NodeId) -> Vec<NodeId> {
        g.nodes[i].inputs.iter().map(|&j| self.alias[j]).collect()
    }

    /// `r`, given in node `from`'s texels, in node `to`'s.
    pub fn in_space_of(&self, r: Rect, from: NodeId, to: NodeId) -> Rect {
        if self.k[from] == self.k[to] {
            r
        } else {
            scale_rect(r, f64::from(self.k[to] / self.k[from]))
        }
    }

    /// The extent a reader may see of node `i`: the frame for the frame's spine (its rows hold
    /// the page colour everywhere), everything for a halo and the spine under it (their rows
    /// hold the page colour past the draws) and for a scale of a spine, a leaf's bounds plus the
    /// pixel its antialiased edge spills into, the node's own extent for any other chain value.
    pub fn visible_extent(&self, g: &FrameGraph, spines: &Spines, frame: Rect, i: NodeId) -> Rect {
        let node = &g.nodes[i];
        if g.is_spine(i) {
            spines.rect(g, i, frame)
        } else if matches!(node.op, Op::Scale { .. }) && g.is_spine(node.inputs[0]) {
            everything()
        } else if matches!(node.op, Op::Draw(_)) {
            self.ext[i].inflate(1.0, 1.0)
        } else {
            self.ext[i]
        }
    }

    /// The part of node `i`'s rect `r` that the spine it stands on already holds, in `i`'s texels:
    /// a halo's rect inside the rows of `of`'s spine, a frame-spine node's inside the frame.
    pub fn inside_of(&self, g: &FrameGraph, spines: &Spines, frame: Rect, i: NodeId, r: Rect) -> Rect {
        let sb = stands_on(g, i);
        r.intersect(self.in_space_of(spines.rect(g, sb, frame), sb, i))
    }

    /// Whether scale `i` opens a pair: what it reads is not inside one.
    fn is_down(g: &FrameGraph, i: NodeId) -> bool {
        let mut j = g.nodes[i].inputs[0];
        loop {
            let node = &g.nodes[j];
            if g.is_spine(j) || matches!(node.op, Op::Draw(_)) {
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
    fn links(&self, g: &FrameGraph, dem: &Demand, d: NodeId) -> Vec<NodeId> {
        let demanded = |i: NodeId| dem.wanted[i].is_some() && !dem.out[i].is_zero_area();
        let mut links: Vec<NodeId> = Vec::new();
        if !self.elided[d] {
            links.push(d);
        } else if matches!(g.nodes[self.alias[d]].op, Op::Draw(_)) {
            links.push(self.alias[d]);
        } else {
            links.extend((0..g.nodes.len()).filter(|&r| g.nodes[r].inputs.contains(&d) && !matches!(g.nodes[r].op, Op::Scale { .. })));
        }
        links.retain(|&l| demanded(l));
        let mut i = 0;
        while i < links.len() {
            for &r in &self.readers[links[i]] {
                if matches!(g.nodes[r].op, Op::Scale { .. }) || links.contains(&r) || g.is_spine(r) {
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

    /// The rows of the halo spine down node `d` reads, when `d` reads the top halo of one: the
    /// spine's live nodes' outputs, joined — the value its root draws into (see `Work::halo`),
    /// in the texels of the resolution `d` gives it.
    fn halo_rows(&self, g: &FrameGraph, dem: &Demand, spines: &Spines, d: NodeId) -> Option<Rect> {
        let h = g.nodes[d].inputs[0];
        if !matches!(g.nodes[h].op, Op::Halo { .. }) || g.stood_on(h) {
            return None;
        }
        let root = spines.root[h];
        (0..g.nodes.len())
            .filter(|&s| g.is_spine(s) && spines.root[s] == root && dem.live(self, s))
            .map(|s| dem.out[s])
            .reduce(|a, b| a.union(b))
    }

    /// The capacity decision, made once, from the demand at the pairs' targets: each pair no
    /// higher than its target, lowered only by the size rules — the run between it no wider nor
    /// taller than the store's rows, no two adjacent links of it together larger than them — with
    /// hysteresis from `memory`, which is updated. A pair opening on the top halo of a spine
    /// counts that spine's rows among its run: the top halo's reader sets the spine's resolution,
    /// so lowering the pair is what shrinks them. Never looks at what runs beside what: that is
    /// the packer's, in rounds. Returns the lowered resolutions, or `None` when every pair keeps
    /// its target.
    pub fn decide(&self, g: &FrameGraph, dem: &Demand, spines: &Spines, store: &Store, memory: &mut HashMap<u128, f32>) -> Option<Res> {
        let pool = store.rows * store.width;
        let mut lowered: HashMap<NodeId, f32> = HashMap::new();
        let mut seen: Vec<u128> = Vec::new();
        for d in 0..g.nodes.len() {
            let Op::Scale { target, key } = g.nodes[d].op else { continue };
            if !Self::is_down(g, d) {
                continue;
            }
            let links = self.links(g, dem, d);
            if links.is_empty() {
                continue;
            }
            let t = self.k[d];
            let mut widest = links.iter().map(|&l| dem.out[l].width()).fold(0.0, f64::max);
            let mut tallest = links.iter().map(|&l| dem.out[l].height()).fold(0.0, f64::max);
            let mut peak: f64 = 0.0;
            if self.elided[d] && g.is_spine(g.nodes[d].inputs[0]) {
                for &l in links.iter().filter(|&&l| g.nodes[l].inputs.contains(&d)) {
                    let r = dem.read_rect(g, self, l);
                    widest = widest.max(r.width());
                    tallest = tallest.max(r.height());
                    peak = peak.max(r.area() + dem.out[l].area());
                }
            }
            if let Some(rows) = self.halo_rows(g, dem, spines, d) {
                widest = widest.max(rows.width());
                tallest = tallest.max(rows.height());
                // The rows are alive while the first links read them: through the down node when
                // it is nothing, the down node itself when it is a real scale.
                let reading = links.iter().filter(|&&l| l == d || g.nodes[l].inputs.contains(&d)).map(|&l| dem.out[l].area()).fold(0.0, f64::max);
                peak = peak.max(rows.area() + reading);
            }
            for &l in &links {
                let a = dem.out[l].area();
                for &r in &self.readers[l] {
                    if links.contains(&r) {
                        peak = peak.max(a + dem.out[r].area());
                    }
                }
                peak = peak.max(a);
            }
            let bound = f64::from(t) * (store.width / widest).min(store.rows / tallest).min((pool / peak).sqrt());
            let k = settle(target, bound as f32, memory.get(&key).copied());
            seen.push(key);
            memory.insert(key, k);
            if k < t {
                lowered.insert(d, k);
            }
        }
        memory.retain(|key, _| seen.contains(key));
        (!lowered.is_empty()).then(|| Self::at(g, &lowered))
    }
}

/// One backward pass at a resolution: what each node must produce, and which items each draw
/// keeps. A compose owes its demand to the state below and, less its offset, to its value; a
/// neighbourhood op owes its input its own demand grown by its pad (a `Transparent` blur grows
/// nothing — the clamp supplies zeros); a pointwise op passes its demand through; a scale owes
/// its input its demand in the input's texels; a halo owes its spine what lies past the rows it
/// is filled from and owes `of` those rows. A node's output rect is its demand clipped to its
/// extent, tile-rounded, and for a spine node to the rows its spine writes.
pub(crate) struct Demand {
    /// What is asked of each node, `None` when nothing is.
    pub wanted: Vec<Option<Rect>>,
    /// What each node produces, in its own texels; `ZERO` where nothing is demanded.
    pub out: Vec<Rect>,
    /// The items each draw keeps: those touching its output.
    pub kept: Vec<Vec<DrawItem>>,
}

impl Demand {
    pub fn of(g: &FrameGraph, frame: Rect, res: &Res, spines: &Spines) -> Demand {
        let n = g.nodes.len();
        let mut wanted: Vec<Option<Rect>> = vec![None; n];
        let mut out = vec![Rect::ZERO; n];
        let mut kept: Vec<Vec<DrawItem>> = vec![Vec::new(); n];
        wanted[n - 1] = Some(frame);
        for i in (0..n).rev() {
            let Some(d) = wanted[i] else { continue };
            let node = &g.nodes[i];
            if res.elided[i] {
                union_into(&mut wanted[node.inputs[0]], d);
                continue;
            }
            let o = match &node.op {
                Op::Compose { offset, .. } => {
                    let v = res.ext[node.inputs[1]] + Vec2::new(f64::from(offset[0]), f64::from(offset[1]));
                    let v = node.inputs.get(2).map_or(v, |&c| v.intersect(res.ext[c]));
                    d.intersect(v)
                }
                _ => d.intersect(res.visible_extent(g, spines, frame, i)),
            };
            let o = if g.is_spine(i) { tile_round(o).intersect(tile_round(spines.rect(g, i, frame))) } else { tile_round(o) };
            out[i] = o;
            if matches!(node.op, Op::Draw(_) | Op::Compose { .. }) {
                if let Some(&below) = node.inputs.first() {
                    union_into(&mut wanted[below], d);
                }
            }
            if o.is_zero_area() {
                continue;
            }
            let grown = |p: f32| o.inflate(f64::from(p), f64::from(p));
            let k = res.k[i];
            match &node.op {
                Op::Draw(items) => {
                    let frame_out = scale_rect(o, 1.0 / f64::from(k));
                    kept[i] = items.iter().filter(|it| overlaps(it.bounds, frame_out)).cloned().collect();
                }
                Op::Blur { edge_clamp_style, .. } => {
                    let r = if *edge_clamp_style == EdgeClampStyle::Transparent { o } else { grown(pad_at(&node.op, k)) };
                    union_into(&mut wanted[node.inputs[0]], r);
                }
                Op::Scale { .. } => {
                    let j = node.inputs[0];
                    union_into(&mut wanted[j], scale_rect(o, f64::from(res.k[j] / k)));
                }
                Op::Warp(_) | Op::Scatter(_) => {
                    union_into(&mut wanted[node.inputs[0]], read_region(&node.op, o, k));
                    if let Some(&sdf) = node.inputs.get(1) {
                        union_into(&mut wanted[sdf], o);
                    }
                }
                Op::EraseBy(u) => {
                    union_into(&mut wanted[node.inputs[0]], o);
                    let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                    union_into(&mut wanted[node.inputs[1]], o - shift);
                }
                Op::Shade(_) | Op::MaskMix(_) | Op::ClipToSource(_) | Op::Colour(_) => {
                    for &j in &node.inputs {
                        union_into(&mut wanted[j], o);
                    }
                }
                Op::Compose { offset, .. } => {
                    union_into(&mut wanted[node.inputs[1]], o - Vec2::new(f64::from(offset[0]), f64::from(offset[1])));
                    if let Some(&cov) = node.inputs.get(2) {
                        union_into(&mut wanted[cov], o);
                    }
                }
                Op::Halo { of } => {
                    let inside = res.inside_of(g, spines, frame, i, o);
                    let past = outside(o, inside);
                    if !past.is_zero_area() {
                        union_into(&mut wanted[node.inputs[0]], past);
                    }
                    let held = res.in_space_of(inside, i, *of);
                    union_into(&mut wanted[*of], held);
                }
            }
        }
        Demand { wanted, out, kept }
    }

    pub fn live(&self, res: &Res, i: NodeId) -> bool {
        !res.elided[i] && self.wanted[i].is_some() && !self.out[i].is_zero_area()
    }

    /// The region node `i` reads of an input, in `i`'s own texels: its output grown by its pad,
    /// mapped first for a lens (see [`read_region`]).
    pub fn read_rect(&self, g: &FrameGraph, res: &Res, i: NodeId) -> Rect {
        read_region(&g.nodes[i].op, self.out[i], res.k[i])
    }

    /// The rect chain node `i` reads of its input `j`, in `j`'s texels: its output grown by its
    /// pad for a head, its output for a pointwise op, displaced for an `EraseBy` reference.
    pub fn read_of(&self, g: &FrameGraph, res: &Res, i: NodeId, j: NodeId) -> Rect {
        let node = &g.nodes[i];
        let head = matches!(node.op, Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_) | Op::Scale { .. });
        let r = match &node.op {
            Op::EraseBy(u) if node.inputs.get(1).map(|&x| res.alias[x]) == Some(j) => {
                let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                self.out[i] - shift
            }
            _ if head && res.input(g, i, 0) == j => self.read_rect(g, res, i),
            _ => self.out[i],
        };
        res.in_space_of(r, i, j)
    }
}

/// A graph with its store, spines, resolutions and demand settled: what every later stage reads
/// and none writes.
pub(crate) struct Resolved<'a> {
    pub g: &'a FrameGraph,
    pub store: Store,
    pub spines: Spines,
    pub res: Res,
    pub dem: Demand,
}

impl<'a> Resolved<'a> {
    /// `g` at the pairs' targets, on a `width × height` frame with `pages` frame heights of store
    /// below it on a device whose textures reach `max_dim`.
    pub fn of(g: &'a FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64) -> Self {
        let mut laps = Laps::new("  resolved");
        let store = Store::for_graph(g, width, height, max_dim, pages);
        laps.lap("store");
        let spines = Spines::of(g);
        laps.lap("spines");
        let res = Res::targets(g);
        laps.lap("res");
        let dem = Demand::of(g, store.frame, &res, &spines);
        laps.lap("demand");
        Resolved { g, store, spines, res, dem }
    }

    /// The capacity decision on the demand at the pairs' targets, and demand again at what it
    /// decided.
    pub fn resolve(&mut self, memory: &mut HashMap<u128, f32>) {
        if let Some(res) = self.res.decide(self.g, &self.dem, &self.spines, &self.store, memory) {
            self.res = res;
            self.dem = Demand::of(self.g, self.store.frame, &self.res, &self.spines);
        }
    }

    pub fn live(&self, i: NodeId) -> bool {
        self.dem.live(&self.res, i)
    }

    pub fn input(&self, i: NodeId, n: usize) -> NodeId {
        self.res.input(self.g, i, n)
    }

    pub fn inputs(&self, i: NodeId) -> Vec<NodeId> {
        self.res.inputs(self.g, i)
    }

    pub fn in_space_of(&self, r: Rect, from: NodeId, to: NodeId) -> Rect {
        self.res.in_space_of(r, from, to)
    }

    pub fn inside_of(&self, i: NodeId, r: Rect) -> Rect {
        self.res.inside_of(self.g, &self.spines, self.store.frame, i, r)
    }

    pub fn read_rect(&self, i: NodeId) -> Rect {
        self.dem.read_rect(self.g, &self.res, i)
    }

    /// The nodes `i` reads: its inputs, and for a halo the spine node it continues.
    pub fn read_nodes(&self, i: NodeId) -> Vec<NodeId> {
        let mut nodes = self.inputs(i);
        if let Op::Halo { of } = self.g.nodes[i].op {
            nodes.push(of);
        }
        nodes
    }

    /// The halo whose spine node `j` stands on: `j` itself for a halo, the nearest halo above
    /// under one, none on the frame's spine.
    pub fn halo_of(&self, j: NodeId) -> Option<NodeId> {
        if matches!(self.g.nodes[j].op, Op::Halo { .. }) {
            Some(j)
        } else {
            self.spines.halo_of[j]
        }
    }

    /// Whether halo `h` is filled: a live chain node reads it. A fill point under a clone that
    /// nothing demands would be filled for nobody; the fill above it covers the same rows.
    pub fn fill_read(&self, h: NodeId) -> bool {
        self.res.readers[h].iter().any(|&r| !self.g.is_spine(r) && self.live(r))
    }
}

/// Stage timings to stderr under `WV_PLAN_TIMING`, on hosts with a clock; silent otherwise.
pub(crate) struct Laps {
    what: &'static str,
    #[cfg(not(target_arch = "wasm32"))]
    at: Option<std::time::Instant>,
}

impl Laps {
    pub fn new(what: &'static str) -> Laps {
        Laps {
            what,
            #[cfg(not(target_arch = "wasm32"))]
            at: std::env::var_os("WV_PLAN_TIMING").map(|_| std::time::Instant::now()),
        }
    }

    /// Whether timings are being taken.
    pub fn on(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.at.is_some()
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = self.what;
            false
        }
    }

    /// Print the time since the last lap as `stage`, and start the next.
    pub fn lap(&mut self, stage: &str) {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(at) = self.at.as_mut() {
            eprintln!("{}: {stage} {:.2} ms", self.what, at.elapsed().as_secs_f64() * 1e3);
            *at = std::time::Instant::now();
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = stage;
        }
    }
}
