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

use kurbo::{Affine, BezPath, Rect, RoundedRectRadii};
use peniko::Brush;

use crate::abi::RawSegmentData;

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
    /// Corner radii for a `Rect`, `None` when the corners are square.
    ///
    /// Penpot's `set_shape_corners(r1, r2, r3, r4)` is top-left, top-right, bottom-right,
    /// bottom-left — the same order as [`RoundedRectRadii`]'s fields and as Skia's `RRect`
    /// radii array, so no reordering happens anywhere along the path.
    pub corners: Option<RoundedRectRadii>,
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

/// Build a [`BezPath`] from decoded wire segments.
///
/// This lives here rather than in [`crate::abi`] because it produces a model type; the abi
/// module stays plain layouts so the wire can be read and diffed without the model.
///
/// Two leniencies, both matching what Skia does with the same segment stream, so the Vello
/// backend does not diverge on malformed input:
///
/// - A `line-to` or `curve-to` before any `move-to` gets an implicit `move-to` at the origin.
///   kurbo would otherwise trip a debug assertion.
/// - A `close` on an empty path is dropped.
///
/// Widening f32 to f64 is exact, so nothing is lost here (D16).
pub fn bez_path_from_raw(segments: &[RawSegmentData]) -> BezPath {
    let mut path = BezPath::new();
    let mut started = false;

    let ensure_started = |path: &mut BezPath, started: &mut bool| {
        if !*started {
            path.move_to((0.0, 0.0));
            *started = true;
        }
    };

    for segment in segments {
        match segment {
            RawSegmentData::MoveTo(c) => {
                path.move_to((c.x as f64, c.y as f64));
                started = true;
            }
            RawSegmentData::LineTo(c) => {
                ensure_started(&mut path, &mut started);
                path.line_to((c.x as f64, c.y as f64));
            }
            RawSegmentData::CurveTo(c) => {
                ensure_started(&mut path, &mut started);
                path.curve_to(
                    (c.c1_x as f64, c.c1_y as f64),
                    (c.c2_x as f64, c.c2_y as f64),
                    (c.x as f64, c.y as f64),
                );
            }
            RawSegmentData::Close => {
                if started {
                    path.close_path();
                }
            }
        }
    }

    path
}

/// Turn Penpot's four corner radii into [`RoundedRectRadii`], or `None` when every corner is
/// square. Mirrors render-wasm's `make_corners`, including its all-zero shortcut.
pub fn corners_from_raw(r1: f32, r2: f32, r3: f32, r4: f32) -> Option<RoundedRectRadii> {
    let square = [r1, r2, r3, r4].iter().all(|r| r.abs() <= f32::EPSILON);

    (!square).then(|| RoundedRectRadii::new(r1 as f64, r2 as f64, r3 as f64, r4 as f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{RawCurveCommand, RawLineCommand, RawMoveCommand};
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
            corners: None,
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
            corners: None,
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

    #[test]
    fn builds_a_bez_path_from_wire_segments() {
        let segments = [
            RawSegmentData::MoveTo(RawMoveCommand::new((0.0, 0.0))),
            RawSegmentData::LineTo(RawLineCommand::new((10.0, 0.0))),
            RawSegmentData::CurveTo(RawCurveCommand::new((11.0, 1.0), (12.0, 2.0), (10.0, 10.0))),
            RawSegmentData::Close,
        ];

        let els = bez_path_from_raw(&segments).elements().to_vec();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[1], PathEl::LineTo(Point::new(10.0, 0.0)));
        assert_eq!(
            els[2],
            PathEl::CurveTo(
                Point::new(11.0, 1.0),
                Point::new(12.0, 2.0),
                Point::new(10.0, 10.0)
            )
        );
        assert_eq!(els[3], PathEl::ClosePath);
    }

    /// Malformed streams must behave like Skia's, not panic — kurbo asserts on a `line_to`
    /// with no current point, and a lone `close` has nothing to close.
    #[test]
    fn tolerates_segments_without_a_leading_move() {
        let els = bez_path_from_raw(&[RawSegmentData::LineTo(RawLineCommand::new((5.0, 5.0)))])
            .elements()
            .to_vec();
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[1], PathEl::LineTo(Point::new(5.0, 5.0)));

        assert!(bez_path_from_raw(&[RawSegmentData::Close]).is_empty());
        assert!(bez_path_from_raw(&[]).is_empty());
    }

    #[test]
    fn corners_map_in_penpot_order_and_collapse_when_square() {
        assert_eq!(corners_from_raw(0.0, 0.0, 0.0, 0.0), None);

        let r = corners_from_raw(1.0, 2.0, 3.0, 4.0).unwrap();
        assert_eq!(r.top_left, 1.0);
        assert_eq!(r.top_right, 2.0);
        assert_eq!(r.bottom_right, 3.0);
        assert_eq!(r.bottom_left, 4.0);
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
