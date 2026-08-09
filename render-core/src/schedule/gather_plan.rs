//! Gather-collapse analysis — decides which gather effects can be **deferred** into one batched pass.
//!
//! A gather (background blur / glass / backdrop-reading custom shader) reads the content beneath it,
//! so today each one forces its own backdrop-compose + blur pass — a GPU round-trip apiece, the cost
//! the profiler pinned at ~90 ms for a screenful. Independent gathers, though, all read *already
//! finished* backdrop and land on *disjoint* regions, so their blurs can run together in a single
//! pass (one dispatch per distinct effect) and scatter back afterwards. This module finds those.
//!
//! The rule is deliberately conservative and provably z-safe: a gather is **deferrable** only when it
//! is *topmost across its whole sample region* — no later shape of any kind (plain body, composite, or
//! another gather) overlaps its **sample rect** (its output silhouette grown by the blur reach). That
//! stronger test — the sample rect, not just the output — is what lets the batched pass compose every
//! deferrable backdrop at *end of frame* instead of freezing it mid-walk: if nothing above ever
//! touched even the blur fringe, the tiles under the sample rect read the same at end-of-frame as they
//! did at the gather's z-position. So the batch needs **no per-tile snapshots** — it recomposes each
//! backdrop from the finished tiles and gets a pixel-identical result. (The versioned snapshot pool
//! stays on the shelf; it would only be needed to *recover* the fringe cases this rule drops.)
//!
//! A useful consequence falls out for free: if gather B read gather A's output, B would sit *above*
//! and *overlap* A — which would make A non-deferrable. So **every deferrable gather is mutually
//! independent**, and they all collapse into a *single* batched pass. Genuinely stacked gathers (a
//! blur of a blur) fail the topmost test at every level but the top, so they stay inline — one pass
//! each, exactly as today. That is the honest limit: the collapse pays for *independent* gathers
//! (the common "many panels over one background" file) and is a correct no-op for *stacked* ones.
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
    /// Page-space output silhouette (the scatter clip).
    pub output: Rect,
    /// Topmost in its region → safe to defer into the batched pass. Otherwise it runs inline (its own
    /// pass), exactly as today.
    pub deferrable: bool,
}

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
            Step::ComposeBackdrop { shape, read_from, extent, .. } => {
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
                    output,
                    deferrable: true, // provisional; the coverage pass below can only clear it
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

    // Coverage: clear `deferrable` for any gather with a later write overlapping its **sample** rect
    // (output grown by blur reach). Using the sample rect — not just the output — is what makes the
    // backdrop z-invariant, so the batch can recompose it at end-of-frame without a snapshot.
    for g in &mut gathers {
        let covered = writes.iter().any(|&(i, r, owner)| {
            i > g.order && owner != Some(g.shape) && overlaps(r, g.sample)
        });
        if covered {
            g.deferrable = false;
        }
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
        let sched = build_visible(scene, Affine::IDENTITY, &Modifiers::new(), &visible);
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
    fn a_shape_in_the_blur_fringe_above_blocks_deferral() {
        // Plain rect 2 does NOT overlap gather 1's output (400..470 vs 100..380) but sits within its
        // blur reach — inside the sample rect. The sample-rect rule must catch it, so the backdrop
        // stays z-invariant and no snapshot is needed.
        let mut blur = bg_blur(1, 100.0, 100.0, 380.0, 380.0);
        blur.background_blur = Some(64.0); // a wide blur → a fat fringe past the output
        let scene = scene_tree(vec![1, 2], vec![blur, plain(2, 400.0, 100.0, 470.0, 380.0)]);
        let plan = plan_for(&scene);
        assert_eq!(plan.deferrable_count(), 0, "a shape in the blur fringe above blocks deferral");
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
