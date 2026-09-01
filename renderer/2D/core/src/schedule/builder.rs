//! Translate a neutral scene into an SSA schedule.
//!
//! Ported from render-wasm's `tile_grid/ssa/schedule_builder.rs`. The build walks the shape tree
//! **once in z-order** and emits steps inline, so a shape's steps land at its z-position relative to
//! its peers — the property the gather z-order (later) depends on. For each shape:
//!
//! - **plain body** (no spread effect) → a `Paint` into each overlapped tile's `TileOutput`;
//! - **spread body** (drop/inner shadow, layer blur) → one `Paint` of the whole body into the
//!   shape's own `RasterEffectOutput` surface (sized to its `extrect`, so the blur is never clipped
//!   by a tile edge — the seam fix), then a `Composite` of that surface into each overlapped tile's
//!   `TileOutput`, in z-order;
//! - children recurse in z-order.
//!
//! A finalize pass composites each visible tile's `TileOutput` into `Target`.
//!
//! **Scoped containers** (`ScopeOf`): a group or frame whose `opacity`/`blend` is non-trivial can't
//! let its children paint straight into the tile — overlapping children would double-composite and
//! the group opacity would be lost. Such a container instead swaps each tile's *current scope* to
//! its own `ScopeOf(id, tile)` buffer, its body + descendants paint into that, and on close a
//! `Composite` folds the scope into the parent scope at the group's `LayerPaint`. This threads a
//! per-tile scope map through the walk (mirrors render-wasm's `per_tile_scopes`), so the write
//! target of every `Paint`/`Composite` is "the current scope for that tile," not a hard-coded
//! `TileOutput`. Nested scopes fold outward, tile by tile.
//!
//! **Gather** (`ComposeBackdrop` / `PaintGather`): background blur / glass read the backdrop
//! *beneath* the shape, the opposite dependency to spread. Emitted at the shape's z-position —
//! after everything below has painted, before the shape's own body — so the fused backdrop holds
//! exactly the below-z-order content. The `Backdrop` surface is sized to the gather's sample rect
//! (not a tile), which is what stops the blur cropping and fading on zoom-in.
//!
//! **Coverage (mirrors the render-wasm builder's own TODO staging):** flat + spread + scoped
//! containers (opacity/blend) + gather (background blur) are implemented. Frame *clipping* and
//! masked groups still fall through as plain isolation; glass/refraction and the explicit `Snapshot`
//! indirection (needed once cross-frame caching reuses tile surfaces) are the remaining gather work.

use std::collections::{HashMap, HashSet};

use kurbo::{Affine, Point, Rect};

use crate::blur::radius_to_sigma;
use crate::host::Modifiers;
use crate::model::{Node, Scene, ShapeKind};
use crate::tiling::{self, TileKey};

use super::step::{LayerPaint, PaintOp, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};

/// The spatial index the builder queries to skip the O(n) tree walk. Borrowed from `SceneState` for
/// one build. Only usable when [`DirtyIndex::flat`] — a nested tree needs the walk for ancestor
/// context.
pub struct DirtyIndex<'a> {
    /// Leaf shapes keyed on committed page bounds (a superset query per dirty region).
    pub quadtree: &'a crate::quadtree::Quadtree,
    /// Paint-order rank per leaf, to sort a query's candidates back into z-order.
    pub seq_of: &'a HashMap<u128, u32>,
    /// The tree is flat (see [`crate::host::SceneState::qt_flat`]).
    pub flat: bool,
}

/// A built schedule. The dependency graph and the backend sink consume `steps` in order.
#[derive(Debug, Default)]
pub struct Schedule {
    pub steps: Vec<Step>,
    /// The gather-collapse analysis for this frame — which gathers the sink can defer into one batched
    /// pass. Derived from the pre-coalesce steps; empty when the frame has no gather effects.
    pub gather_plan: super::gather_plan::GatherPlan,
}

/// Sub-phase profiler for [`build_visible`], to decompose the "build" CPU cost into the per-shape
/// **walk**, the **gather** analysis, and the **assemble** (snapshot + coalesce) phases — the split
/// that decides whether the scheduler is worth pushing to a GPU compute pass.
///
/// render-core has no wall clock on wasm, so the host ([`crate::prof`]-style `performance.now`) injects
/// one via [`set_clock`]. With no clock set every call is a cheap no-op, so this is inert in a normal
/// build. Deltas accumulate per frame; the host reads + resets around each `build_visible`.
pub mod buildprof {
    use std::cell::Cell;
    thread_local! {
        static CLOCK: Cell<Option<fn() -> f64>> = const { Cell::new(None) };
        static WALK: Cell<f64> = const { Cell::new(0.0) };
        static GATHER: Cell<f64> = const { Cell::new(0.0) };
        static ASSEMBLE: Cell<f64> = const { Cell::new(0.0) };
    }
    /// Inject the host's high-resolution clock (ms). Until called, timing is a no-op.
    pub fn set_clock(f: fn() -> f64) {
        CLOCK.with(|c| c.set(Some(f)));
    }
    /// A timestamp in ms, or `None` when no clock is injected (the normal, un-profiled build).
    #[must_use]
    pub fn now() -> Option<f64> {
        CLOCK.with(Cell::get).map(|f| f())
    }
    pub fn add_walk(ms: f64) {
        WALK.with(|c| c.set(c.get() + ms));
    }
    pub fn add_gather(ms: f64) {
        GATHER.with(|c| c.set(c.get() + ms));
    }
    pub fn add_assemble(ms: f64) {
        ASSEMBLE.with(|c| c.set(c.get() + ms));
    }
    /// `(walk, gather, assemble)` ms accumulated since the last [`reset`].
    #[must_use]
    pub fn read() -> (f64, f64, f64) {
        (WALK.with(Cell::get), GATHER.with(Cell::get), ASSEMBLE.with(Cell::get))
    }
    pub fn reset() {
        WALK.with(|c| c.set(0.0));
        GATHER.with(|c| c.set(0.0));
        ASSEMBLE.with(|c| c.set(0.0));
    }
}

/// Build the schedule for one frame. `view` is the page→device transform (`root * viewport`);
/// `viewport_w/h` are the device viewport size, used to bound the finalize pass to visible tiles.
#[must_use]
pub fn build(scene: &Scene, view: Affine, viewport_w: u32, viewport_h: u32) -> Schedule {
    let visible: HashSet<TileKey> = tiling::visible_tiles(view, viewport_w, viewport_h)
        .into_iter()
        .collect();
    build_visible(scene, view, &Modifiers::new(), &visible, None)
}

/// Build the schedule for an explicit set of target tiles — the tiles that must be (re)produced this
/// frame. `build` passes the full visible set; the tile cache passes only the *dirty* subset (missing
/// or invalidated), so a pan re-runs the schedule for just the newly-exposed strip and blits the rest
/// from cache. Each target tile's `TileOutput` is self-contained — the walk emits every shape/effect
/// overlapping it — so any subset is correct on its own.
#[must_use]
pub fn build_visible(
    scene: &Scene,
    view: Affine,
    modifiers: &Modifiers,
    visible: &HashSet<TileKey>,
    index: Option<DirtyIndex>,
) -> Schedule {
    let _t0 = buildprof::now();
    let mut steps = Vec::new();

    let mut scopes: HashMap<TileKey, SurfaceRef> = visible
        .iter()
        .map(|&t| (t, SurfaceRef::tile_ref(SurfaceRole::TileOutput, t)))
        .collect();

    let dirty_bbox: Option<Rect> = dirty_page_bbox(view, visible);
    let fast: Option<Vec<u128>> = match (index, dirty_bbox) {
        (Some(ix), Some(bbox)) if ix.flat => {
            let mut set: HashSet<u128> = HashSet::new();
            ix.quadtree.query(bbox, &mut set);
            let mut ids: Vec<u128> = set.into_iter().collect();
            ids.sort_unstable_by_key(|id| ix.seq_of.get(id).copied().unwrap_or(u32::MAX));
            Some(ids)
        }
        _ => None,
    };
    match (fast, dirty_bbox) {
        (Some(candidates), _) => {
            for id in candidates {
                visit(scene, id, view, modifiers, visible, &mut scopes, &mut steps, 0, dirty_bbox);
            }
        }
        (None, Some(_)) => {
            let flat = super::flatten::flat_walk_enabled()
                .then(|| super::flatten::flatten_leaves(scene, modifiers))
                .flatten();
            if let Some(flat) = flat {
                super::flatten::note_flat_walk_used();
                super::flatten::walk_flat_into(&flat, view, visible, dirty_bbox, &mut steps);
            } else {
                for &id in scene.roots() {
                    visit(scene, id, view, modifiers, visible, &mut scopes, &mut steps, 0, dirty_bbox);
                }
            }
        }
        (None, None) => {}
    }

    steps.extend(finalize_composites(view, visible));

    let _t1 = buildprof::now();
    if let (Some(a), Some(b)) = (_t0, _t1) {
        buildprof::add_walk(b - a);
    }

    finish_schedule(steps, scene, modifiers)
}

/// The page-space bounding box of the target tiles (the union of their rects) — the dirty region a
/// leaf's effect-expanded bounds must intersect to emit anything this frame. `None` when nothing is
/// dirty. Exposed so a backend running the walk itself (the classic GPU walk) can derive the exact
/// same dirty region [`build_visible`] uses, keeping the two walks bit-comparable.
#[must_use]
pub fn dirty_page_bbox(view: Affine, visible: &HashSet<TileKey>) -> Option<Rect> {
    visible.iter().map(|&t| tile_page_rect(t, view)).reduce(|a, b| a.union(b))
}

/// The `TileOutput → Target` composites that close a frame: one per visible tile, folding its
/// accumulated output into the single Target the swapchain presents. `erase_after: false` — with the
/// tile cache the `TileOutput` buffer is retained for reuse next frame; the sink owns its lifetime
/// (LRU eviction), not this fold. Split out so a GPU-walk path can append the identical finalize.
#[must_use]
pub fn finalize_composites(view: Affine, visible: &HashSet<TileKey>) -> Vec<Step> {
    visible
        .iter()
        .map(|&tile| Step::Composite {
            from: SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile),
            to: SurfaceRef::target(),
            paint: LayerPaint::opaque(),
            rect: tile_page_rect(tile, view),
            erase_after: false,
        })
        .collect()
}

/// Everything after the per-shape walk: analyse gathers on the raw one-Body-per-Paint steps, then
/// snapshot + coalesce into the final schedule. Takes the walk's `steps` (paints + finalize
/// composites) so it is shared by the recursive/flat CPU walk in [`build_visible`] *and* the classic
/// backend's GPU walk, which produces the same `steps` via
/// [`super::flatten::records_to_steps`] + [`finalize_composites`] and hands them here — the serial
/// ~16% of the build that stays on the CPU in both backends.
#[must_use]
pub fn finish_schedule(steps: Vec<Step>, scene: &Scene, modifiers: &Modifiers) -> Schedule {
    let _t1 = buildprof::now();
    let gather_plan = super::gather_plan::analyze_gathers(scene, modifiers, &steps);
    let deferred: HashSet<u128> = gather_plan
        .batched_groups()
        .into_iter()
        .flatten()
        .map(|gi| gather_plan.gathers[gi].shape)
        .collect();
    let _t2 = buildprof::now();
    if let (Some(a), Some(b)) = (_t1, _t2) {
        buildprof::add_gather(b - a);
    }

    let steps = insert_snapshots(steps, &gather_plan);
    let steps = coalesce(steps, &deferred);
    let _t3 = buildprof::now();
    if let (Some(a), Some(b)) = (_t2, _t3) {
        buildprof::add_assemble(b - a);
    }
    Schedule { steps, gather_plan }
}

/// Emit a [`Step::Snapshot`] just before each batched, `needs_snapshot` gather's `ComposeBackdrop`,
/// capturing the exact surface that `ComposeBackdrop` reads for each of its backdrop tiles (which is
/// already `current(tile)` — the live scope, so scoped gathers snapshot the right buffer for free).
///
/// The snapshot's `write_to` is the gather's snapshot id, [`SurfaceRef::snapshot`], which the sink's
/// batched pass reads. Positioned immediately before the (deferred) `ComposeBackdrop`, so it lands
/// after every below-z paint and before the gather — and `coalesce` will close the tile's paint batch
/// on the snapshot's read, exactly as an inline gather would. `snapshot_targets` is empty when the
/// tier is off, so this returns `steps` untouched.
fn insert_snapshots(steps: Vec<Step>, plan: &super::gather_plan::GatherPlan) -> Vec<Step> {
    let targets = plan.snapshot_targets();
    if targets.is_empty() {
        return steps;
    }
    let mut by_shape: HashMap<u128, Vec<TileKey>> = HashMap::new();
    for (shape, tile) in targets {
        by_shape.entry(shape).or_default().push(tile);
    }
    let mut out = Vec::with_capacity(steps.len() + by_shape.values().map(Vec::len).sum::<usize>());
    for step in steps {
        if let Step::ComposeBackdrop { shape, read_from, .. } = &step {
            if let Some(tiles) = by_shape.get(shape) {
                for &tile in tiles {
                    if let Some(from) = read_from.iter().find(|r| r.tile == Some(tile)).copied() {
                        out.push(Step::Snapshot { from, write_to: SurfaceRef::snapshot(*shape, tile) });
                    }
                }
            }
        }
        out.push(step);
    }
    out
}

/// Merge consecutive `Paint`s into the same tile/scope surface into one batched `Paint`, so the sink
/// renders a run of plain shapes in a single pass instead of one `renderer.render` + submit per
/// shape (the dominant plain-content cost the profiler found).
///
/// Order-preserving by construction: a batch stays open only while nothing touches its surface. Any
/// step that reads/writes/rewrites the surface — a spread effect compositing in, a scope fold, a
/// gather sampling the tile, the finalize fold to `Target` — closes the batch, so a shape that must
/// layer between two plain runs still splits them and z-order is exact. Only `TileOutput`/`ScopeOf`
/// paints merge; a spread's `RasterEffectOutput` is a per-shape isolated surface and never merges.
fn coalesce(steps: Vec<Step>, deferred: &HashSet<u128>) -> Vec<Step> {
    let mut out: Vec<Step> = Vec::with_capacity(steps.len());
    let mut open: HashMap<SurfaceRef, usize> = HashMap::new();
    for step in steps {
        if let Step::Paint { ops, write_to, .. } = &step {
            if matches!(write_to.role, SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_)) {
                if let Some(&i) = open.get(write_to) {
                    if let Step::Paint { ops: acc, .. } = &mut out[i] {
                        acc.extend_from_slice(ops);
                        continue;
                    }
                }
                open.insert(*write_to, out.len());
            }
            out.push(step);
            continue;
        }
        let deferred_gather = matches!(
            &step,
            Step::ComposeBackdrop { shape, .. } | Step::PaintGather { shape, .. } if deferred.contains(shape)
        );
        if !deferred_gather {
            for s in step.reads().into_iter().chain(step.writes()).chain(step.rewrites()) {
                open.remove(&s);
            }
        }
        out.push(step);
    }
    out
}

/// The indices of the `Paint` steps that are the **first write** to their surface, in schedule
/// order. This is the SSA-order primitive the atlas prepass builds on: a surface's first `Paint` is
/// a level-0 body (a tile/scope body, or a per-shape effect body) that is independent of every other
/// surface's, so a run of them can be batch-rendered into one atlas. A surface's *second* paint (the
/// run after an interleaved composite/gather) is deliberately excluded — it must stay ordered where
/// the schedule put it. Getting this wrong corrupts z-order, so it lives here next to the builder
/// that establishes the order, not re-derived per backend. Callers filter the returned indices by
/// `write_to.role` (tile/scope bodies vs effect surfaces) for the specific atlas they are packing.
#[must_use]
pub fn first_write_paints(steps: &[Step]) -> Vec<usize> {
    let mut seen: HashSet<SurfaceRef> = HashSet::new();
    let mut firsts = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let first = matches!(step, Step::Paint { write_to, .. } if !seen.contains(write_to));
        for s in step.writes().into_iter().chain(step.rewrites()) {
            seen.insert(s);
        }
        if first {
            firsts.push(i);
        }
    }
    firsts
}

const MAX_DEPTH: u32 = 256;

#[expect(clippy::too_many_arguments, reason = "the walk threads scene + view + gesture state")]
fn visit(
    scene: &Scene,
    id: u128,
    view: Affine,
    modifiers: &Modifiers,
    visible: &HashSet<TileKey>,
    scopes: &mut HashMap<TileKey, SurfaceRef>,
    steps: &mut Vec<Step>,
    depth: u32,
    dirty_bbox: Option<Rect>,
) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);

    if node.children.is_empty() {
        if let Some(db) = dirty_bbox {
            let r = affected_page_rect(node, m);
            if r.x1 <= db.x0 || r.x0 >= db.x1 || r.y1 <= db.y0 || r.y0 >= db.y1 {
                return;
            }
        }
    }

    let is_group = node.kind == ShapeKind::Group;
    let lp = layer_paint(node);
    let is_masked = is_group && node.masked && node.children.len() >= 2;
    let scope_wrap = node.kind.is_container() && (!lp.is_trivial() || is_masked);
    let use_layer = scope_wrap && !subtree_needs_surface(scene, id);
    let apply_mask = is_masked && use_layer;
    let saved: Option<Vec<(TileKey, SurfaceRef)>> = if scope_wrap && !use_layer {
        let saved: Vec<(TileKey, SurfaceRef)> = scopes.iter().map(|(&t, &s)| (t, s)).collect();
        for (&tile, scope) in scopes.iter_mut() {
            *scope = SurfaceRef::tile_ref(SurfaceRole::ScopeOf(id), tile);
        }
        Some(saved)
    } else {
        None
    };
    let layer_tiles: Vec<(TileKey, SurfaceRef)> = if use_layer {
        let cover: HashSet<TileKey> = subtree_page_bounds(scene, id, modifiers)
            .map(|b| tiling::tiles_overlapping_page_rect(view, b).into_iter().collect())
            .unwrap_or_default();
        scopes.iter().filter(|(t, _)| cover.contains(t)).map(|(&t, &s)| (t, s)).collect()
    } else {
        Vec::new()
    };
    for &(tile, scope) in &layer_tiles {
        steps.push(Step::Paint {
            ops: vec![PaintOp::PushLayer(id)],
            clip: tile_page_rect(tile, view),
            write_to: scope,
        });
    }

    let current = |tile: TileKey| {
        scopes
            .get(&tile)
            .copied()
            .unwrap_or_else(|| SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile))
    };

    if has_gather_effect(node) {
        let paint_tiles: Vec<TileKey> = tiling::tiles_overlapping_page_rect(view, page_bounds(node, m))
            .into_iter()
            .filter(|t| visible.contains(t))
            .collect();
        if !paint_tiles.is_empty() {
            let reach = gather_reach(node);
            let sample = page_bounds(node, m).inflate(reach, reach);
            let backdrop = SurfaceRef::new(SurfaceRole::Backdrop(id), None, 0);
            let read_from: Vec<SurfaceRef> = tiling::tiles_overlapping_page_rect(view, sample)
                .into_iter()
                .map(current)
                .collect();
            let always_cap = false;
            let acceptable_downscale = effect_acceptable_downscale(node);
            let tile_mode = node.glass.map(|g| g.tile_mode).unwrap_or_default();
            steps.push(Step::ComposeBackdrop { shape: id, read_from, extent: sample, reach, always_cap, acceptable_downscale, tile_mode, write_to: backdrop });
            for tile in paint_tiles {
                steps.push(Step::PaintGather {
                    shape: id,
                    backdrop,
                    clip: page_bounds(node, m),
                    write_to: current(tile),
                });
            }
        }
    }

    if matches!(node.kind, ShapeKind::Path | ShapeKind::Text) {
        for (i, shadow) in node.shadows.iter().filter(|s| !s.inset).enumerate() {
            let sigma = radius_to_sigma(shadow.blur);
            let reach = 3.0 * f64::from(sigma) + f64::from(shadow.spread);
            let (ox, oy) = (shadow.offset.x, shadow.offset.y);
            let pb = page_bounds(node, m);
            let ext = Rect::new(pb.x0 + ox - reach, pb.y0 + oy - reach, pb.x1 + ox + reach, pb.y1 + oy + reach);
            for tile in tiling::tiles_overlapping_page_rect(view, ext) {
                if !visible.contains(&tile) {
                    continue;
                }
                steps.push(Step::PaintPathShadow {
                    shape: id,
                    shadow: i,
                    sigma,
                    extent: ext,
                    clip: tile_page_rect(tile, view),
                    write_to: current(tile),
                });
            }
        }
    }

    if !is_group {
        let own_surface = has_spread_effect(node) || (!node.kind.is_container() && !lp.is_trivial());
        if own_surface {
            let ext = effect_extent(node, m);
            let comp_tiles: Vec<TileKey> = tiling::tiles_overlapping_page_rect(view, ext)
                .into_iter()
                .filter(|t| visible.contains(t))
                .collect();
            if !comp_tiles.is_empty() {
                let rast = SurfaceRef::new(SurfaceRole::RasterEffectOutput(id), None, 0);
                steps.push(Step::Paint { ops: vec![PaintOp::Body(id)], clip: ext, write_to: rast });
                for tile in comp_tiles {
                    steps.push(Step::Composite {
                        from: rast,
                        to: current(tile),
                        paint: lp,
                        rect: ext,
                        erase_after: false,
                    });
                }
            }
        } else {
            let pb = page_bounds(node, m);
            for tile in tiling::tiles_overlapping_page_rect(view, pb) {
                if !visible.contains(&tile) {
                    continue;
                }
                steps.push(Step::Paint {
                    ops: vec![PaintOp::Body(id)],
                    clip: tile_page_rect(tile, view),
                    write_to: current(tile),
                });
            }
        }

        if matches!(node.kind, ShapeKind::Path | ShapeKind::Text) {
            for (i, shadow) in node.shadows.iter().filter(|s| s.inset).enumerate() {
                let sigma = radius_to_sigma(shadow.blur);
                let reach = 3.0 * f64::from(sigma);
                let (ox, oy) = (shadow.offset.x, shadow.offset.y);
                let pb = page_bounds(node, m);
                let ext = Rect::new(
                    pb.x0 + ox.min(0.0) - reach,
                    pb.y0 + oy.min(0.0) - reach,
                    pb.x1 + ox.max(0.0) + reach,
                    pb.y1 + oy.max(0.0) + reach,
                );
                for tile in tiling::tiles_overlapping_page_rect(view, ext) {
                    if !visible.contains(&tile) {
                        continue;
                    }
                    steps.push(Step::PaintInnerShadow {
                        shape: id,
                        shadow: i,
                        sigma,
                        extent: ext,
                        clip: tile_page_rect(tile, view),
                        write_to: current(tile),
                    });
                }
            }
        }
    }

    for (i, &child) in node.children.iter().enumerate() {
        if apply_mask && i == 0 {
            continue;
        }
        visit(scene, child, view, modifiers, visible, scopes, steps, depth + 1, dirty_bbox);
    }

    if apply_mask {
        let mask_id = node.children[0];
        for &(tile, scope) in &layer_tiles {
            let clip = tile_page_rect(tile, view);
            steps.push(Step::Paint { ops: vec![PaintOp::PushMaskLayer], clip, write_to: scope });
            steps.push(Step::Paint { ops: vec![PaintOp::Body(mask_id)], clip, write_to: scope });
            steps.push(Step::Paint { ops: vec![PaintOp::PopLayer], clip, write_to: scope });
        }
    }

    for &(tile, scope) in &layer_tiles {
        steps.push(Step::Paint {
            ops: vec![PaintOp::PopLayer],
            clip: tile_page_rect(tile, view),
            write_to: scope,
        });
    }

    if let Some(saved) = saved {
        for (tile, parent_scope) in saved {
            steps.push(Step::Composite {
                from: SurfaceRef::tile_ref(SurfaceRole::ScopeOf(id), tile),
                to: parent_scope,
                paint: lp,
                rect: tile_page_rect(tile, view),
                erase_after: true,
            });
            scopes.insert(tile, parent_scope);
        }
    }
}

/// Whether anything in `id`'s subtree must be rasterized into its own surface — a spread or gather
/// effect at any depth. Such a shape emits a non-`Paint` step (a `Composite`, `ComposeBackdrop`, …)
/// that breaks the batch, and a backend layer cannot span two scene renders. So a container may only
/// isolate as a cheap in-scene `PushLayer` layer when this is false; otherwise it needs a `ScopeOf`
/// surface. Hidden/unsupported subtrees are skipped, matching `visit`'s own reachability.
fn subtree_needs_surface(scene: &Scene, id: u128) -> bool {
    let Some(node) = scene.get(id) else { return false };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return false;
    }
    has_spread_effect(node)
        || has_gather_effect(node)
        || node.children.iter().any(|&c| subtree_needs_surface(scene, c))
}

/// The page-space bbox covered by `id`'s drawable subtree — the union of every visible descendant's
/// `page_bounds` (a group contributes no body of its own, only its children). Used to bracket an
/// in-scene layer over exactly the tiles its content lands in, so a group emits no empty push/pop
/// layer-paints in tiles it never touches. `None` when the subtree draws nothing.
fn subtree_page_bounds(scene: &Scene, id: u128, modifiers: &Modifiers) -> Option<Rect> {
    let node = scene.get(id)?;
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return None;
    }
    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    let mut acc = (node.kind != ShapeKind::Group).then(|| page_bounds(node, m));
    for &child in &node.children {
        if let Some(cb) = subtree_page_bounds(scene, child, modifiers) {
            acc = Some(acc.map_or(cb, |a| a.union(cb)));
        }
    }
    acc
}

/// The page-space rect a node's paint **and effects** can touch, under an extra `modifier` transform
/// (`Affine::IDENTITY` when committed; the gesture transform during a drag). It is the node's
/// transformed bounds grown by the largest reach of any effect — a drop shadow's offset + blur +
/// spread, a layer blur, a body-only custom shader, or a gather (background blur / glass / backdrop
/// custom). The backend tile cache uses it to dirty exactly the tiles an edit or move affects; it is a
/// deliberate superset, so over-covering only costs a few extra tile rebuilds, never a stale tile.
#[must_use]
pub fn affected_page_rect(node: &Node, modifier: Affine) -> Rect {
    let base = transform_rect(modifier * node.effective_transform(), node.bounds);
    let mut reach = gather_reach(node);
    for s in node.shadows.iter().filter(|s| !s.inset) {
        let off = s.offset.x.abs().max(s.offset.y.abs());
        reach = reach.max(off + f64::from(3.0 * radius_to_sigma(s.blur) + s.spread));
    }
    if let Some(radius) = node.blur {
        reach = reach.max(f64::from(3.0 * radius_to_sigma(radius)));
    }
    if let Some(t) = live_texture(node) {
        reach = reach.max(f64::from(t.radius * crate::effect::TEXTURE_RADIUS_SCALE));
    }
    base.inflate(reach, reach)
}

/// Atomic gather invalidation. A gather (background blur / glass / backdrop shader) samples a page
/// region *larger* than its own footprint, and its output must recompose as a single unit. But
/// incremental dirty tracking only invalidates the tiles a *moved* shape lands in — so when a shape
/// inside a lens's backdrop moves, the lens's tiles that don't overlap that shape keep a stale
/// half-blur and the lens tears along tile seams.
///
/// A gather **depends on** every tile its sample rect covers, and **produces** every tile its output
/// covers. Given the frame's base `dirty` rects, this returns the **output** rect of every gather one
/// of whose dependencies the frame is going to repaint, to a fixpoint — so a lens pulled in can force
/// a lens reading *its* output to re-render in turn. The loop is bounded by the gather count; each
/// gather is promoted at most once.
///
/// Two details are load-bearing:
///
/// * The test is against the **tile-aligned** dirty region, not the raw rects. Rendering is per-tile,
///   so a one-pixel edit repaints its whole tile — and repainting a tile re-runs the gather of every
///   lens overlapping it, for that tile only. A lens straddling a tile boundary would then have its
///   dirty half re-blurred and its clean half left cached, tearing along the boundary. Matching on
///   the raw edit rect misses exactly those lenses: they never overlap the edit itself.
/// * The trigger is the **sample** rect but the promotion is the **output** rect. Only the output has
///   to be repainted — the sample is *read*, and a tile that is not being re-rendered still has its
///   pixels in the tile cache for the sink to read from. Promoting the sample instead would repaint a
///   ring of untouched tiles around every lens for no reason.
///
/// The dependency is each shape's own sample rect, so this is not uniform across gathers: a small lens
/// whose sample stays inside one tile has a purely local dependency and never drags in a neighbour,
/// while a lens spanning tiles ties them together. Both are covered by the tests below.
#[must_use]
pub fn gather_dirty_expansion(scene: &Scene, modifiers: &Modifiers, view: Affine, dirty: &[Rect]) -> Vec<Rect> {
    if dirty.is_empty() {
        return Vec::new();
    }
    let gathers: Vec<(Rect, Rect)> = scene
        .iter_nodes()
        .filter(|n| has_gather_effect(n))
        .map(|n| {
            let m = modifiers.get(&n.id).copied().unwrap_or(Affine::IDENTITY);
            let output = page_bounds(n, m);
            let reach = gather_reach(n);
            (output.inflate(reach, reach), output)
        })
        .collect();
    if gathers.is_empty() {
        return Vec::new();
    }

    let align = |r: &Rect| tiling::tile_aligned_page_rect(view, *r);
    let mut active: Vec<Rect> = dirty.iter().map(align).collect();
    let mut added: Vec<Rect> = Vec::new();
    let mut taken = vec![false; gathers.len()];
    loop {
        let mut changed = false;
        for (i, (sample, output)) in gathers.iter().enumerate() {
            if taken[i] {
                continue;
            }
            if active.iter().any(|r| rects_overlap(r, sample)) {
                taken[i] = true;
                active.push(align(output));
                added.push(*output);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    added
}

fn rects_overlap(a: &Rect, b: &Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/// A shape carries a spread effect if it has a layer blur, **any shadow** (drop or inner), or a custom
/// shader that reads only its own body — all transform the shape's own pixels into an isolated,
/// extrect-sized surface (no backdrop).
///
/// Inner shadows isolate too, even though they spread *inward* and so don't enlarge the extent
/// (`effect_extent` leaves the surface at `page_bounds` for an inner-only shape): the point is that
/// the shadow must be computed **once over the whole shape**, not per tile. Drawn inline in each tile's
/// body paint, the inner-shadow filter runs against that tile's *clipped* body — producing the shadow
/// at every internal tile edge (a grid). An isolated surface holds the whole body, so the filter sees
/// the true silhouette and the shadow lands only on the real edge.
pub(crate) fn has_spread_effect(node: &Node) -> bool {
    node.blur.is_some() || !node.shadows.is_empty() || live_texture(node).is_some()
}

/// The node's texture effect when it actually renders — hidden or zero-radius is no effect at all.
pub(crate) fn live_texture(node: &Node) -> Option<crate::model::Texture> {
    node.texture.filter(|t| !t.hidden && t.radius > 0.0)
}

/// A shape carries a gather effect if it reads the backdrop beneath it — background blur or glass.
/// Distinct from spread: gather forces z-interleaving.
pub(crate) fn has_gather_effect(node: &Node) -> bool {
    node.background_blur.is_some() || node.glass.is_some()
}

/// The gather effect's page-space **reach**: how far past the shape the kernel can pull content — the
/// background blur's `3σ`, or glass's refraction displacement + blur + frost scatter (mirrors
/// render-wasm's `compute_gather_sample_rect`). `page_bounds.inflate(reach, reach)` is the sample
/// rect; the sink also uses `reach` to cap the backdrop's device resolution to the one-tile ring.
fn gather_reach(node: &Node) -> f64 {
    let mut reach = 0.0_f64;
    if let Some(radius) = node.background_blur {
        reach = reach.max(f64::from(3.0 * radius_to_sigma(radius)));
    }
    if let Some(g) = node.glass {
        let displacement = g.thickness * g.refractive_index * 50.0;
        let blur = g.total_blur_sigma() * 3.0;
        let frost = g.frost * 6.0;
        reach = reach.max(f64::from(displacement + blur + frost));
    }
    reach
}

/// Whether a **background blur** derives an automatic `acceptable_downscale` from its band limit.
///
/// The idea was: a Gaussian blur is low-pass, so rendering its backdrop at full resolution only to
/// blur the detail away is waste — render the surface at the blur's band limit (`2 / 3σ`) and upscale.
/// **Measured OFF (Aug 2026):** it is not lossless *and* it is redundant. A radius-20 blur at the
/// 0.25 floor shifts 15.5% of the lens (meanL1 8); at a 0.5 floor, 0.51% but hard at edges (p95 132) —
/// because a single bilinear downscale of the whole surface (backdrop included) resamples the sharp
/// backdrop before the blur can remove it. Crucially, [`crate::gaussian_blur`] ALREADY self-downsamples
/// for large sigma via a *progressive* box-filter pyramid, which is higher quality than this one-step
/// downscale — so the blur pass is already optimal and the policy only adds artifacts. Kept as a
/// documented, one-line-revivable mechanism; the declared `acceptable_downscale` lever stays available
/// for glass/custom, where the surface really is the effect's whole cost.
const BLUR_AUTO_DOWNSCALE: bool = false;
/// A blur never renders below this fraction of device resolution regardless of radius (mirrors
/// [`crate::footprint`]'s `SCALE_FLOOR`), bounding the softening the bilinear upscale reintroduces.
const BLUR_DOWNSCALE_FLOOR: f32 = 0.5;
fn blur_policy_downscale(radius: f32) -> f32 {
    if !BLUR_AUTO_DOWNSCALE {
        return 1.0;
    }
    let reach = 3.0 * radius_to_sigma(radius);
    if reach <= f32::EPSILON {
        return 1.0;
    }
    (2.0 / reach).clamp(BLUR_DOWNSCALE_FLOOR, 1.0)
}

/// The declared quality floor `k ∈ (0, 1]` for a gather shape's effect — the coarsest resolution it
/// tolerates for free (rendered at `k`, upscaled at the stamp). A background blur derives its floor
/// from its own band limit ([`blur_policy_downscale`]); glass and custom shaders each carry a declared
/// `acceptable_downscale`. When a shape stacks several gather effects onto the one backdrop surface,
/// the surface must satisfy the *least* tolerant, so combine by `max` — the default `1.0` leaves any
/// undeclared effect at full resolution.
fn effect_acceptable_downscale(node: &Node) -> f32 {
    let mut k: Option<f32> = None;
    let mut floor = |v: f32| k = Some(k.map_or(v, |cur| cur.max(v)));
    if let Some(radius) = node.background_blur {
        floor(blur_policy_downscale(radius));
    }
    if let Some(g) = node.glass {
        floor(g.acceptable_downscale);
    }
    k.unwrap_or(1.0).clamp(f32::MIN_POSITIVE, 1.0)
}

pub(crate) fn layer_paint(node: &Node) -> LayerPaint {
    LayerPaint { opacity: node.opacity, blend: node.blend }
}

/// The shape's page-space bounds — the bbox of its local `bounds` under `effective_transform`, with an
/// extra gesture `modifier` (`IDENTITY` when committed; the live move/scale during a drag). Tiling
/// must use the *modified* bounds so a dragged shape is scheduled into the tiles it is actually drawn
/// in — [`crate::draw`]'s body paint applies the same `modifier`, so the two would otherwise disagree
/// and the shape would render into its pre-drag tile (teleporting across tile boundaries mid-move).
pub fn page_bounds(node: &Node, modifier: Affine) -> Rect {
    transform_rect(modifier * node.effective_transform(), node.bounds)
}

/// The shape's page-space `extrect`: `page_bounds` grown by every spread effect's reach — a drop
/// shadow's `offset` + blur reach (`3σ`) + `spread`, and a layer blur's reach. This is the size the
/// effect surface must be, so nothing clips at a tile edge.
pub(crate) fn effect_extent(node: &Node, modifier: Affine) -> Rect {
    let base = page_bounds(node, modifier);
    let mut ext = base;
    for s in node.shadows.iter().filter(|s| !s.inset) {
        let reach = f64::from(3.0 * radius_to_sigma(s.blur) + s.spread);
        ext = ext.union(Rect::new(
            base.x0 + s.offset.x - reach,
            base.y0 + s.offset.y - reach,
            base.x1 + s.offset.x + reach,
            base.y1 + s.offset.y + reach,
        ));
    }
    if let Some(radius) = node.blur {
        let reach = f64::from(3.0 * radius_to_sigma(radius));
        ext = ext.union(base.inflate(reach, reach));
    }
    if let Some(t) = live_texture(node) {
        let reach = f64::from(t.radius * crate::effect::TEXTURE_RADIUS_SCALE);
        ext = ext.union(base.inflate(reach, reach));
    }
    ext
}

/// The page-space rect a device tile covers under `view` — the tile's `[origin, origin+512]` device
/// square mapped back through `view⁻¹`.
pub(crate) fn tile_page_rect(tile: TileKey, view: Affine) -> Rect {
    let (ox, oy) = tiling::tile_device_origin(tile, view);
    let size = f64::from(tiling::TILE_SIZE);
    let inv = view.inverse();
    transform_rect(inv, Rect::new(ox, oy, ox + size, oy + size))
}

/// Axis-aligned bbox of `rect`'s four corners under `m`.
fn transform_rect(m: Affine, rect: Rect) -> Rect {
    let corners = [
        m * Point::new(rect.x0, rect.y0),
        m * Point::new(rect.x1, rect.y0),
        m * Point::new(rect.x1, rect.y1),
        m * Point::new(rect.x0, rect.y1),
    ];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in corners {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    Rect::new(x0, y0, x1, y1)
}

#[cfg(test)]
mod gather_dirty_tests {
    use kurbo::{Affine, Rect};

    use crate::host::Modifiers;
    use crate::model::{Node, Scene, ShapeKind, ROOT_ID};

    use super::gather_dirty_expansion;

    fn scene_with(nodes: Vec<Node>) -> Scene {
        let mut s = Scene::new();
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = nodes.iter().map(|n| n.id).collect();
        s.insert(root);
        for n in nodes {
            s.insert(n);
        }
        s
    }

    fn bg_blur(id: u128, r: Rect) -> Node {
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.background_blur = Some(8.0);
        n
    }

    fn plain(id: u128, r: Rect) -> Node {
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n
    }

    #[test]
    fn dirty_rect_in_one_corner_returns_the_whole_lens_output() {
        let lens = Rect::new(100.0, 100.0, 1200.0, 1200.0);
        let scene = scene_with(vec![plain(1, Rect::new(0.0, 0.0, 1300.0, 1300.0)), bg_blur(2, lens)]);
        let dirty = [Rect::new(150.0, 150.0, 220.0, 220.0)];
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty);
        assert_eq!(extra.len(), 1, "the lens is promoted exactly once");
        assert_eq!(extra[0], lens, "the lens repaints whole, and nothing around it is dragged in");
    }

    #[test]
    fn a_lens_sharing_the_edit_s_tile_promotes_even_though_it_misses_the_edit() {
        let straddler = Rect::new(424.0, 244.0, 536.0, 356.0);
        let scene = scene_with(vec![
            plain(1, Rect::new(0.0, 0.0, 1600.0, 1000.0)),
            bg_blur(2, straddler),
        ]);
        let edit = Rect::new(20.0, 20.0, 60.0, 60.0);
        assert!(!super::rects_overlap(&edit, &straddler), "the edit really does miss the lens");
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &[edit]);
        assert_eq!(extra.len(), 1, "sharing the repainted tile is enough to promote the lens");
        assert!(extra[0].contains_rect(straddler), "and it promotes the lens whole");
    }

    #[test]
    fn a_grid_of_touching_gathers_invalidates_as_one_unit() {
        let t = f64::from(crate::tiling::TILE_SIZE);
        let mut nodes = vec![plain(1, Rect::new(0.0, 0.0, 5.0 * t, 5.0 * t))];
        for i in 0..5_u128 {
            for j in 0..5_u128 {
                let (x, y) = (i as f64 * t, j as f64 * t);
                nodes.push(bg_blur(10 + i * 5 + j, Rect::new(x, y, x + t, y + t)));
            }
        }
        let scene = scene_with(nodes);
        let edit = [Rect::new(10.0, 10.0, 30.0, 30.0)];
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &edit);
        assert_eq!(extra.len(), 25, "one edit invalidates every lens in the connected grid");
    }

    #[test]
    fn a_grid_of_tile_local_gathers_does_not_cascade() {
        let t = f64::from(crate::tiling::TILE_SIZE);
        let mut nodes = vec![plain(1, Rect::new(0.0, 0.0, 5.0 * t, 5.0 * t))];
        for i in 0..5_u128 {
            for j in 0..5_u128 {
                let (cx, cy) = ((i as f64 + 0.5) * t, (j as f64 + 0.5) * t);
                nodes.push(bg_blur(10 + i * 5 + j, Rect::new(cx - 50.0, cy - 50.0, cx + 50.0, cy + 50.0)));
            }
        }
        let scene = scene_with(nodes);
        let edit = [Rect::new(10.0, 10.0, 30.0, 30.0)];
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &edit);
        assert_eq!(extra.len(), 1, "only the lens in the edited tile depends on it");
    }

    #[test]
    fn independent_gathers_do_not_chain() {
        let near = Rect::new(100.0, 100.0, 300.0, 300.0);
        let far = Rect::new(2000.0, 2000.0, 2200.0, 2200.0);
        let scene = scene_with(vec![
            plain(1, Rect::new(0.0, 0.0, 2400.0, 2400.0)),
            bg_blur(2, near),
            bg_blur(3, far),
        ]);
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &[Rect::new(120.0, 120.0, 140.0, 140.0)]);
        assert_eq!(extra.len(), 1, "only the lens whose dependency changed is promoted");
        assert!(extra[0].contains_rect(near));
    }

    #[test]
    fn dirty_rect_outside_sample_returns_nothing() {
        let lens = Rect::new(100.0, 100.0, 500.0, 500.0);
        let scene = scene_with(vec![bg_blur(2, lens)]);
        let dirty = [Rect::new(2000.0, 2000.0, 2100.0, 2100.0)];
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty);
        assert!(extra.is_empty(), "a dirty rect that misses the sample rect promotes no lens");
    }

    #[test]
    fn no_gather_no_expansion() {
        let scene = scene_with(vec![plain(1, Rect::new(0.0, 0.0, 500.0, 500.0))]);
        let dirty = [Rect::new(10.0, 10.0, 20.0, 20.0)];
        assert!(gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty).is_empty());
    }

    #[test]
    fn stacked_lenses_promote_transitively() {
        let a = Rect::new(100.0, 100.0, 400.0, 400.0);
        let b = Rect::new(380.0, 380.0, 700.0, 700.0);
        let scene = scene_with(vec![
            plain(1, Rect::new(0.0, 0.0, 800.0, 800.0)),
            bg_blur(2, a),
            bg_blur(3, b),
        ]);
        let dirty = [Rect::new(120.0, 120.0, 160.0, 160.0)];
        let mut extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty);
        extra.sort_by(|p, q| p.x0.partial_cmp(&q.x0).unwrap());
        assert_eq!(extra.len(), 2, "both lenses promote — A directly, B transitively");
        assert!(extra[0].contains_rect(a), "A's promotion covers A's output");
        assert!(extra[1].contains_rect(b), "B's promotion covers B's output");
    }
}
