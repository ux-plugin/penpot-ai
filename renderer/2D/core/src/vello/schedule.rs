//! Steps 5 and 6: when every arm runs and where every value sits. An arm runs one round after
//! everything it reads; a leaf or halo root is drawn the round before its first reader; each
//! chain, in spine order, is shifted later by the least amount at which [`StorePacker`] fits its
//! values beside those placed before them within the store's rows — the packer is the one judge
//! of what fits: a shift whose rounds lack the tiles is skipped without asking, and a chain that
//! does not fit at a shift is taken back out of it. A value's
//! origin in the store splits into the page fine folds rows by and the placement that rides the
//! records.

use std::fmt;

use crate::kurbo::{Rect, Vec2};

use crate::vello::arms::{Kind, Work};
use crate::vello::frame_graph::{DrawStyle, NodeId, Op};
use crate::vello::resolve::{overlaps, Laps, Resolved};
use crate::vello::scheduler::{TILE_H, TILE_W};
use crate::vello::store_pack::StorePacker;

/// Where and when a value holds its rows.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Slot {
    /// The first round whose rows the value occupies: the round the front-end's segment draws a
    /// leaf or halo root in, or the round an arm's mark writes it.
    pub birth: u32,
    pub last_read: u32,
    /// The first page the value's rows start on; a value taller than a page spans the next.
    pub page: usize,
    /// Where the rect sits on its page: store `= rect + place + (0, page·pitch)`.
    pub place: Vec2,
}

pub(crate) struct Schedule {
    /// Each arm's round.
    pub round: Vec<u32>,
    /// Each value's slot; the frame's and a silhouette's are never placed.
    pub slot: Vec<Slot>,
}

impl Schedule {
    /// Whether value `v` takes rows of the store below the frame.
    fn placed(work: &Work, v: usize) -> bool {
        !matches!(work.values[v].kind, Kind::Rows | Kind::Silhouette(_))
    }

    pub fn fit(cx: &Resolved, work: &Work) -> Schedule {
        let mut s = Schedule { round: vec![0; work.arms.len()], slot: vec![Slot::default(); work.values.len()] };
        let drawn: Vec<bool> = work.values.iter().map(|v| matches!(v.kind, Kind::Leaf { .. } | Kind::Root(_))).collect();
        let baked: Vec<bool> = work.values.iter().map(|v| matches!(&v.kind, Kind::Leaf { item, .. } if matches!(item.style, DrawStyle::Distance { .. }))).collect();
        let tiles = |v: usize| {
            let r = work.values[v].rect;
            ((r.width() / TILE_W).ceil() as u32, (r.height() / TILE_H).ceil() as u32)
        };
        let rows = (cx.store.rows / TILE_H).floor() as u32;
        let tiles_total = rows * (cx.store.width / TILE_W) as u32;
        let mut packer = StorePacker::new((cx.store.width / TILE_W) as u32);
        let mut need: Vec<u32> = Vec::new();
        let (mut n_attempts, mut n_jumps, mut n_rollbacks, mut n_places) = (0u64, 0u64, 0u64, 0u64);
        let mut id: Vec<Option<u32>> = vec![None; work.values.len()];
        let mut far = 0u32;
        let mut chains: Vec<NodeId> = work.arms.iter().map(|a| a.chain).collect();
        chains.dedup();
        for c in chains {
            let arms: Vec<usize> = (0..work.arms.len()).filter(|&a| work.arms[a].chain == c).collect();
            for &a in &arms {
                s.round[a] = s.arm_round(cx, work, a);
            }
            let mut spans: Vec<(usize, u32, u32)> = Vec::new();
            for &a in &arms {
                let round = s.round[a];
                let out = Some(work.arms[a].out).filter(|&v| !drawn[v] && Self::placed(work, v));
                let touched = work.reads_of(cx, a).into_iter().filter(|&v| Self::placed(work, v)).map(|v| (v, round)).chain(out.map(|v| (v, round + 1)));
                for (v, first) in touched {
                    match spans.iter_mut().find(|e| e.0 == v) {
                        Some(e) => {
                            e.1 = e.1.min(first);
                            e.2 = e.2.max(round);
                        }
                        None => spans.push((v, first, round)),
                    }
                }
            }
            let first = arms.iter().map(|&a| s.round[a]).min().unwrap_or(0);
            let saved: Vec<(Slot, Option<u32>)> = spans.iter().map(|&(v, _, _)| (s.slot[v], id[v])).collect();
            let mut shift = 0u32;
            loop {
                while first + shift <= far {
                    need.clear();
                    for &(v, b, d) in &spans {
                        let (w, h) = tiles(v);
                        let from = match id[v] {
                            None if baked[v] => 0,
                            None => (b + shift).saturating_sub(1),
                            Some(_) => s.slot[v].last_read + 1,
                        };
                        for q in from..=d + shift {
                            if need.len() <= q as usize {
                                need.resize(q as usize + 1, 0);
                            }
                            need[q as usize] += w * h;
                        }
                    }
                    if need.iter().enumerate().all(|(q, &n)| n == 0 || packer.used(q as u32) + n <= tiles_total) {
                        break;
                    }
                    shift += 1;
                    n_jumps += 1;
                }
                n_attempts += 1;
                let mut within = true;
                for &(v, b, d) in &spans {
                    let (w, h) = tiles(v);
                    let placed = match id[v] {
                        None => {
                            s.slot[v].birth = if baked[v] { 0 } else { (b + shift).saturating_sub(1) };
                            s.slot[v].last_read = d + shift;
                            Some(packer.place(w, h, s.slot[v].birth, s.slot[v].last_read))
                        }
                        Some(old) if d + shift > s.slot[v].last_read => {
                            s.slot[v].last_read = d + shift;
                            packer.remove(old);
                            Some(packer.place(w, h, s.slot[v].birth, s.slot[v].last_read))
                        }
                        Some(_) => None,
                    };
                    if let Some(new) = placed {
                        n_places += 1;
                        id[v] = Some(new);
                        within &= packer.at(new)[1] + h <= rows;
                    }
                }
                if within || first + shift > far {
                    packer.commit();
                    break;
                }
                packer.rollback();
                n_rollbacks += 1;
                for (i, &(v, _, _)) in spans.iter().enumerate() {
                    (s.slot[v], id[v]) = saved[i];
                }
                shift += 1;
            }
            for &a in &arms {
                s.round[a] += shift;
                far = far.max(s.round[a] + 1);
            }
        }
        if Laps::new("fit").on() {
            eprintln!("fit: {} values, {} arms, attempts {n_attempts}, jumps {n_jumps}, rollbacks {n_rollbacks}, placements {n_places}, rows {rows}, height {}", work.values.len(), work.arms.len(), packer.height());
        }
        let pitch = cx.store.pitch;
        for v in 0..work.values.len() {
            let Some(id) = id[v] else { continue };
            let [x, y] = packer.at(id);
            let origin = Vec2::new(f64::from(x) * TILE_W, pitch + f64::from(y) * TILE_H);
            let page = (origin.y / pitch).floor() as usize;
            s.slot[v].page = page;
            s.slot[v].place = origin - Vec2::new(0.0, page as f64 * pitch) - work.values[v].rect.origin().to_vec2();
        }
        s.slot[0].last_read = s.round.iter().copied().max().unwrap_or(0);
        s
    }

    /// The round after which node `i`'s result can be read over `r`: an arm's own round, a leaf's
    /// round 0, and for the spine the round of the last live compose below `i` that touches `r`
    /// (a pruned compose has no arm and is walked past), and no earlier than any snapshot taken
    /// of the spine over `r` at or below `i` — the snapshot's tiles hold at its place in z until
    /// its round, so whatever lands on them above it lands after. A spine draw has no round of its own:
    /// a tile's segment advances only at the markers binned into it, so the draw's items are
    /// painted over `r` in whatever round the last compose touching `r` gave those tiles — two
    /// chains over disjoint ground run in the same rounds even with draws between them.
    pub fn ready(&self, cx: &Resolved, work: &Work, i: NodeId, r: Rect) -> u32 {
        if let Op::Halo { of } = cx.g.nodes[i].op {
            if let Some(a) = work.arm_of[i] {
                return self.round[a];
            }
            let inside = cx.inside_of(i, cx.dem.out[i]);
            let filled = self.ready(cx, work, of, cx.in_space_of(inside, i, of));
            return filled.max(self.ready(cx, work, cx.g.nodes[i].inputs[0], r));
        }
        if cx.g.is_spine(i) {
            let mut s = i;
            let mut held = 0;
            loop {
                let node = &cx.g.nodes[s];
                for a in 0..work.arms.len() {
                    if let Some((j, read)) = work.snapshot_of(cx, a) {
                        if j == s && overlaps(read, r) {
                            held = held.max(self.round[a]);
                        }
                    }
                }
                if let Op::Compose { .. } = &node.op {
                    if overlaps(cx.dem.out[s], r) {
                        if let Some(a) = work.arm_of[s] {
                            return self.round[a].max(held);
                        }
                    }
                }
                match node.inputs.first() {
                    Some(&below) => s = below,
                    None => return held,
                }
            }
        }
        if let Some(a) = work.arm_of[i] {
            return self.round[a];
        }
        0
    }

    /// One more than the latest round any node of arm `a`, its compose included, reads from
    /// outside the arm over the region it reads.
    fn arm_round(&self, cx: &Resolved, work: &Work, a: usize) -> u32 {
        let arm = &work.arms[a];
        let mut r = 0;
        for &i in &arm.nodes {
            for j in cx.inputs(i) {
                if work.arm_of[j] == Some(a) {
                    continue;
                }
                r = r.max(self.ready(cx, work, j, cx.in_space_of(cx.read_rect(i), i, j)));
            }
            if let Op::Halo { of } = cx.g.nodes[i].op {
                let inside = cx.inside_of(i, cx.dem.out[i]);
                r = r.max(self.ready(cx, work, of, cx.in_space_of(inside, i, of)));
            }
        }
        if let Some(c) = arm.compose {
            for j in cx.inputs(c) {
                if work.arm_of[j] == Some(a) {
                    continue;
                }
                r = r.max(self.ready(cx, work, j, cx.dem.out[c]));
            }
        }
        // A resample of a spine is a snapshot taken in the spine's tiles, after the compose it
        // waits for in the same tiles' order: it runs in that compose's own round. A halo's fill
        // is one too, but writes rows its root draws the round before, so it stays a round later.
        let snapshot = work.snapshot_of(cx, a).is_some() && matches!(cx.g.nodes[arm.nodes[0]].op, Op::Resample { .. });
        if snapshot { r } else { r + 1 }
    }

    /// Where value `v`'s rows start in the store: its placement, down by its page.
    pub fn origin(&self, cx: &Resolved, v: usize) -> Vec2 {
        self.slot[v].place + Vec2::new(0.0, self.slot[v].page as f64 * cx.store.pitch)
    }

    /// A value's rect in store texels: its frame rect slid by its placement, down by its page.
    pub fn store_rect(&self, cx: &Resolved, work: &Work, v: usize) -> Rect {
        work.values[v].rect + self.origin(cx, v)
    }

    /// How many pages the frame rents below its own rows: enough for the lowest value's rows.
    pub fn pages(&self, cx: &Resolved, work: &Work) -> usize {
        let pitch = cx.store.pitch;
        (0..work.values.len()).filter(|&v| Self::placed(work, v)).map(|v| (self.store_rect(cx, work, v).y1 / pitch).ceil() as usize - 1).max().unwrap_or(0)
    }
}

/// The schedule as text, one line per arm in round order: round, chain (its compose's label),
/// the resolution its nodes run at, the nodes, and the value's rect and texels — then one line
/// per round with the texels live in it, then one line per value.
pub(crate) struct Dump<'a>(pub &'a Resolved<'a>, pub &'a Work, pub &'a Schedule);

impl fmt::Display for Dump<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Dump(cx, work, s) = *self;
        let mut arms: Vec<usize> = (0..work.arms.len()).collect();
        arms.sort_by_key(|&a| (s.round[a], a));
        writeln!(f, "schedule")?;
        for a in arms {
            let arm = &work.arms[a];
            let k = arm.nodes.first().map_or(1.0, |&i| cx.res.k[i]);
            let labels: Vec<&str> = arm.nodes.iter().map(|&i| cx.g.nodes[i].label.as_str()).collect();
            let rect = (arm.compose.is_none()).then(|| work.values[arm.out].rect);
            writeln!(
                f,
                "  r{:<3} {:<26} k={:<5} [{}]{}{}",
                s.round[a],
                cx.g.nodes[arm.chain].label,
                k,
                labels.join(", "),
                arm.compose.map_or(String::new(), |c| format!(" → {}", cx.g.nodes[c].label)),
                rect.map_or(String::new(), |r| format!(" out {}x{}", r.width(), r.height())),
            )?;
        }
        let rounds = s.round.iter().map(|r| r + 1).max().unwrap_or(1);
        for r in 0..rounds {
            let alive = (0..work.values.len()).filter(|&v| Schedule::placed(work, v) && s.slot[v].birth <= r && r <= s.slot[v].last_read);
            let (live, n) = alive.fold((0.0, 0), |(t, n), v| (t + work.values[v].rect.area(), n + 1));
            writeln!(f, "  round {r:<3} live {:>5.0}k texels in {n} values", live / 1000.0)?;
        }
        for (i, v) in work.values.iter().enumerate() {
            let kind = match &v.kind {
                Kind::Rows => "frame".to_string(),
                Kind::Root(items) => format!("halo×{}", items.len()),
                Kind::Leaf { .. } => "leaf".to_string(),
                Kind::Silhouette(_) => "silhouette".to_string(),
                Kind::Out => "arm".to_string(),
            };
            let slot = s.slot[i];
            writeln!(f, "  v{i:<3} {:<26} {kind:<11} rounds {}..{} page {} at {:?} rect {:?}", cx.g.nodes[v.node].label, slot.birth, slot.last_read, slot.page, slot.place, v.rect)?;
        }
        Ok(())
    }
}
