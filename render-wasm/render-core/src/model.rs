//! Backend-neutral scene model — the handoff representation a non-Skia backend (e.g. Vello)
//! renders from.
//!
//! Phase 1 / approach B (see docs/vello-backend-plan.md): render-wasm keeps Skia internally
//! and *converts* its shapes into this model at the handoff boundary, rather than swapping
//! Skia types throughout the engine. This module therefore stays free of Skia (and of
//! render-wasm's own types) so it also compiles for a Vello/wasm-bindgen module.
//!
//! It is intentionally minimal to start (solid-filled rects/circles) and grows outward —
//! gradients, strokes, paths, effects, and hierarchy — as the backend needs them.

use crate::geom::{Matrix, Point, Rect};

/// Straight (non-premultiplied) 8-bit RGBA color.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const TRANSPARENT: Color = Color::rgba(0, 0, 0, 0);

    #[inline]
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }
}

/// A paint applied to a shape. Only solid color for now; gradients and images follow.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Fill {
    Solid(Color),
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

/// One command of a vector path, mirroring render-wasm's `Segment` (cubic beziers).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathSeg {
    MoveTo(Point),
    LineTo(Point),
    CubicTo { c1: Point, c2: Point, end: Point },
    Close,
}

/// A vector path as an ordered list of segments, in the node's local space.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Path {
    pub segments: Vec<PathSeg>,
}

impl Path {
    #[inline]
    pub fn new(segments: Vec<PathSeg>) -> Self {
        Self { segments }
    }
}

/// A single renderable node in neutral form.
#[derive(Clone, Debug)]
pub struct Node {
    /// Stable id (render-wasm packs its UUID as a u128).
    pub id: u128,
    pub kind: ShapeKind,
    /// Local geometry rectangle (render-wasm's `selrect`); for a path it is the bbox.
    pub bounds: Rect,
    /// Vector geometry, present when `kind == ShapeKind::Path`.
    pub path: Option<Path>,
    /// World transform.
    pub transform: Matrix,
    pub fills: Vec<Fill>,
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

    #[test]
    fn builds_a_minimal_scene() {
        let mut scene = Scene::new();
        scene.push(Node {
            id: 42,
            kind: ShapeKind::Rect,
            bounds: Rect::from_ltrb(0.0, 0.0, 100.0, 50.0),
            path: None,
            transform: Matrix::identity(),
            fills: vec![Fill::Solid(Color::rgba(255, 0, 0, 255))],
            opacity: 1.0,
            hidden: false,
        });
        assert_eq!(scene.nodes.len(), 1);
        assert_eq!(scene.nodes[0].fills[0], Fill::Solid(Color::rgba(255, 0, 0, 255)));
        assert_eq!(scene.nodes[0].bounds.width(), 100.0);
    }

    #[test]
    fn builds_a_path_node() {
        let path = Path::new(vec![
            PathSeg::MoveTo(Point::new(0.0, 0.0)),
            PathSeg::LineTo(Point::new(10.0, 0.0)),
            PathSeg::CubicTo {
                c1: Point::new(11.0, 1.0),
                c2: Point::new(12.0, 2.0),
                end: Point::new(10.0, 10.0),
            },
            PathSeg::Close,
        ]);
        let node = Node {
            id: 7,
            kind: ShapeKind::Path,
            bounds: Rect::from_ltrb(0.0, 0.0, 12.0, 10.0),
            path: Some(path),
            transform: Matrix::identity(),
            fills: vec![],
            opacity: 1.0,
            hidden: false,
        };
        assert_eq!(node.kind, ShapeKind::Path);
        assert_eq!(node.path.as_ref().unwrap().segments.len(), 4);
        assert_eq!(node.path.unwrap().segments[3], PathSeg::Close);
    }
}
