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

/// A built schedule. The dependency graph and the backend sink consume `steps` in order.
#[derive(Debug, Default)]
pub struct Schedule {
    pub steps: Vec<Step>,
    /// The gather-collapse analysis for this frame — which gathers the sink can defer into one batched
    /// pass. Derived from the pre-coalesce steps; empty when the frame has no gather effects.
    pub gather_plan: super::gather_plan::GatherPlan,
}

/// Build the schedule for one frame. `view` is the page→device transform (`root * viewport`);
/// `viewport_w/h` are the device viewport size, used to bound the finalize pass to visible tiles.
#[must_use]
pub fn build(scene: &Scene, view: Affine, viewport_w: u32, viewport_h: u32) -> Schedule {
    let visible: HashSet<TileKey> = tiling::visible_tiles(view, viewport_w, viewport_h)
        .into_iter()
        .collect();
    // No gesture in flight (the whole-frame convenience form): commit-geometry tiling.
    build_visible(scene, view, &Modifiers::new(), &visible)
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
) -> Schedule {
    let mut steps = Vec::new();

    // The current scope each visible tile paints into. Starts at the tile's own `TileOutput`; a
    // scope-wrapping container swaps these to its `ScopeOf` for the duration of its subtree.
    let mut scopes: HashMap<TileKey, SurfaceRef> = visible
        .iter()
        .map(|&t| (t, SurfaceRef::tile_ref(SurfaceRole::TileOutput, t)))
        .collect();

    for &id in scene.roots() {
        visit(scene, id, view, modifiers, visible, &mut scopes, &mut steps, 0);
    }

    // Finalize: fold each target tile's accumulated output into the single Target the swapchain
    // presents. `erase_after: false` — with the tile cache the `TileOutput` buffer is retained for
    // reuse next frame; the sink owns its lifetime (LRU eviction), not this fold.
    for &tile in visible {
        steps.push(Step::Composite {
            from: SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile),
            to: SurfaceRef::target(),
            paint: LayerPaint::opaque(),
            rect: tile_page_rect(tile, view),
            erase_after: false,
        });
    }

    // Analyse gathers on the raw steps (one Body per Paint — coverage is unambiguous), then coalesce.
    // The gathers the sink will defer are passed in: they do not touch their tiles during the walk, so
    // they must not split those tiles' paint runs.
    let gather_plan = super::gather_plan::analyze_gathers(scene, modifiers, &steps);
    let deferred: HashSet<u128> = gather_plan
        .batched_groups()
        .into_iter()
        .flatten()
        .map(|gi| gather_plan.gathers[gi].shape)
        .collect();
    Schedule { steps: coalesce(steps, &deferred), gather_plan }
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
    // Surface → index in `out` of a still-open batched `Paint` we may append to.
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
            // A `Paint` writes only its own surface, so it never closes another surface's batch —
            // just open/extend its own (above) or pass an isolated effect paint through.
            out.push(step);
            continue;
        }
        // A gather bound for the end-of-frame batch is the one exception: it observes the tile only
        // after every paint has landed, and the deferral rule guarantees nothing is drawn over its
        // output, so the run of shapes it sits between still merges into one rasterize.
        let deferred_gather = matches!(
            &step,
            Step::ComposeBackdrop { shape, .. } | Step::PaintGather { shape, .. } if deferred.contains(shape)
        );
        // Any other non-`Paint` step closes the batch of every surface it touches, so nothing merges
        // past a composite/gather/fold that must observe the tile mid-way.
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
) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        // Skip the node and its subtree, matching draw_node's reachability.
        return;
    }
    // The node's live gesture transform (identity when committed). Every tile-coverage computation
    // below uses it, so the shape is scheduled into the tiles the body paint (which applies the same
    // modifier) actually draws into.
    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);

    let is_group = node.kind == ShapeKind::Group;
    let lp = layer_paint(node);
    // A container (frame/group) with a non-trivial layer paint isolates so overlapping children don't
    // double-composite and the group opacity/blend is preserved. There are two ways to isolate:
    //
    // - **In-scene layer** (`PushLayer`/`PopLayer` ops): the backend composites the group as a layer
    //   inside the *same* pass, so the whole subtree stays in one submission. This is the cheap path
    //   and the default — but a layer cannot span two scene renders, so it is only valid when nothing
    //   in the subtree forces a raster surface (a spread/gather effect, which would break the batch).
    // - **`ScopeOf` surface**: the subtree paints into its own buffer, folded to the parent on close.
    //   Required when the subtree *does* contain such an effect.
    //
    // A trivial container (opacity 1, SrcOver) needs neither and just recurses into the parent scope.
    let scope_wrap = node.kind.is_container() && !lp.is_trivial();
    let use_layer = scope_wrap && !subtree_needs_surface(scene, id);
    let saved: Option<Vec<(TileKey, SurfaceRef)>> = if scope_wrap && !use_layer {
        let saved: Vec<(TileKey, SurfaceRef)> = scopes.iter().map(|(&t, &s)| (t, s)).collect();
        for (&tile, scope) in scopes.iter_mut() {
            *scope = SurfaceRef::tile_ref(SurfaceRole::ScopeOf(id), tile);
        }
        Some(saved)
    } else {
        None
    };
    // The tiles an in-scene layer brackets: only those its subtree actually covers, so a group does
    // not spawn empty push/pop layer-paints (each its own scene render) in tiles it never touches.
    // Same set at open and close, since a layer group never swaps `scopes`.
    let layer_tiles: Vec<(TileKey, SurfaceRef)> = if use_layer {
        let cover: HashSet<TileKey> = subtree_page_bounds(scene, id, modifiers)
            .map(|b| tiling::tiles_overlapping_page_rect(view, b).into_iter().collect())
            .unwrap_or_default();
        scopes.iter().filter(|(t, _)| cover.contains(t)).map(|(&t, &s)| (t, s)).collect()
    } else {
        Vec::new()
    };
    // Open the in-scene layer: one `PushLayer` op into each covered tile's current scope, before the
    // body and children paint. It merges into that tile's open batch (a `Paint` op never closes a
    // batch), so the group opens without spilling to a surface or a new submission.
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

    // Gather (background blur / glass): reads the backdrop **beneath** the shape, so it must run at
    // this z-position — after everything below has painted, before the shape's own body and before
    // any higher shape. `ComposeBackdrop` fuses the current scope's content over the sample rect
    // into one `Backdrop` surface (sized to the sample rect, not a tile — that is what stops the
    // blur cropping and fading on zoom-in); `PaintGather` blurs it and paints it through the shape's
    // silhouette into each tile the shape covers.
    if has_gather_effect(node) {
        // The gather is only needed if the shape covers a target tile. Culling here matters for the
        // tile cache: with a small dirty set (a pan), a gather whose shape is entirely in reused tiles
        // must emit nothing — otherwise its (expensive, z-serial) backdrop compose runs every frame.
        let paint_tiles: Vec<TileKey> = tiling::tiles_overlapping_page_rect(view, page_bounds(node, m))
            .into_iter()
            .filter(|t| visible.contains(t))
            .collect();
        if !paint_tiles.is_empty() {
            let reach = gather_reach(node);
            let sample = page_bounds(node, m).inflate(reach, reach);
            let backdrop = SurfaceRef::new(SurfaceRole::Backdrop(id), None, 0);
            // Deliberately NOT filtered to the frame's tile set. A gather's sample rect routinely
            // reaches into tiles this frame is not re-rendering, and those tiles' pixels are still
            // valid in the tile cache — the sink resolves a source with no live surface from there.
            // Filtering here would punch a hole in the backdrop wherever the sample crosses into a
            // clean tile, and the only way to avoid the hole would be to repaint that tile purely to
            // have something to read.
            let read_from: Vec<SurfaceRef> = tiling::tiles_overlapping_page_rect(view, sample)
                .into_iter()
                .map(current)
                .collect();
            // A backdrop-reading custom shader is opaque, so bound its surface unconditionally; a
            // reasoned gather (background blur, glass) does not need the cap.
            let always_cap = custom_reads_backdrop(node);
            steps.push(Step::ComposeBackdrop { shape: id, read_from, extent: sample, reach, always_cap, write_to: backdrop });
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

    // Body: everything except a group draws its own paint (a frame contributes its background). It
    // lands in the *current* scope — the parent's, or this container's own `ScopeOf` after the swap.
    // For a gather shape the body (a fill/tint/stroke) paints *over* the blurred backdrop above.
    if !is_group {
        if has_spread_effect(node) {
            // Paint the whole body once into an extrect-sized effect surface, then composite it into
            // every tile the extrect overlaps — at this shape's z-position in the walk. Only emit the
            // (expensive) effect-surface paint when a target tile actually needs it: the paint is
            // per-shape, not per-tile, so without this gate a pan would re-blur every off-screen /
            // reused-tile shape every frame — the tile cache's whole cost.
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
            // Plain body: paint directly into each overlapped tile's current scope.
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
    }

    for &child in &node.children {
        visit(scene, child, view, modifiers, visible, scopes, steps, depth + 1);
    }

    // Close the in-scene layer: one `PopLayer` op per bracketed tile, matching the `PushLayer`s, so
    // every descendant painted since the push composites as the group and later siblings paint
    // outside it.
    for &(tile, scope) in &layer_tiles {
        steps.push(Step::Paint {
            ops: vec![PaintOp::PopLayer],
            clip: tile_page_rect(tile, view),
            write_to: scope,
        });
    }

    // Close the scope surface: fold this container's `ScopeOf` into the saved parent scope, per tile,
    // at the container's opacity/blend. Restore the parent scopes. The sink no-ops any tile whose
    // `ScopeOf` was never painted (the container had no content there), so emitting per tile is safe.
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

/// Whether the shape's custom shader reads the backdrop beneath it (→ a gather) rather than only its
/// own body (→ a spread). Absent shader → false. Opaque shaders declare `reads_backdrop: true`, so
/// they land here as gathers — the safe worst case; a shader declared body-only takes the cheap path.
fn custom_reads_backdrop(node: &Node) -> bool {
    node.gather_shader().is_some()
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
    // A group has no body; a frame/leaf contributes its own page bounds.
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
    reach = reach.max(f64::from(node.max_spread_reach()));
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
    // (what it depends on, what it produces) for every gather in the scene.
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

    // `active` holds what the frame will actually repaint — whole tiles — so a lens is promoted when
    // a *repainted tile* touches its sample, not merely when the edit itself does.
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
                // Repainting the output repaints its whole tiles, and that is what the next round has
                // to test against — a lens reading any of those tiles is now stale too.
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
fn has_spread_effect(node: &Node) -> bool {
    node.blur.is_some() || !node.shadows.is_empty() || node.has_spread_shader()
}

/// A shape carries a gather effect if it reads the backdrop beneath it — background blur, glass, or a
/// custom shader declared to sample the backdrop. Distinct from spread: gather forces z-interleaving.
fn has_gather_effect(node: &Node) -> bool {
    node.background_blur.is_some() || node.glass.is_some() || custom_reads_backdrop(node)
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
    if let Some(c) = node.gather_shader() {
        // Only a backdrop-reading custom shader contributes to the *gather* sample rect; body-only
        // spread shaders size their own surface instead (see `effect_extent`).
        reach = reach.max(f64::from(c.reach));
    }
    reach
}

fn layer_paint(node: &Node) -> LayerPaint {
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
fn effect_extent(node: &Node, modifier: Affine) -> Rect {
    let base = page_bounds(node, modifier);
    let mut ext = base;
    for s in node.shadows.iter().filter(|s| !s.inset) {
        // The silhouette, offset by the shadow, then grown by blur reach (3σ) + spread on every side.
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
    // Body-only spread shaders sample up to their declared reach past the silhouette; the chain shares
    // one surface, so size it to the largest reach among them.
    let spread_reach = f64::from(node.max_spread_reach());
    if spread_reach > 0.0 {
        ext = ext.union(base.inflate(spread_reach, spread_reach));
    }
    ext
}

/// The page-space rect a device tile covers under `view` — the tile's `[origin, origin+512]` device
/// square mapped back through `view⁻¹`.
fn tile_page_rect(tile: TileKey, view: Affine) -> Rect {
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
        // A lens spanning several tiles (0..1200 crosses 512-tile boundaries twice).
        let lens = Rect::new(100.0, 100.0, 1200.0, 1200.0);
        let scene = scene_with(vec![plain(1, Rect::new(0.0, 0.0, 1300.0, 1300.0)), bg_blur(2, lens)]);
        // A shape moved inside the top-left corner of the lens' backdrop — one tile's worth.
        let dirty = [Rect::new(150.0, 150.0, 220.0, 220.0)];
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty);
        assert_eq!(extra.len(), 1, "the lens is promoted exactly once");
        // The whole output, so the lens repaints as one unit and cannot tear on a tile seam — but not
        // a pixel more: the sample's outer ring is only ever *read*, and the sink reads it from cache.
        assert_eq!(extra[0], lens, "the lens repaints whole, and nothing around it is dragged in");
    }

    #[test]
    fn a_lens_sharing_the_edit_s_tile_promotes_even_though_it_misses_the_edit() {
        // The regression the bench showed: one small shape moves near the origin, and a lens far from
        // it — but straddling that tile's boundary — re-blurred only its half inside the repainted
        // tile, tearing along x = TILE_SIZE. The edit rect misses the lens' sample entirely; the
        // *tile* the edit repaints does not.
        let straddler = Rect::new(424.0, 244.0, 536.0, 356.0); // crosses the 512 tile boundary
        let scene = scene_with(vec![
            plain(1, Rect::new(0.0, 0.0, 1600.0, 1000.0)),
            bg_blur(2, straddler),
        ]);
        let edit = Rect::new(20.0, 20.0, 60.0, 60.0); // top-left, nowhere near the lens
        assert!(!super::rects_overlap(&edit, &straddler), "the edit really does miss the lens");
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &[edit]);
        assert_eq!(extra.len(), 1, "sharing the repainted tile is enough to promote the lens");
        assert!(extra[0].contains_rect(straddler), "and it promotes the lens whole");
    }

    #[test]
    fn a_grid_of_touching_gathers_invalidates_as_one_unit() {
        // A gather depends on every tile its sample rect covers, so invalidating any of those tiles
        // invalidates the gather — and the gather's own sample then invalidates its neighbours' in
        // turn. Lay one lens over each tile of a 5x5 grid: each sample spills `reach` into the four
        // tiles around it, so the whole grid is one dependency component and a single edit anywhere
        // must promote all 25. That transitive closure is the point of the fixpoint; the cost of it
        // is real and is why an edit near a lens repaints far more than the shape it touched.
        let t = f64::from(crate::tiling::TILE_SIZE);
        let mut nodes = vec![plain(1, Rect::new(0.0, 0.0, 5.0 * t, 5.0 * t))];
        for i in 0..5_u128 {
            for j in 0..5_u128 {
                let (x, y) = (i as f64 * t, j as f64 * t);
                nodes.push(bg_blur(10 + i * 5 + j, Rect::new(x, y, x + t, y + t)));
            }
        }
        let scene = scene_with(nodes);
        let edit = [Rect::new(10.0, 10.0, 30.0, 30.0)]; // one small shape in the very first tile
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &edit);
        assert_eq!(extra.len(), 25, "one edit invalidates every lens in the connected grid");
    }

    #[test]
    fn a_grid_of_tile_local_gathers_does_not_cascade() {
        // The same 5x5 grid, but each lens is small and sits well inside its tile, so its sample rect
        // never leaves that tile. Gathers are not uniform: the dependency is each shape's OWN sample
        // rect, which is its output grown by its OWN reach. A lens that reads nothing outside its tile
        // has a purely local dependency and must not drag its neighbours in — otherwise the rule would
        // collapse to "any edit repaints every lens", which is what a per-effect-class rule would do.
        let t = f64::from(crate::tiling::TILE_SIZE);
        let mut nodes = vec![plain(1, Rect::new(0.0, 0.0, 5.0 * t, 5.0 * t))];
        for i in 0..5_u128 {
            for j in 0..5_u128 {
                let (cx, cy) = ((i as f64 + 0.5) * t, (j as f64 + 0.5) * t);
                nodes.push(bg_blur(10 + i * 5 + j, Rect::new(cx - 50.0, cy - 50.0, cx + 50.0, cy + 50.0)));
            }
        }
        let scene = scene_with(nodes);
        let edit = [Rect::new(10.0, 10.0, 30.0, 30.0)]; // first tile again
        let extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &edit);
        assert_eq!(extra.len(), 1, "only the lens in the edited tile depends on it");
    }

    #[test]
    fn independent_gathers_do_not_chain() {
        // The cascade is through *overlap*, not through being a gather: two lenses far enough apart
        // that neither sample reaches the other stay independent, and an edit in one leaves the other
        // alone. Without this the rule would degenerate into "any edit repaints every lens".
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
        // Far outside the lens output + its ~12px blur reach.
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
        // Inner lens A; outer lens B sits far away but its sample overlaps A's output. A dirty rect in
        // A's backdrop must promote A, and A's output must then promote B.
        let a = Rect::new(100.0, 100.0, 400.0, 400.0);
        let b = Rect::new(380.0, 380.0, 700.0, 700.0); // sample overlaps A's output corner
        let scene = scene_with(vec![
            plain(1, Rect::new(0.0, 0.0, 800.0, 800.0)),
            bg_blur(2, a),
            bg_blur(3, b),
        ]);
        let dirty = [Rect::new(120.0, 120.0, 160.0, 160.0)]; // inside A only
        let mut extra = gather_dirty_expansion(&scene, &Modifiers::new(), Affine::IDENTITY, &dirty);
        extra.sort_by(|p, q| p.x0.partial_cmp(&q.x0).unwrap());
        assert_eq!(extra.len(), 2, "both lenses promote — A directly, B transitively");
        // Each promotes its sample rect, which contains its output.
        assert!(extra[0].contains_rect(a), "A's promotion covers A's output");
        assert!(extra[1].contains_rect(b), "B's promotion covers B's output");
    }
}
