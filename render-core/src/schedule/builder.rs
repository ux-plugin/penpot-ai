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
use crate::model::{Node, Scene, ShapeKind};
use crate::tiling::{self, TileKey};

use super::step::{LayerPaint, Step};
use super::surface_ref::{SurfaceRef, SurfaceRole};

/// A built schedule. The dependency graph and the backend sink consume `steps` in order.
#[derive(Debug, Default)]
pub struct Schedule {
    pub steps: Vec<Step>,
}

/// Build the schedule for one frame. `view` is the page→device transform (`root * viewport`);
/// `viewport_w/h` are the device viewport size, used to bound the finalize pass to visible tiles.
#[must_use]
pub fn build(scene: &Scene, view: Affine, viewport_w: u32, viewport_h: u32) -> Schedule {
    let visible: HashSet<TileKey> = tiling::visible_tiles(view, viewport_w, viewport_h)
        .into_iter()
        .collect();
    let mut steps = Vec::new();

    // The current scope each visible tile paints into. Starts at the tile's own `TileOutput`; a
    // scope-wrapping container swaps these to its `ScopeOf` for the duration of its subtree.
    let mut scopes: HashMap<TileKey, SurfaceRef> = visible
        .iter()
        .map(|&t| (t, SurfaceRef::tile_ref(SurfaceRole::TileOutput, t)))
        .collect();

    for &id in scene.roots() {
        visit(scene, id, view, &visible, &mut scopes, &mut steps, 0);
    }

    // Finalize: fold each visible tile's accumulated output into the single Target the swapchain
    // presents. `erase_after` releases the tile buffer once folded.
    for &tile in &visible {
        steps.push(Step::Composite {
            from: SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile),
            to: SurfaceRef::target(),
            paint: LayerPaint::opaque(),
            rect: tile_page_rect(tile, view),
            erase_after: true,
        });
    }

    Schedule { steps }
}

const MAX_DEPTH: u32 = 256;

fn visit(
    scene: &Scene,
    id: u128,
    view: Affine,
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

    let is_group = node.kind == ShapeKind::Group;
    let lp = layer_paint(node);
    // A container (frame/group) with a non-trivial layer paint isolates: its body + descendants
    // paint into its own `ScopeOf`, folded to the parent on close. A trivial container (opacity 1,
    // SrcOver) needs no isolation and just recurses into the parent scope.
    let scope_wrap = node.kind.is_container() && !lp.is_trivial();
    let saved: Option<Vec<(TileKey, SurfaceRef)>> = if scope_wrap {
        let saved: Vec<(TileKey, SurfaceRef)> = scopes.iter().map(|(&t, &s)| (t, s)).collect();
        for (&tile, scope) in scopes.iter_mut() {
            *scope = SurfaceRef::tile_ref(SurfaceRole::ScopeOf(id), tile);
        }
        Some(saved)
    } else {
        None
    };

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
        let sample = gather_extent(node);
        let backdrop = SurfaceRef::new(SurfaceRole::Backdrop(id), None, 0);
        let read_from: Vec<SurfaceRef> = tiling::tiles_overlapping_page_rect(view, sample)
            .into_iter()
            .filter(|t| visible.contains(t))
            .map(current)
            .collect();
        steps.push(Step::ComposeBackdrop { shape: id, read_from, extent: sample, write_to: backdrop });
        for tile in tiling::tiles_overlapping_page_rect(view, page_bounds(node)) {
            if !visible.contains(&tile) {
                continue;
            }
            steps.push(Step::PaintGather {
                shape: id,
                backdrop,
                clip: page_bounds(node),
                write_to: current(tile),
            });
        }
    }

    // Body: everything except a group draws its own paint (a frame contributes its background). It
    // lands in the *current* scope — the parent's, or this container's own `ScopeOf` after the swap.
    // For a gather shape the body (a fill/tint/stroke) paints *over* the blurred backdrop above.
    if !is_group {
        if has_spread_effect(node) {
            // Paint the whole body once into an extrect-sized effect surface, then composite it into
            // every tile the extrect overlaps — at this shape's z-position in the walk.
            let ext = effect_extent(node);
            let rast = SurfaceRef::new(SurfaceRole::RasterEffectOutput(id), None, 0);
            steps.push(Step::Paint { shape: id, clip: ext, write_to: rast });
            for tile in tiling::tiles_overlapping_page_rect(view, ext) {
                if !visible.contains(&tile) {
                    continue;
                }
                steps.push(Step::Composite {
                    from: rast,
                    to: current(tile),
                    paint: lp,
                    rect: ext,
                    erase_after: false,
                });
            }
        } else {
            // Plain body: paint directly into each overlapped tile's current scope.
            let pb = page_bounds(node);
            for tile in tiling::tiles_overlapping_page_rect(view, pb) {
                if !visible.contains(&tile) {
                    continue;
                }
                steps.push(Step::Paint {
                    shape: id,
                    clip: tile_page_rect(tile, view),
                    write_to: current(tile),
                });
            }
        }
    }

    for &child in &node.children {
        visit(scene, child, view, visible, scopes, steps, depth + 1);
    }

    // Close the scope: fold this container's `ScopeOf` into the saved parent scope, per tile, at the
    // container's opacity/blend. Restore the parent scopes. The sink no-ops any tile whose `ScopeOf`
    // was never painted (the container had no content there), so emitting per visible tile is safe.
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

/// A shape carries a spread effect if it has a layer blur or any drop (non-inset) shadow. Inner
/// shadows spread inward (they ride the body's own paint) so they do not enlarge the surface.
fn has_spread_effect(node: &Node) -> bool {
    node.blur.is_some() || node.shadows.iter().any(|s| !s.inset)
}

/// A shape carries a gather effect if it reads the backdrop beneath it — currently just background
/// blur. (Glass/refraction will join here.) Distinct from spread: gather forces z-order interleaving.
fn has_gather_effect(node: &Node) -> bool {
    node.background_blur.is_some()
}

/// The gather's page-space **sample rect**: `page_bounds` grown by the background-blur reach (`3σ`)
/// on every side, so the fused backdrop covers everything the blur kernel can pull in at the edges.
fn gather_extent(node: &Node) -> Rect {
    let mut reach = 0.0_f64;
    if let Some(radius) = node.background_blur {
        reach = reach.max(f64::from(3.0 * radius_to_sigma(radius)));
    }
    page_bounds(node).inflate(reach, reach)
}

fn layer_paint(node: &Node) -> LayerPaint {
    LayerPaint { opacity: node.opacity, blend: node.blend }
}

/// The shape's page-space bounds — the bbox of its local `bounds` under `effective_transform`.
fn page_bounds(node: &Node) -> Rect {
    transform_rect(node.effective_transform(), node.bounds)
}

/// The shape's page-space `extrect`: `page_bounds` grown by every spread effect's reach — a drop
/// shadow's `offset` + blur reach (`3σ`) + `spread`, and a layer blur's reach. This is the size the
/// effect surface must be, so nothing clips at a tile edge.
fn effect_extent(node: &Node) -> Rect {
    let base = page_bounds(node);
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
