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
            // A fresh node has no geometry yet (its property setters will dirty its area), but it is
            // usually linked in via `set_children` next — a structural change we treat as full-dirty.
            self.dirty_all = true;
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
        // A structural change (what's drawn where in the container) is coarse and off the pan hot
        // path — a full rebuild is simpler than tracking the subtree's before/after footprint.
        self.dirty_all = true;
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
        s.mark_dirty(Rect::new(0.0, 0.0, 1.0, 1.0)); // one past the cap
        assert!(s.dirty_all && s.dirty_rects.is_empty(), "over the cap → collapse to full dirty");
    }

    #[test]
    fn viewport_transform_puts_pan_origin_at_the_canvas_origin() {
        let vp = Viewport { zoom: 2.0, dpr: 1.0, pan_x: -10.0, pan_y: -20.0, ..Viewport::default() };
        let p = vp.transform() * kurbo::Point::new(10.0, 20.0);
        assert!(p.x.abs() < 1e-9 && p.y.abs() < 1e-9);
    }
}
