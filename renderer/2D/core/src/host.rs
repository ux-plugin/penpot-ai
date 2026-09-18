//! The backend-neutral **host scene state** — the document a renderer module accumulates from the
//! host's ABI calls, independent of any backend.
//!
//! A renderer module (Vello today, a second Vello backend tomorrow) receives the scene one property
//! at a time over a C ABI and builds it up here: the shape tree ([`SceneState::scene`]), the shape
//! the setters currently target ([`SceneState::current`]), the pan/zoom/surface metrics
//! ([`Viewport`]), the gesture-time modifiers, and the per-mutation dirty region the tile cache
//! drains. None of that touches a specific renderer — it is pure [`crate::model`] state plus the
//! dirty-tracking policy — so it lives in render-core and every backend's FFI shell wraps one static
//! instance of it, rather than re-implementing the state machine.
//!
//! What stays in the backend's ABI shell: the `static` that holds the instance, the `#[no_mangle]`
//! exports that drive it, the shared-heap transport, and any renderer-typed staging (image/font
//! upload queues). This is only the state *type*.

use std::collections::HashMap;

use kurbo::{Affine, Rect};
use peniko::Color;

/// Monotonic scene-mutation epoch: bumped by every structural or per-shape edit (node upsert,
/// children replacement, every `with_current` setter, scene clear/install). Frame-level caches —
/// the whole-viewport gathers list, the per-node outline cache — validate against it: an unchanged
/// epoch across frames (idle, pan, zoom, modifier-driven drags) means the cached derivation is
/// still exact. Deliberately coarse: any edit invalidates everything, trading precision for a
/// trivially correct contract.
static SCENE_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Record one scene mutation (see [`scene_epoch`]).
pub fn bump_scene_epoch() {
    SCENE_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// The current scene-mutation epoch, for cache validation.
#[must_use]
pub fn scene_epoch() -> u64 {
    SCENE_EPOCH.load(std::sync::atomic::Ordering::Relaxed)
}

use crate::model::{Node, Scene, ShapeKind};
use crate::schedule::affected_page_rect;

/// Page-space gesture transforms by shape id. Empty except during a drag.
pub type Modifiers = HashMap<u128, Affine>;

/// Beyond this many pending dirty rects, [`SceneState::mark_dirty`] collapses to a full rebuild — a
/// memory + cost cap for huge edit batches and the scheduler-off case where nothing drains them.
const MAX_DIRTY_RECTS: usize = 512;

/// The accumulated document + view a renderer module builds from the host's ABI calls.
///
/// There is no insertion order here: paint order comes from the tree, walked from
/// [`crate::model::ROOT_ID`] through each node's `children`. The host sends nodes in no guaranteed
/// order — a child can arrive before the parent that lists it. Fields are public: this is a plain
/// state record the backend's ABI shell reads and writes directly.
#[derive(Default)]
pub struct SceneState {
    /// The shape tree.
    pub scene: Scene,
    /// The shape subsequent property setters apply to.
    pub current: Option<u128>,
    /// Pan, zoom and surface metrics.
    pub viewport: Viewport,
    /// Set by `render`/`render_sync`, cleared when the host's frame loop picks it up.
    pub needs_frame: bool,
    /// Gesture-time transforms, in page space, keyed by shape.
    ///
    /// Deliberately beside the scene rather than on `Node`: these are *preview* state, alive only for
    /// the duration of a drag, and the document is what `Scene` means. render-wasm draws the same line
    /// — its modifiers live in the shapes pool and are applied on `get`, not written into the shape.
    pub modifiers: Modifiers,
    /// Page-space rects touched since the last frame drained them — one (or two, for a move) per
    /// mutation. The tile cache converts these to tiles and invalidates *only* those, so an edit
    /// rebuilds the tiles it actually changed, not the screen. Pan/zoom don't touch this (they're
    /// viewport, and a tile's pixels are pan-invariant); the cache handles scale separately.
    pub dirty_rects: Vec<Rect>,
    /// Force a full rebuild next frame, for wholesale changes where per-rect tracking isn't worth it
    /// (document reset, structural child/parent edits).
    pub dirty_all: bool,
    /// Spatial index over drawable **leaves** (childless nodes), keyed on committed page-space bounds —
    /// a replica of the selection worker's quadtree. `None` means "invalidated, rebuild on next query"
    /// (set by any structural, tree-changing edit); a geometry/effect edit updates it in place. The
    /// builder queries it to render only the shapes near a dirty region instead of walking every shape.
    /// Containers are deliberately *not* indexed — the builder always descends them — so a leaf's
    /// absence from a query means "cannot touch this region, safe to skip".
    pub quadtree: Option<crate::quadtree::Quadtree>,
    /// Paint-order rank of each indexed leaf (its position in the depth-first walk), assigned when the
    /// index is (re)built. The builder sorts a query's candidates by this to emit them in z-order
    /// without an O(n) scan of the tree. Stable across moves (a move doesn't reorder paint).
    pub seq_of: HashMap<u128, u32>,
    /// Whether the drawable tree is flat — every drawable child of the root is a leaf, no
    /// scope-bearing container. Only then can the builder emit query candidates directly (there is no
    /// ancestor clip/opacity context to reconstruct); nested scenes fall back to the pruned walk.
    /// Recomputed with the index.
    pub qt_flat: bool,
    /// Whether a fill may have changed since the last diamond-gradient bake scan. Diamonds are a fill
    /// type, so only a `set_shape_fills`/`clear_shape_fills` can introduce or change one — never a move
    /// or an idle frame. `stage_diamond_bakes` skips its O(n) tree scan while this is false, which is
    /// almost always. Starts false (a fresh scene has no fills yet); set on any fill edit.
    pub diamonds_dirty: bool,
}

impl SceneState {
    /// The page-space rect a shape currently occupies — its bounds under its gesture modifier, grown
    /// by any effect reach. `None` if the shape is gone. The tile cache dirties the tiles this covers.
    #[must_use]
    pub fn shape_rect(&self, id: u128) -> Option<Rect> {
        let node = self.scene.get(id)?;
        let modifier = self.modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
        Some(affected_page_rect(node, modifier))
    }

    /// Record a dirty page-rect for the tile cache. Past [`MAX_DIRTY_RECTS`] pending rects (a huge
    /// edit batch, or edits made while the scheduler is off so nothing drains them) it collapses to
    /// `dirty_all` — bounding both the accumulator's memory and the per-frame tile-invalidation cost.
    pub fn mark_dirty(&mut self, rect: Rect) {
        if self.dirty_all {
            return;
        }
        if self.dirty_rects.len() >= MAX_DIRTY_RECTS {
            self.dirty_all = true;
            self.dirty_rects.clear();
        } else {
            self.dirty_rects.push(rect);
        }
    }

    /// Select (creating a fresh `Rect` node if absent) the shape subsequent setters apply to.
    pub fn upsert(&mut self, id: u128) {
        if self.scene.get(id).is_none() {
            self.scene.insert(Node::new(id, ShapeKind::Rect));
            self.dirty_all = true;
            self.invalidate_quadtree();
            bump_scene_epoch();
        }
        self.current = Some(id);
    }

    /// The current shape, mutably, if any.
    pub fn current_mut(&mut self) -> Option<&mut Node> {
        let id = self.current?;
        self.scene.get_mut(id)
    }

    /// Replace the current shape's children.
    ///
    /// render-wasm additionally diffs against the previous list to mark dropped children deleted and
    /// invalidate their tiles. Here a dropped child simply stops being reachable from the root, so it
    /// stops painting; it does linger in the map, which is a leak the backend accepts until it grows a
    /// real node lifecycle.
    pub fn set_children(&mut self, children: Vec<u128>) {
        if let Some(node) = self.current_mut() {
            node.children = children;
        } else {
            return;
        }
        self.dirty_all = true;
        self.invalidate_quadtree();
        bump_scene_epoch();
    }

    /// A leaf's committed page-space footprint (modifier-free), the key the spatial index stores it
    /// under. `None` for a hidden/unsupported node or a container (only childless leaves are indexed).
    #[must_use]
    pub fn leaf_rect(&self, id: u128) -> Option<Rect> {
        let node = self.scene.get(id)?;
        if node.hidden || node.kind == ShapeKind::Unsupported || !node.children.is_empty() {
            return None;
        }
        Some(affected_page_rect(node, Affine::IDENTITY))
    }

    /// Record a leaf's geometry/effect change in the spatial index: remove it at its old footprint,
    /// re-insert at its new one. No-op when the index is invalidated (it rebuilds on the next query).
    /// Call with the committed rects bracketing the edit ([`Self::leaf_rect`] before and after).
    pub fn note_leaf_moved(&mut self, id: u128, before: Option<Rect>, after: Option<Rect>) {
        let Some(qt) = self.quadtree.as_mut() else { return };
        if let Some(b) = before {
            qt.remove(id, b);
        }
        if let Some(a) = after {
            qt.insert(id, a);
        }
    }

    /// Drop the spatial index so the next query rebuilds it. Called on every structural (tree-changing)
    /// edit — add, reparent, reset — since those change which shapes exist and where they sit.
    pub fn invalidate_quadtree(&mut self) {
        self.quadtree = None;
    }

    /// Ensure the spatial index reflects the current scene, rebuilding from scratch when invalidated.
    /// The rebuild is an O(n) walk over drawable leaves — paid only on the first query after a
    /// structural change, not per frame. Root bounds are the union of every leaf footprint.
    pub fn ensure_quadtree(&mut self) {
        if self.quadtree.is_some() {
            return;
        }
        let mut leaves: Vec<(u128, Rect)> = Vec::new();
        collect_leaves(&self.scene, crate::model::ROOT_ID, &mut |id, r| leaves.push((id, r)));
        self.seq_of.clear();
        let mut bounds: Option<Rect> = None;
        for (seq, (id, r)) in leaves.iter().enumerate() {
            self.seq_of.insert(*id, u32::try_from(seq).unwrap_or(u32::MAX));
            bounds = Some(bounds.map_or(*r, |b: Rect| b.union(*r)));
        }
        let root = bounds.unwrap_or(Rect::new(0.0, 0.0, 1.0, 1.0));
        let mut qt = crate::quadtree::Quadtree::new(root);
        for (id, r) in &leaves {
            qt.insert(*id, *r);
        }
        self.quadtree = Some(qt);
        self.qt_flat = self.scene.get(crate::model::ROOT_ID).is_none_or(|root| {
            root.children
                .iter()
                .all(|&c| self.scene.get(c).is_none_or(|n| n.children.is_empty()))
        });
    }

    /// Candidate leaf ids whose footprint may overlap `region` — a superset (a shape sharing a leaf
    /// with the query is returned), so the builder still bounds-tests each. `None` before the index is
    /// built; call [`Self::ensure_quadtree`] first.
    #[must_use]
    pub fn leaf_candidates(&self, region: Rect) -> Option<std::collections::HashSet<u128>> {
        let qt = self.quadtree.as_ref()?;
        let mut out = std::collections::HashSet::new();
        qt.query(region, &mut out);
        Some(out)
    }
}

/// Walk the reachable tree from `id` in paint order, invoking `f` for each drawable **leaf** (a
/// childless, non-hidden, supported node other than the root) with its committed page footprint.
/// Containers recurse but are not themselves reported — the builder always descends them.
fn collect_leaves(scene: &Scene, id: u128, f: &mut impl FnMut(u128, Rect)) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    if node.children.is_empty() {
        if id != crate::model::ROOT_ID {
            f(id, affected_page_rect(node, Affine::IDENTITY));
        }
    } else {
        for &child in &node.children {
            collect_leaves(scene, child, f);
        }
    }
}

/// Pan, zoom and surface metrics — everything needed to place the page on the canvas.
///
/// Mirrors render-wasm's `Viewbox` plus the `dpr` from its render options. `zoom` and `dpr` are
/// separate because they arrive from different entry points and mean different things, even though
/// rendering only ever uses the product.
#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub dpr: f32,
    pub width: i32,
    pub height: i32,
    pub background: Color,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            dpr: 1.0,
            width: 0,
            height: 0,
            background: Color::from_rgba8(0, 0, 0, 0),
        }
    }
}

impl Viewport {
    /// The page-to-canvas matrix: `scale(zoom · dpr) · translate(pan)`.
    ///
    /// render-wasm arrives at the same thing by a different route — its `Viewbox::set_all` stores the
    /// visible page rect as `(-pan_x, -pan_y, width/zoom, height/zoom)` and the canvas is then set up
    /// with `scale(zoom · dpr)` and a translation of `-area.left`. Both put page point
    /// `(-pan_x, -pan_y)` at the canvas origin.
    #[must_use]
    pub fn transform(&self) -> Affine {
        let scale = f64::from(self.zoom * self.dpr);
        Affine::scale(scale) * Affine::translate((f64::from(self.pan_x), f64::from(self.pan_y)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadtree_rebuilds_then_tracks_a_leaf_move_in_place() {
        use crate::model::ROOT_ID;
        let mut s = SceneState::default();
        s.upsert(ROOT_ID);
        for id in 1..=15u128 {
            let i = (id - 1) as f64;
            s.scene.insert(Node::new(id, ShapeKind::Rect));
            let (x, y) = ((i % 5.0) * 5.0, (i / 5.0).floor() * 5.0);
            s.scene.get_mut(id).unwrap().bounds = Rect::new(x, y, x + 3.0, y + 3.0);
        }
        s.current = Some(ROOT_ID);
        s.set_children((1..=15).collect());

        s.ensure_quadtree();
        assert!(s.leaf_candidates(Rect::new(0.0, 0.0, 8.0, 8.0)).unwrap().contains(&1));

        let before = s.leaf_rect(1);
        s.scene.get_mut(1).unwrap().bounds = Rect::new(900.0, 900.0, 903.0, 903.0);
        let after = s.leaf_rect(1);
        s.note_leaf_moved(1, before, after);

        assert!(!s.leaf_candidates(Rect::new(0.0, 0.0, 8.0, 8.0)).unwrap().contains(&1));
        assert!(s.leaf_candidates(Rect::new(895.0, 895.0, 910.0, 910.0)).unwrap().contains(&1));
    }

    #[test]
    fn upsert_creates_then_selects_and_marks_structural_dirty() {
        let mut s = SceneState::default();
        s.upsert(7);
        assert_eq!(s.current, Some(7));
        assert!(s.scene.get(7).is_some());
        assert!(s.dirty_all, "a fresh node is a structural change → full dirty");
    }

    #[test]
    fn mark_dirty_accumulates_then_collapses_past_the_cap() {
        let mut s = SceneState::default();
        for _ in 0..MAX_DIRTY_RECTS {
            s.mark_dirty(Rect::new(0.0, 0.0, 1.0, 1.0));
        }
        assert_eq!(s.dirty_rects.len(), MAX_DIRTY_RECTS);
        assert!(!s.dirty_all);
        s.mark_dirty(Rect::new(0.0, 0.0, 1.0, 1.0));
        assert!(s.dirty_all && s.dirty_rects.is_empty(), "over the cap → collapse to full dirty");
    }

    #[test]
    fn viewport_transform_puts_pan_origin_at_the_canvas_origin() {
        let vp = Viewport { zoom: 2.0, dpr: 1.0, pan_x: -10.0, pan_y: -20.0, ..Viewport::default() };
        let p = vp.transform() * kurbo::Point::new(10.0, 20.0);
        assert!(p.x.abs() < 1e-9 && p.y.abs() < 1e-9);
    }
}
