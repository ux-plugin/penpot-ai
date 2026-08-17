//! Flat, data-parallel restatement of the builder's per-shape walk — the CPU **oracle** the classic
//! backend's GPU compute kernel transliterates (see the effect-resolution / native-compile plan).
//!
//! [`super::builder::visit`] is a recursive, stateful walk (scope/clip stacks, container isolation,
//! gathers). ~84% of a full-rebuild's CPU cost is the *per-shape* part of it — assign each shape to
//! the tiles it covers and emit its paints — which is embarrassingly parallel once the hierarchy is
//! resolved. This module is that per-shape kernel written flat: [`flatten_leaves`] resolves the scene
//! to page-space [`FlatShape`]s (V1: only when the scene is all plain leaves, else the recursive walk
//! stands), and [`walk_flat_into`] emits the paints as `count → scatter`, the shape a GPU dispatch
//! takes. It is proven byte-identical to `visit` for eligible scenes (see the tests), so it is the
//! reference the WGSL port is diffed against — algorithm and GPU are never debugged at once.

use std::cell::Cell;
use std::collections::HashSet;

use kurbo::{Affine, Rect};

use crate::host::Modifiers;
use crate::model::{Scene, ShapeKind};
use crate::tiling::{self, TileKey};

use super::builder::{affected_page_rect, has_gather_effect, has_spread_effect, layer_paint, page_bounds, tile_page_rect};
use super::step::{PaintOp, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};

/// Same recursion bound as [`super::builder::visit`]: past this, bail to the recursive walk (which has
/// its own guard) rather than risk a stack overflow on a pathological tree.
const MAX_DEPTH: u32 = 256;

thread_local! {
    /// Kill-switch for the flat walk (and the test toggle). Default **on**: an eligible full-rebuild
    /// frame uses [`walk_flat_into`], which is proven identical to `visit`. Flip off to force the
    /// recursive walk — the fallback the classic GPU path also lands on when a device lacks WebGPU.
    static FLAT_WALK: Cell<bool> = const { Cell::new(true) };
}

thread_local! {
    /// Count of builds that took the flat (linearised) walk rather than the recursive `visit` — a
    /// diagnostic that a scene is actually eligible (e.g. that a deep nested-group stress scene engages
    /// the flat path, not the fallback). Monotonic; never reset.
    static FLAT_USED: Cell<u32> = const { Cell::new(0) };
}

/// Record that this build used the flat walk (see [`flat_walk_used`]).
pub fn note_flat_walk_used() {
    FLAT_USED.with(|c| c.set(c.get().wrapping_add(1)));
}

/// How many builds have taken the flat walk since process start — `0` means every build fell back to
/// the recursive `visit` (the scene was never eligible).
#[must_use]
pub fn flat_walk_used() -> u32 {
    FLAT_USED.with(Cell::get)
}

/// Enable/disable the flat walk. Default on.
pub fn set_flat_walk(on: bool) {
    FLAT_WALK.with(|c| c.set(on));
}

/// Whether the flat walk is active.
#[must_use]
pub fn flat_walk_enabled() -> bool {
    FLAT_WALK.with(Cell::get)
}

/// One drawable leaf with its hierarchy already resolved to page space — the CPU/GPU interface. A
/// plain POD row: the GPU kernel reads an array of these, the frame's `view` + tile grid + dirty
/// region are dispatch uniforms.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlatShape {
    pub id: u128,
    /// Geometry bounds in page space (drives tile *coverage*), mirroring `visit`'s `page_bounds`.
    pub bounds: Rect,
    /// Effect-affected bounds in page space (drives the *dirty-reject*), mirroring `affected_page_rect`.
    /// Equal to `bounds` for an effect-free leaf; kept separate so the reject matches `visit` exactly.
    pub affected: Rect,
}

/// Linearise a scene into leaf [`FlatShape`]s in z-order, descending through purely organizational
/// groups. Because geometry is stored **absolute** (page space — see [`super::builder::page_bounds`],
/// which folds only the node's own transform, and `visit` never accumulates one down the tree),
/// nesting doesn't move a leaf; it only matters for *isolation*. So a leaf inside **trivial groups**
/// (a [`ShapeKind::Group`] with opacity 1, default blend, no clip, no effect) paints exactly as if it
/// were flat — `visit` just recurses through it. This collects those leaves depth-first, preserving
/// the `children`-vector order that carries z-order.
///
/// Returns `None` (→ the recursive `visit` walk runs) the moment it meets anything V1 doesn't yet
/// linearise: a **Frame** (paints a body / can clip), a **non-trivial group** (opacity/blend →
/// needs an isolation layer), a **clipping** container, or any **gather/spread effect**. Later slices
/// take those over; today they are the safe, correct fallback.
#[must_use]
pub fn flatten_leaves(scene: &Scene, modifiers: &Modifiers) -> Option<Vec<FlatShape>> {
    let mut flat = Vec::new();
    for &id in scene.roots() {
        collect(scene, id, modifiers, 0, &mut flat)?;
    }
    Some(flat)
}

fn collect(scene: &Scene, id: u128, modifiers: &Modifiers, depth: u32, out: &mut Vec<FlatShape>) -> Option<()> {
    if depth >= MAX_DEPTH {
        return None;
    }
    let node = scene.get(id)?;
    if node.hidden || node.kind == ShapeKind::Unsupported {
        // Skipped wholesale, exactly as `visit` skips a hidden / unsupported subtree.
        return Some(());
    }
    if node.kind.is_container() {
        // V1 only linearises a pure organizational group: a `Group` (a `Frame` paints its own body and
        // can clip), trivial layer paint (no isolation), not clipping, not masking, no effect. Anything
        // else bails to the recursive `visit`, which owns isolation/clip/mask emission — a masked group
        // at opacity 1 has trivial layer paint but its `DstIn` mask still needs `visit`.
        if node.kind != ShapeKind::Group
            || node.clip
            || node.masked
            || !layer_paint(node).is_trivial()
            || has_gather_effect(node)
            || has_spread_effect(node)
        {
            return None;
        }
        for &child in &node.children {
            collect(scene, child, modifiers, depth + 1, out)?;
        }
        return Some(());
    }
    // A drawable leaf: plain body only (a gather/spread leaf needs its own surface — not V1).
    if !node.children.is_empty() || has_gather_effect(node) || has_spread_effect(node) {
        return None;
    }
    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    out.push(FlatShape { id, bounds: page_bounds(node, m), affected: affected_page_rect(node, m) });
    Some(())
}

/// Emit the plain-leaf paints as `count → scatter` — the exact shape a GPU compute pass takes (count
/// the visible tiles each leaf covers, prefix-sum to output offsets, scatter one `Paint{Body}` per
/// cell). Written single-pass here (the CPU has no allocation barrier); the WGSL port splits it, but
/// the *output* is identical. With no scopes in play — guaranteed by [`flatten_leaves`] eligibility —
/// every `write_to` is the tile's own `TileOutput`, matching `visit`'s plain-body branch.
pub fn walk_flat_into(
    flat: &[FlatShape],
    view: Affine,
    visible: &HashSet<TileKey>,
    dirty_bbox: Option<Rect>,
    steps: &mut Vec<Step>,
) {
    for fs in flat {
        // Leaf dirty-reject: effect-affected bounds entirely outside the dirty region → nothing. Same
        // strict half-open test `visit` uses, against the same `affected_page_rect`.
        if let Some(db) = dirty_bbox {
            let r = fs.affected;
            if r.x1 <= db.x0 || r.x0 >= db.x1 || r.y1 <= db.y0 || r.y0 >= db.y1 {
                continue;
            }
        }
        for tile in tiling::tiles_overlapping_page_rect(view, fs.bounds) {
            if !visible.contains(&tile) {
                continue;
            }
            steps.push(Step::Paint {
                ops: vec![PaintOp::Body(fs.id)],
                clip: tile_page_rect(tile, view),
                write_to: SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile),
            });
        }
    }
}

/// One scatter output row — exactly what the GPU compute kernel writes and the CPU reads back: a
/// shape **index** (into the `FlatShape` array) plus the tile it paints. The full `Step` is rebuilt
/// CPU-side from this plus `view` (see [`records_to_steps`]), so the on-wire record stays tiny: no
/// `Rect`, no `SurfaceRef`, no `u128` — four ints, `std430`-friendly. `zoom_bucket` is constant per
/// frame (a `view` property) so on the GPU it's a dispatch uniform, not stored per record; kept here
/// for a faithful host reference.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepRecord {
    pub shape_idx: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub zoom_bucket: i32,
}

#[inline]
fn dirty_culled(fs: &FlatShape, dirty_bbox: Option<Rect>) -> bool {
    match dirty_bbox {
        Some(db) => {
            let r = fs.affected;
            r.x1 <= db.x0 || r.x0 >= db.x1 || r.y1 <= db.y0 || r.y0 >= db.y1
        }
        None => false,
    }
}

/// The walk as the GPU takes it: `count → exclusive prefix-sum → scatter`. Pass 1 counts each shape's
/// visible tiles; pass 2 scans the counts into per-shape output offsets; pass 3 scatters each shape's
/// records into its slot. Byte-identical output to [`walk_flat_into`] (proven in tests) — this is the
/// reference the WGSL transliterates, so the offset arithmetic and record layout are locked on the
/// host before any GPU code exists. Written with the same `HashSet` `visible` as the single-pass form
/// for exact parity; the GPU replaces it with the viewport tile *range* (valid on a full rebuild,
/// where `visible` is the whole viewport).
#[must_use]
pub fn count_and_scatter(
    flat: &[FlatShape],
    view: Affine,
    visible: &HashSet<TileKey>,
    dirty_bbox: Option<Rect>,
) -> Vec<StepRecord> {
    let n = flat.len();
    // Pass 1 — count.
    let mut counts = vec![0u32; n];
    for (i, fs) in flat.iter().enumerate() {
        if dirty_culled(fs, dirty_bbox) {
            continue;
        }
        counts[i] = tiling::tiles_overlapping_page_rect(view, fs.bounds)
            .into_iter()
            .filter(|t| visible.contains(t))
            .count() as u32;
    }
    // Pass 2 — exclusive prefix sum.
    let mut offsets = vec![0u32; n];
    let mut acc = 0u32;
    for i in 0..n {
        offsets[i] = acc;
        acc += counts[i];
    }
    // Pass 3 — scatter.
    let mut records = vec![StepRecord::default(); acc as usize];
    for (i, fs) in flat.iter().enumerate() {
        if dirty_culled(fs, dirty_bbox) {
            continue;
        }
        let mut local = 0u32;
        for tile in tiling::tiles_overlapping_page_rect(view, fs.bounds) {
            if !visible.contains(&tile) {
                continue;
            }
            records[(offsets[i] + local) as usize] = StepRecord {
                shape_idx: i as u32,
                tile_x: tile.tile_x,
                tile_y: tile.tile_y,
                zoom_bucket: tile.zoom_bucket,
            };
            local += 1;
        }
    }
    records
}

/// Rebuild the full `Step`s from the GPU's scatter records — the CPU-side of the readback. Each record
/// becomes the same `Paint{Body}` [`walk_flat_into`] emits; the tile geometry and target surface are
/// derived from the record's tile + `view`, never stored on the GPU.
#[must_use]
pub fn records_to_steps(records: &[StepRecord], flat: &[FlatShape], view: Affine) -> Vec<Step> {
    records
        .iter()
        .map(|r| {
            let tile = TileKey { tile_x: r.tile_x, tile_y: r.tile_y, zoom_bucket: r.zoom_bucket };
            Step::Paint {
                ops: vec![PaintOp::Body(flat[r.shape_idx as usize].id)],
                clip: tile_page_rect(tile, view),
                write_to: SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Node, Scene, ShapeKind, ROOT_ID};
    use crate::schedule::builder::build;

    const VIEW: Affine = Affine::IDENTITY;
    const W: u32 = 1024;
    const H: u32 = 1024;

    fn rect(id: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> Node {
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(x0, y0, x1, y1);
        n
    }

    fn scene_of(nodes: Vec<Node>) -> Scene {
        let mut s = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = nodes.iter().map(|n| n.id).collect();
        s.insert(root);
        for n in nodes {
            s.insert(n);
        }
        s
    }

    fn group(id: u128, children: Vec<u128>) -> Node {
        let mut n = Node::new(id, ShapeKind::Group);
        n.children = children;
        n
    }

    /// A tree: the root lists `top` (its ordered children); `nodes` supplies every node (groups and
    /// leaves) so nested containers reference their own children.
    fn scene_tree(top: Vec<u128>, nodes: Vec<Node>) -> Scene {
        let mut s = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = top;
        s.insert(root);
        for n in nodes {
            s.insert(n);
        }
        s
    }

    /// A representative nested tree: leaves scattered across groups, one group nested inside another,
    /// leaves before/after/between groups so z-order is non-trivial. All groups organizational.
    ///   root ─ rect5 · group10[ rect1, group20[ rect2, rect4 ] ] · rect3
    fn nested_scene() -> Scene {
        scene_tree(
            vec![5, 10, 3],
            vec![
                rect(5, 40.0, 40.0, 120.0, 120.0),
                group(10, vec![1, 20]),
                rect(1, 20.0, 20.0, 300.0, 300.0),
                group(20, vec![2, 4]),
                rect(2, 480.0, 100.0, 900.0, 620.0), // spans tiles
                rect(4, 700.0, 700.0, 760.0, 760.0),
                rect(3, -30.0, 520.0, 60.0, 620.0), // straddles the left edge
            ],
        )
    }

    /// Content-equality of two schedules, order-insensitive across tiles. The finalize `TileOutput →
    /// Target` composites iterate a `HashSet<TileKey>`, so their *order* is nondeterministic (and
    /// benign — disjoint tiles). Within a tile, z-order survives: `coalesce` fuses a tile's bodies into
    /// one `Paint{[Body(a), Body(b), …]}`, so a mis-ordered walk changes that op sequence and this
    /// still catches it.
    fn same_steps(a: &[Step], b: &[Step]) -> bool {
        let norm = |s: &[Step]| {
            let mut v: Vec<String> = s.iter().map(|st| format!("{st:?}")).collect();
            v.sort();
            v
        };
        norm(a) == norm(b)
    }

    /// The whole point: the flat kernel emits a byte-identical schedule to the recursive `visit` for a
    /// scene of plain leaves — several shapes, some spanning multiple tiles, some off to a corner.
    #[test]
    fn flat_walk_matches_visit_step_for_step() {
        let scene = scene_of(vec![
            rect(1, 20.0, 20.0, 300.0, 300.0),
            rect(2, 480.0, 100.0, 900.0, 620.0), // spans several 512px tiles
            rect(3, 700.0, 700.0, 760.0, 760.0),
            rect(4, 10.0, 800.0, 40.0, 830.0),
        ]);

        set_flat_walk(true);
        let flat = build(&scene, VIEW, W, H);
        set_flat_walk(false);
        let recursive = build(&scene, VIEW, W, H);
        set_flat_walk(true);

        assert!(
            same_steps(&flat.steps, &recursive.steps),
            "flat walk must reproduce the recursive walk's steps\n flat: {:#?}\n visit: {:#?}",
            flat.steps,
            recursive.steps
        );
        assert!(flat.steps.iter().any(|s| matches!(s, Step::Paint { .. })), "sanity: it emitted paints");
    }

    /// A flat leaf scene is eligible (the trivial base case; nesting is covered by the tree tests).
    #[test]
    fn a_flat_leaf_scene_is_eligible() {
        let host = Modifiers::new();
        let flat = scene_of(vec![rect(1, 0.0, 0.0, 100.0, 100.0), rect(2, 200.0, 200.0, 300.0, 300.0)]);
        assert!(flatten_leaves(&flat, &host).is_some());
    }

    /// Hidden roots contribute nothing (mirroring `visit`), so the flat schedule still matches.
    #[test]
    fn hidden_leaves_are_skipped_like_visit() {
        let mut hidden = rect(2, 100.0, 100.0, 200.0, 200.0);
        hidden.hidden = true;
        let scene = scene_of(vec![rect(1, 0.0, 0.0, 300.0, 300.0), hidden]);

        set_flat_walk(true);
        let flat = build(&scene, VIEW, W, H);
        set_flat_walk(false);
        let recursive = build(&scene, VIEW, W, H);
        set_flat_walk(true);

        assert!(same_steps(&flat.steps, &recursive.steps));
        assert!(
            !flat.steps.iter().any(|s| matches!(s, Step::Paint { ops, .. } if ops.contains(&PaintOp::Body(2)))),
            "the hidden leaf paints nothing"
        );
    }

    /// The frame's target tiles + their page-space union — what `build_visible` derives internally.
    fn visible_and_dirty(view: Affine) -> (HashSet<TileKey>, Option<Rect>) {
        let visible: HashSet<TileKey> = tiling::visible_tiles(view, W, H).into_iter().collect();
        let dirty = visible.iter().map(|&t| tile_page_rect(t, view)).reduce(|a, b| a.union(b));
        (visible, dirty)
    }

    /// The two-pass `count → scan → scatter` (the shape the GPU takes), reconstructed to `Step`s,
    /// reproduces the single-pass `walk_flat_into` **exactly** — same order, not just same content.
    /// This locks the offset arithmetic and the record→Step rebuild on the host before any WGSL.
    #[test]
    fn two_pass_scatter_matches_the_single_pass_walk() {
        let host = Modifiers::new();
        let scene = scene_of(vec![
            rect(1, 20.0, 20.0, 300.0, 300.0),
            rect(2, 480.0, 100.0, 900.0, 620.0),
            rect(3, 700.0, 700.0, 760.0, 760.0),
            rect(4, -50.0, -50.0, 40.0, 40.0), // straddles the origin corner
        ]);
        let flat = flatten_leaves(&scene, &host).expect("flat scene");

        for view in [VIEW, Affine::scale(2.0), Affine::translate((37.0, -13.0))] {
            let (visible, dirty) = visible_and_dirty(view);

            let mut single = Vec::new();
            walk_flat_into(&flat, view, &visible, dirty, &mut single);

            let records = count_and_scatter(&flat, view, &visible, dirty);
            let two_pass = records_to_steps(&records, &flat, view);

            assert_eq!(single, two_pass, "two-pass scatter must match the single-pass walk for view {view:?}");
        }
    }

    /// The scatter fills every allocated slot — no gaps (which would leave `shape_idx: 0` sentinels)
    /// and no overruns. Guards the prefix-sum sizing the WGSL depends on.
    #[test]
    fn scatter_fills_exactly_the_scanned_total() {
        let host = Modifiers::new();
        let scene = scene_of(vec![rect(1, 0.0, 0.0, 900.0, 900.0), rect(2, 600.0, 600.0, 1000.0, 1000.0)]);
        let flat = flatten_leaves(&scene, &host).unwrap();
        let (visible, dirty) = visible_and_dirty(VIEW);

        let expected: usize = flat
            .iter()
            .filter(|fs| !dirty_culled(fs, dirty))
            .map(|fs| tiling::tiles_overlapping_page_rect(VIEW, fs.bounds).into_iter().filter(|t| visible.contains(t)).count())
            .sum();
        let records = count_and_scatter(&flat, VIEW, &visible, dirty);
        assert_eq!(records.len(), expected, "scatter total must equal the summed counts");
    }

    /// The real generality check: a **nested** tree (leaves inside organizational groups, one group
    /// inside another) still linearises to the same schedule the recursive `visit` produces — flat
    /// scenes were only the easy case.
    #[test]
    fn flat_walk_matches_visit_on_a_nested_scene() {
        let scene = nested_scene();
        assert!(flatten_leaves(&scene, &Modifiers::new()).is_some(), "trivial nested groups are eligible");

        for view in [VIEW, Affine::scale(2.0), Affine::translate((21.0, -33.0))] {
            let vw = if view.as_coeffs()[0] > 1.5 { 2048 } else { W };
            set_flat_walk(true);
            let flat = build(&scene, view, vw, vw);
            set_flat_walk(false);
            let recursive = build(&scene, view, vw, vw);
            set_flat_walk(true);
            assert!(same_steps(&flat.steps, &recursive.steps), "nested flat walk must match visit for {view:?}");
        }
    }

    /// And the GPU-shaped two-pass path matches the single-pass walk on the nested tree too — so the
    /// count/scan/scatter the WGSL transliterates is exercised on nesting, not just flat input.
    #[test]
    fn two_pass_matches_single_pass_on_a_nested_scene() {
        let scene = nested_scene();
        let flat = flatten_leaves(&scene, &Modifiers::new()).expect("nested is eligible");
        let (visible, dirty) = visible_and_dirty(VIEW);

        let mut single = Vec::new();
        walk_flat_into(&flat, VIEW, &visible, dirty, &mut single);
        let two_pass = records_to_steps(&count_and_scatter(&flat, VIEW, &visible, dirty), &flat, VIEW);
        assert_eq!(single, two_pass);
    }

    /// Anything V1 doesn't linearise falls back to `visit` (returns `None`): a non-trivial group, a
    /// clipping group, and a frame all bail — the correct, safe boundary.
    #[test]
    fn ineligible_containers_fall_back() {
        let host = Modifiers::new();

        let mut faded = group(10, vec![1]);
        faded.opacity = 0.5;
        let s1 = scene_tree(vec![10], vec![faded, rect(1, 0.0, 0.0, 100.0, 100.0)]);
        assert!(flatten_leaves(&s1, &host).is_none(), "an opacity group needs an isolation layer → visit");

        let mut clipping = group(10, vec![1]);
        clipping.clip = true;
        let s2 = scene_tree(vec![10], vec![clipping, rect(1, 0.0, 0.0, 100.0, 100.0)]);
        assert!(flatten_leaves(&s2, &host).is_none(), "a clipping group → visit");

        let mut frame = Node::new(10, ShapeKind::Frame);
        frame.children = vec![1];
        let s3 = scene_tree(vec![10], vec![frame, rect(1, 0.0, 0.0, 100.0, 100.0)]);
        assert!(flatten_leaves(&s3, &host).is_none(), "a frame paints a body / can clip → visit");
    }
}
