//! Gather-collapse analysis — decides which gather effects can be **deferred** into one batched pass.
//!
//! A gather (background blur / glass / backdrop-reading custom shader) reads the content beneath it,
//! so today each one forces its own backdrop-compose + blur pass — a GPU round-trip apiece, the cost
//! the profiler pinned at ~90 ms for a screenful. Independent gathers, though, all read *already
//! finished* backdrop and land on *disjoint* regions, so their blurs can run together in a single
//! pass (one dispatch per distinct effect) and scatter back afterwards. This module finds those.
//!
//! Deferring a gather to end-of-frame needs **two** separate things to be true, and it is worth
//! keeping them apart because they have different remedies:
//!
//! 1. **The scatter must still land in z-order.** The batch paints its results after everything else,
//!    so nothing later may cover the gather's **output** silhouette. There is no way around this one
//!    from inside a single end-of-frame pass: a gather with something painted over it has to composite
//!    at its own z, and stays inline.
//! 2. **The backdrop must be the one the gather would have seen.** The batch recomposes each backdrop
//!    from the *finished* tiles, which is only the same picture if nothing later disturbed the
//!    **sample rect** (the output grown by the kernel's reach).
//!
//! Requiring both against the sample rect — the original rule — is simple and needs no memory, but it
//! throws away every gather whose blur *fringe* is merely brushed by something above, even though such
//! a gather is perfectly scatterable. Those come back by satisfying (2) with memory instead of luck:
//! freeze the backdrop tiles at the gather's z-position and let the batch read the frozen copy. So a
//! gather lands in one of three tiers:
//!
//! | later write overlaps | verdict |
//! |---|---|
//! | the output | inline — the scatter cannot be deferred |
//! | the sample only | **deferrable, [`needs_snapshot`](GatherInfo::needs_snapshot)** |
//! | neither | deferrable, recomposed from the finished tiles |
//!
//! One dependency is not a "write" at all and has to be tested separately: a later gather *reads* a
//! region wider than it paints. If B's sample rect overlaps A's output, then B's backdrop must be
//! taken after A's result has landed — but the batch composes *every* backdrop before it scatters
//! *any* result, so A can never share a batch with B. A is forced inline. (Genuinely stacked gathers —
//! a blur of a blur — fail this or the output test at every level but the top, so they stay inline,
//! one pass each, exactly as before.)
//!
//! The plan is a pure function of the built schedule + scene; the sink ([`crate::schedule`]'s Vello
//! backend) consumes it to snapshot each deferrable gather's backdrop and run the batch. Nothing here
//! touches a GPU.

use std::hash::{Hash, Hasher};

use kurbo::{Affine, Rect};

use crate::host::Modifiers;
use crate::model::{Glass, Node, Scene};
use crate::tiling::TileKey;

use super::builder::page_bounds;
use super::step::{PaintOp, Step};

/// Identity of a gather's effect + params — deferrable gathers that share one are a single dispatch in
/// the batched pass (the übershader runs once per distinct key, not once per shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKey {
    /// Background blur, keyed by radius bits.
    Blur(u32),
    /// Frosted glass, keyed by a hash of every glass parameter.
    Glass(u64),
    /// A custom backdrop-reading WGSL shader, keyed by a hash of its source + params + reach.
    Custom(u64),
}

/// One gather effect found in the schedule, with everything the sink needs to snapshot and scatter it.
#[derive(Debug, Clone)]
pub struct GatherInfo {
    pub shape: u128,
    pub effect_key: EffectKey,
    /// z-position — the `ComposeBackdrop` step index. Scatter order within the batch is by this.
    pub order: usize,
    /// Backdrop-source tiles (what `ComposeBackdrop` reads) — the tiles to snapshot.
    pub reads: Vec<TileKey>,
    /// Output tiles (what `PaintGather` writes) — where the blurred result scatters back.
    pub writes: Vec<TileKey>,
    /// Page-space sample extent (the backdrop rect); sizes the snapshot clip.
    pub sample: Rect,
    /// The effect's page-space reach — how far past the shape the kernel pulls. The sink caps the
    /// backdrop's device resolution by it, exactly as the inline `ComposeBackdrop` does.
    pub reach: f64,
    /// Declared quality floor `k ∈ (0, 1]` — the free downscale the effect tolerates. The batched
    /// backdrop cell renders at `min(resolution_cap, acceptable_downscale)`, matching the inline path.
    pub acceptable_downscale: f32,
    /// Page-space output silhouette (the scatter clip).
    pub output: Rect,
    /// Nothing later covers this gather's **output**, so its result can be scattered at end of frame.
    /// Otherwise it runs inline (its own pass), exactly as before the collapse.
    pub deferrable: bool,
    /// Something later disturbs the **sample** rect, so the finished tiles no longer hold the backdrop
    /// this gather would have read. Such a gather is excluded from the batch by [`batched_groups`](
    /// GatherPlan::batched_groups) and stays inline — batching it would need its backdrop captured at
    /// its own z (the scheduled-snapshot work), which is not built yet. Meaningless when
    /// [`deferrable`](Self::deferrable) is false.
    pub needs_snapshot: bool,
    /// No fills or strokes — a pure lens, so nothing has to composite *over* the blur. The batched
    /// stage scatters the blurred backdrop with no body to re-order, so v1 only batches these; a
    /// gather with a body keeps the inline path (its body paints over the blur in z, as authored).
    pub pure_lens: bool,
}

/// Whether the scheduled-snapshot tier is on: emit a [`Step::Snapshot`](super::step::Step::Snapshot)
/// for each `needs_snapshot` gather at its z-position and let the batch read the frozen copy, so a
/// sample-disturbed gather can batch instead of staying inline. Off by default — flipping it changes
/// what the batch reads, so it stays gated behind the pixel-diff-vs-inline gate (fringe 5/25 → 0/25)
/// until proven. The builder's snapshot-emission pass and [`GatherPlan::batched_groups`] both read
/// this, so they cannot drift: with it off, no snapshot is emitted and none is batched.
pub const SNAPSHOT_TIER: bool = false;

/// A batched group must have at least this many gathers to be worth an atlas; below it the inline
/// path is cheaper. Shared by the builder (which must not break paint batches for gathers that will
/// be deferred) and the sink (which does the deferring).
pub const GATHER_MIN: usize = 2;

/// The gather-collapse plan for one frame's schedule.
#[derive(Debug, Default, Clone)]
pub struct GatherPlan {
    /// Every gather in the schedule, in z-order.
    pub gathers: Vec<GatherInfo>,
}

impl GatherPlan {
    /// Total gather effects this frame.
    #[must_use]
    pub fn total(&self) -> usize {
        self.gathers.len()
    }

    /// Gathers that collapse into the single batched pass.
    #[must_use]
    pub fn deferrable_count(&self) -> usize {
        self.gathers.iter().filter(|g| g.deferrable).count()
    }

    /// Distinct effect dispatches inside the batched pass — deferrable gathers grouped by effect key.
    /// (Passes are unaffected by this; it is the dispatch count within the one batched pass.)
    #[must_use]
    pub fn batched_dispatches(&self) -> usize {
        let mut keys: Vec<EffectKey> = self
            .gathers
            .iter()
            .filter(|g| g.deferrable)
            .map(|g| g.effect_key)
            .collect();
        keys.sort_by_key(|k| match *k {
            EffectKey::Blur(a) => (0u8, u64::from(a)),
            EffectKey::Glass(a) => (1, a),
            EffectKey::Custom(a) => (2, a),
        });
        keys.dedup();
        keys.len()
    }

    /// The batching rule, in one place: which gathers the sink will actually hand to the batched pass.
    ///
    /// Both the schedule builder and the sink must agree on this exactly. The builder needs it because
    /// a deferred gather does **not** touch its tiles during the walk, so it must not close the tile's
    /// paint batch in [`coalesce`](super::builder) — otherwise a screenful of lenses shatters every
    /// tile's shapes into one rasterize per run between them, which measured at 121 rasterizer
    /// invocations per frame against 1 for the same scene without lenses. The sink needs it to know
    /// which steps to skip. Deriving it here means they cannot drift apart.
    ///
    /// `needs_snapshot` gathers are batchable **only when [`SNAPSHOT_TIER`] is on** — then the builder
    /// emits a snapshot of their backdrop at their z and the batch reads that. With the tier off they
    /// are excluded and stay inline (batching them off the finished tiles would read the wrong
    /// backdrop — the exact divergence the tier exists to fix).
    #[must_use]
    pub fn batched_groups(&self) -> Vec<Vec<usize>> {
        self.deferrable_blur_groups()
            .into_iter()
            .map(|g| {
                g.into_iter()
                    .filter(|&i| SNAPSHOT_TIER || !self.gathers[i].needs_snapshot)
                    .collect::<Vec<_>>()
            })
            .filter(|g| g.len() >= GATHER_MIN)
            .collect()
    }

    /// The `(shape, source_tile)` pairs the builder must snapshot this frame: every batched gather's
    /// backdrop tiles, but only for gathers whose finished tiles won't hold the right backdrop
    /// (`needs_snapshot`). Empty when [`SNAPSHOT_TIER`] is off. Deriving it here — from the same
    /// `batched_groups` the sink reads — is what keeps the snapshot set and the batch set in agreement.
    #[must_use]
    pub fn snapshot_targets(&self) -> Vec<(u128, TileKey)> {
        if !SNAPSHOT_TIER {
            return Vec::new();
        }
        let mut out = Vec::new();
        for gi in self.batched_groups().into_iter().flatten() {
            let g = &self.gathers[gi];
            if g.needs_snapshot {
                for &tile in &g.reads {
                    out.push((g.shape, tile));
                }
            }
        }
        out
    }

    /// Gathers below this many in a group are not worth an atlas — they keep the inline path.
    /// Deferrable **background-blur** gathers grouped by effect key (radius), as indices into
    /// [`gathers`](Self::gathers). Each group shares one σ, so the batched pass composes their backdrops
    /// into one atlas and blurs it once. Groups keep z-order (the gathers are z-sorted already). Only
    /// blur is grouped here — glass/custom keep the inline path in v1. Groups of any size are returned;
    /// the sink decides the batch-worthiness threshold.
    #[must_use]
    pub fn deferrable_blur_groups(&self) -> Vec<Vec<usize>> {
        let mut by_radius: Vec<(u32, Vec<usize>)> = Vec::new();
        for (i, g) in self.gathers.iter().enumerate() {
            if !g.deferrable || !g.pure_lens {
                continue;
            }
            let EffectKey::Blur(r) = g.effect_key else { continue };
            if let Some(entry) = by_radius.iter_mut().find(|(k, _)| *k == r) {
                entry.1.push(i);
            } else {
                by_radius.push((r, vec![i]));
            }
        }
        by_radius.into_iter().map(|(_, v)| v).collect()
    }

    /// Estimated gather **passes** with the collapse applied: all deferrable gathers share one batched
    /// pass (they are provably independent — see the module docs), and each non-deferrable gather keeps
    /// its own inline pass. This is the number the bench compares against the un-collapsed `total()`.
    #[must_use]
    pub fn estimated_passes(&self) -> usize {
        let deferrable = self.deferrable_count();
        let inline = self.total() - deferrable;
        usize::from(deferrable > 0) + inline
    }
}

/// Build the gather-collapse plan from the **pre-coalesce** schedule steps (one `Body` op per `Paint`,
/// so a shape's z-position and its coverage conflicts are unambiguous) plus the scene the ids resolve
/// against. Run before `coalesce`; the tiles/shape-ids it records survive it.
#[must_use]
pub fn analyze_gathers(scene: &Scene, modifiers: &Modifiers, steps: &[Step]) -> GatherPlan {
    // Gather-free frames (the overwhelming common case) skip all of this: no ComposeBackdrop, so the
    // coverage machinery below never allocates.
    if !steps.iter().any(|s| matches!(s, Step::ComposeBackdrop { .. })) {
        return GatherPlan::default();
    }

    // Accumulate each gather shape's compose/paint footprint by scanning the steps once.
    let mut gathers: Vec<GatherInfo> = Vec::new();
    let mut index_of: std::collections::HashMap<u128, usize> = std::collections::HashMap::new();
    for (i, step) in steps.iter().enumerate() {
        match step {
            Step::ComposeBackdrop { shape, read_from, extent, reach, acceptable_downscale, .. } => {
                let Some(node) = scene.get(*shape) else { continue };
                let Some(key) = effect_key(node) else { continue };
                let reads = read_from.iter().filter_map(|s| s.tile).collect();
                let output = shape_rect(scene, modifiers, *shape).unwrap_or(*extent);
                index_of.insert(*shape, gathers.len());
                gathers.push(GatherInfo {
                    shape: *shape,
                    effect_key: key,
                    order: i,
                    reads,
                    writes: Vec::new(),
                    sample: *extent,
                    reach: *reach,
                    acceptable_downscale: *acceptable_downscale,
                    output,
                    deferrable: true, // provisional; the coverage pass below decides the tier
                    needs_snapshot: false,
                    pure_lens: node.fills.is_empty() && node.strokes.is_empty(),
                });
            }
            Step::PaintGather { shape, write_to, .. } => {
                if let Some(&gi) = index_of.get(shape) {
                    if let Some(tile) = write_to.tile {
                        gathers[gi].writes.push(tile);
                    }
                }
            }
            _ => {}
        }
    }

    // Every write in z-order, as (step index, page rect, owning shape if excludable). A gather is
    // deferrable only if none of these — from a *later* step, over its output, and not its own —
    // overlaps it. `owner = Some(s)` lets a gather skip its own body/compose/paint steps.
    let mut writes: Vec<(usize, Rect, Option<u128>)> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        match step {
            Step::Paint { ops, .. } => {
                // Pre-coalesce each Paint is a single op; a Body contributes its shape's bounds.
                for op in ops {
                    if let PaintOp::Body(s) = op {
                        if let Some(r) = shape_rect(scene, modifiers, *s) {
                            writes.push((i, r, Some(*s)));
                        }
                    }
                }
            }
            // A fold into `Target` is the finalize/present of a whole tile, not content painted over
            // the gather — it never blocks deferral. Only composites into a tile/scope surface do.
            Step::Composite { rect, to, .. } if !to.is_target() => writes.push((i, *rect, None)),
            Step::PaintGather { shape, clip, .. } => writes.push((i, *clip, Some(*shape))),
            _ => {}
        }
    }

    // Every gather's read region, so a gather that *feeds* a later one can be spotted. This is not a
    // write and so is invisible to the loop above, but it is just as disqualifying: the batch composes
    // all backdrops before it scatters any result, so a producer can never share a batch with its
    // consumer.
    let reads: Vec<(usize, Rect)> = gathers.iter().map(|g| (g.order, g.sample)).collect();

    // Tier each gather (see the module docs): covered output → inline; covered sample only →
    // deferrable but the sink must freeze its backdrop; neither → deferrable off the finished tiles.
    let tiers: Vec<(bool, bool)> = gathers
        .iter()
        .map(|g| {
            let later = |rect: Rect| {
                writes.iter().any(|&(i, r, owner)| i > g.order && owner != Some(g.shape) && overlaps(r, rect))
            };
            let feeds_a_later_gather = reads.iter().any(|&(o, s)| o > g.order && overlaps(s, g.output));
            if feeds_a_later_gather || later(g.output) {
                (false, false)
            } else {
                (true, later(g.sample))
            }
        })
        .collect();
    for (g, (deferrable, needs_snapshot)) in gathers.iter_mut().zip(tiers) {
        g.deferrable = deferrable;
        g.needs_snapshot = needs_snapshot;
    }

    GatherPlan { gathers }
}

/// The gather effect's identity, or `None` if the node carries no gather effect.
fn effect_key(node: &Node) -> Option<EffectKey> {
    if let Some(radius) = node.background_blur {
        return Some(EffectKey::Blur(radius.to_bits()));
    }
    if let Some(g) = node.glass {
        return Some(EffectKey::Glass(hash_glass(&g)));
    }
    if let Some(c) = node.gather_shader() {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        c.wgsl.hash(&mut h);
        c.reach.to_bits().hash(&mut h);
        for p in &c.params {
            p.to_bits().hash(&mut h);
        }
        return Some(EffectKey::Custom(h.finish()));
    }
    None
}

/// Hash every glass parameter (all `f32`, via bit pattern) into one key, so two glass shapes with
/// identical settings share a dispatch and two with different settings do not.
fn hash_glass(g: &Glass) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    g.surface_type.hash(&mut h);
    for f in [
        g.bezel_width, g.thickness, g.refractive_index, g.specular_angle, g.specular_opacity,
        g.specular_saturation, g.chromatic_aberration, g.splay, g.tilt_angle, g.edge_boost, g.zoom,
        g.blur, g.frost,
    ] {
        f.to_bits().hash(&mut h);
    }
    h.finish()
}

/// A shape's page-space bounds under its live modifier, or `None` if it has no node.
fn shape_rect(scene: &Scene, modifiers: &Modifiers, id: u128) -> Option<Rect> {
    let node = scene.get(id)?;
    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    Some(page_bounds(node, m))
}

/// Whether two page-space rects overlap with positive area (touching edges do not count).
fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

#[cfg(test)]
mod tests {
    use kurbo::{Affine, Rect};

    use crate::host::Modifiers;
    use crate::model::{Node, Scene, ShapeKind, ROOT_ID};
    use crate::schedule::builder::build_visible;
    use crate::tiling;

    use super::analyze_gathers;

    const W: u32 = 2048;
    const H: u32 = 2048;

    fn scene_tree(root_children: Vec<u128>, nodes: Vec<Node>) -> Scene {
        let mut s = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = root_children;
        s.insert(root);
        for n in nodes {
            s.insert(n);
        }
        s
    }

    fn bg_blur(id: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> Node {
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(x0, y0, x1, y1);
        n.background_blur = Some(8.0);
        n
    }

    fn plain(id: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> Node {
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(x0, y0, x1, y1);
        n
    }

    fn plan_for(scene: &Scene) -> super::GatherPlan {
        let visible = tiling::visible_tiles(Affine::IDENTITY, W, H).into_iter().collect();
        // Rebuild the raw (pre-coalesce) steps the way build_visible does, then analyze them.
        let sched = build_visible(scene, Affine::IDENTITY, &Modifiers::new(), &visible, None);
        analyze_gathers(scene, &Modifiers::new(), &sched.steps)
    }

    #[test]
    fn independent_gathers_all_defer_into_one_pass() {
        // Three background-blur rects, far apart, nothing above any of them.
        let scene = scene_tree(
            vec![1, 2, 3],
            vec![
                bg_blur(1, 50.0, 50.0, 200.0, 200.0),
                bg_blur(2, 700.0, 700.0, 850.0, 850.0),
                bg_blur(3, 1400.0, 1400.0, 1550.0, 1550.0),
            ],
        );
        let plan = plan_for(&scene);
        assert_eq!(plan.total(), 3);
        assert_eq!(plan.deferrable_count(), 3, "disjoint topmost gathers all defer");
        assert_eq!(plan.estimated_passes(), 1, "three independent gathers collapse to one pass");
        assert_eq!(plan.batched_dispatches(), 1, "same blur radius -> one dispatch");
    }

    #[test]
    fn stacked_gathers_do_not_collapse() {
        // Three concentric background blurs: each higher one covers the ones below, so only the top is
        // topmost. The collapse must refuse — one pass per level, same as today.
        let scene = scene_tree(
            vec![1, 2, 3],
            vec![
                bg_blur(1, 100.0, 100.0, 500.0, 500.0),
                bg_blur(2, 150.0, 150.0, 450.0, 450.0),
                bg_blur(3, 200.0, 200.0, 400.0, 400.0),
            ],
        );
        let plan = plan_for(&scene);
        assert_eq!(plan.total(), 3);
        assert_eq!(plan.deferrable_count(), 1, "only the topmost gather defers");
        assert_eq!(plan.estimated_passes(), 3, "stacked gathers stay one pass each");
    }

    #[test]
    fn a_plain_shape_above_a_gather_blocks_its_deferral() {
        // Gather 1, then a plain rect 2 painted over it (higher z, overlapping). The gather cannot
        // defer past the plain content.
        let scene = scene_tree(
            vec![1, 2],
            vec![bg_blur(1, 100.0, 100.0, 400.0, 400.0), plain(2, 200.0, 200.0, 300.0, 300.0)],
        );
        let plan = plan_for(&scene);
        assert_eq!(plan.deferrable_count(), 0, "a shape painted over the gather blocks deferral");
        assert_eq!(plan.estimated_passes(), 1);
    }

    #[test]
    fn a_shape_in_the_blur_fringe_above_still_batches_but_needs_a_snapshot() {
        // Plain rect 2 does NOT overlap gather 1's output (400..470 vs 100..380) but sits within its
        // blur reach — inside the sample rect. The scatter is still z-correct (nothing covers the
        // lens), but the finished tiles no longer hold the backdrop it read, so it batches only with a
        // frozen copy.
        let mut blur = bg_blur(1, 100.0, 100.0, 380.0, 380.0);
        blur.background_blur = Some(64.0); // a wide blur → a fat fringe past the output
        let scene = scene_tree(vec![1, 2], vec![blur, plain(2, 400.0, 100.0, 470.0, 380.0)]);
        let plan = plan_for(&scene);
        assert_eq!(plan.deferrable_count(), 1, "a covered fringe no longer costs the whole deferral");
        assert!(plan.gathers[0].needs_snapshot, "but the backdrop has to be frozen at its z");
    }

    #[test]
    fn an_undisturbed_gather_batches_without_a_snapshot() {
        // Nothing above at all: the finished tiles still hold exactly the backdrop the lens read.
        let scene = scene_tree(
            vec![1, 2],
            vec![plain(1, 0.0, 0.0, 600.0, 600.0), bg_blur(2, 150.0, 150.0, 350.0, 350.0)],
        );
        let plan = plan_for(&scene);
        assert_eq!(plan.deferrable_count(), 1);
        assert!(!plan.gathers[0].needs_snapshot, "no snapshot when nothing disturbed the sample");
    }

    #[test]
    fn a_gather_feeding_a_later_gather_cannot_batch() {
        // B's sample reaches over A's output while B's own output stays clear of A's sample, so no
        // *write* test catches it. But the batch composes every backdrop before it scatters any
        // result, so B would read A's region un-blurred. A must run inline.
        let mut a = bg_blur(1, 100.0, 100.0, 300.0, 300.0);
        a.background_blur = Some(4.0); // a narrow fringe, so B's output stays outside A's sample
        let mut b = bg_blur(2, 360.0, 100.0, 560.0, 300.0);
        b.background_blur = Some(160.0); // a wide reach, so B's sample swallows A's output
        let scene = scene_tree(vec![1, 2], vec![a, b]);
        let plan = plan_for(&scene);
        assert!(!plan.gathers[0].deferrable, "the producer cannot share a batch with its consumer");
        assert!(plan.gathers[1].deferrable, "the consumer itself is unobstructed");
    }

    #[test]
    fn a_plain_shape_below_a_gather_is_just_backdrop() {
        // Plain rect 1 below, gather 2 above it. The plain shape is backdrop; the gather is topmost.
        let scene = scene_tree(
            vec![1, 2],
            vec![plain(1, 100.0, 100.0, 400.0, 400.0), bg_blur(2, 150.0, 150.0, 350.0, 350.0)],
        );
        let plan = plan_for(&scene);
        assert_eq!(plan.deferrable_count(), 1, "content below a gather never blocks it");
        assert_eq!(plan.estimated_passes(), 1);
    }
}
