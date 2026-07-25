//! Backend-neutral scene model — the handoff representation a non-Skia backend (e.g. Vello)
//! renders from.
//!
//! Approach B (see docs/vello-backend-plan.md): render-wasm keeps Skia internally and
//! *converts* its shapes into this model at the handoff boundary, rather than swapping Skia
//! types throughout the engine. This module therefore stays free of Skia (and of render-wasm's
//! own types) so it also compiles for a Vello/wasm-bindgen module.
//!
//! Per D12 the geometry and paint atoms come from kurbo and peniko rather than being written
//! here: `kurbo::Rect`/`Affine`/`BezPath` for geometry, `peniko::Brush` for paint. That is why
//! this file is short — what remains is only the part that is genuinely Penpot's, namely node
//! identity, the geometry family, and the draw list.

use kurbo::{Affine, BezPath, Rect};
use peniko::Brush;

/// A stroke: how to expand the outline, and what to paint it with.
///
/// `kurbo::Stroke` already carries width, join, caps, miter limit, dash pattern and dash
/// offset, so there is nothing to hand-write here (D12). What it does *not* carry is
/// Penpot's `StrokeKind` (inner/outer/center) — that is an offsetting decision, not a
/// stroke-style one, and is applied to the path before it reaches this model.
#[derive(Clone, Debug)]
pub struct Stroke {
    pub style: kurbo::Stroke,
    pub brush: Brush,
}

/// The geometry family of a node. `Frame`, `Text`, … follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ShapeKind {
    Rect,
    Circle,
    /// A vector path; the geometry lives in [`Node::path`].
    Path,
}

/// A single renderable node in neutral form.
#[derive(Clone, Debug)]
pub struct Node {
    /// Stable id (render-wasm packs its UUID as a u128).
    pub id: u128,
    pub kind: ShapeKind,
    /// Local geometry rectangle (render-wasm's `selrect`); for a path it is the bbox.
    pub bounds: Rect,
    /// Vector geometry in the node's local space, present when `kind == ShapeKind::Path`.
    pub path: Option<BezPath>,
    /// World transform.
    pub transform: Affine,
    /// Paints, back to front. `peniko::Brush` already covers solid, gradient and image, so
    /// gradients need no new type here — only a converter in `model_export`.
    pub fills: Vec<Brush>,
    /// Strokes, back to front, painted over the fills.
    pub strokes: Vec<Stroke>,
    pub opacity: f32,
    pub hidden: bool,
}

/// A flat scene. Hierarchy/clipping is added later; a flat draw list is enough for the
/// first backend slice.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub nodes: Vec<Node>,
}

impl Scene {
    #[inline]
    pub fn new() -> Self {
        Self { nodes: Vec::new() }
    }

    #[inline]
    pub fn push(&mut self, node: Node) {
        self.nodes.push(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::{PathEl, Point};
    use peniko::Color;

    #[test]
    fn builds_a_minimal_scene() {
        let mut scene = Scene::new();
        scene.push(Node {
            id: 42,
            kind: ShapeKind::Rect,
            bounds: Rect::new(0.0, 0.0, 100.0, 50.0),
            path: None,
            transform: Affine::IDENTITY,
            fills: vec![Brush::Solid(Color::from_rgba8(255, 0, 0, 255))],
            strokes: vec![],
            opacity: 1.0,
            hidden: false,
        });
        assert_eq!(scene.nodes.len(), 1);
        assert_eq!(
            scene.nodes[0].fills[0],
            Brush::Solid(Color::from_rgba8(255, 0, 0, 255))
        );
        assert_eq!(scene.nodes[0].bounds.width(), 100.0);
    }

    #[test]
    fn builds_a_path_node() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((10.0, 0.0));
        path.curve_to((11.0, 1.0), (12.0, 2.0), (10.0, 10.0));
        path.close_path();

        let node = Node {
            id: 7,
            kind: ShapeKind::Path,
            bounds: Rect::new(0.0, 0.0, 12.0, 10.0),
            path: Some(path),
            transform: Affine::IDENTITY,
            fills: vec![],
            strokes: vec![],
            opacity: 1.0,
            hidden: false,
        };
        assert_eq!(node.kind, ShapeKind::Path);

        let els = node.path.as_ref().unwrap().elements();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[3], PathEl::ClosePath);
    }

    /// kurbo is f64 where render-wasm's Skia geometry is f32, so widening is exact and the
    /// neutral model can represent everything the Skia side holds.
    #[test]
    fn f32_geometry_widens_exactly() {
        let x: f32 = 0.1;
        let r = Rect::new(x as f64, 0.0, 1.0, 1.0);
        assert_eq!(r.x0 as f32, x);
    }
}
