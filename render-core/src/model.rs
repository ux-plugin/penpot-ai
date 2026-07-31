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

/// The geometry family of a node. `Text` and the rest follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ShapeKind {
    Rect,
    Circle,
    /// A vector path; the geometry lives in [`Node::path`].
    Path,
    /// A container with its own geometry — it paints fills and strokes, and can clip.
    Frame,
    /// A container with no geometry of its own. Never clips; exists to group and to carry
    /// opacity, blend and masking over its children.
    Group,
}

impl ShapeKind {
    /// Whether the node holds children rather than drawing itself.
    #[inline]
    pub fn is_container(self) -> bool {
        matches!(self, Self::Frame | Self::Group)
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
    /// Vector geometry in the node's local space, present when `kind == ShapeKind::Path`.
    pub path: Option<BezPath>,
    /// Corner radii for a `Rect`, `None` when the corners are square.
    ///
    /// Penpot's `set_shape_corners(r1, r2, r3, r4)` is top-left, top-right, bottom-right,
    /// bottom-left — the same order as [`RoundedRectRadii`]'s fields and as Skia's `RRect`
    /// radii array, so no reordering happens anywhere along the path.
    pub corners: Option<RoundedRectRadii>,
    /// The shape's own transform, exactly as it arrives on the wire.
    ///
    /// **This is not a world matrix, and it is not composed with the parent's.** Penpot stores
    /// absolute `selrect`s, so a child is already positioned in page space; a container
    /// contributes clipping and layers to its children, never geometry. render-wasm's traversal
    /// applies `scale · viewport · shape_matrix` from scratch per shape and never accumulates a
    /// parent CTM, so multiplying one in here would double-transform every nested shape.
    ///
    /// It is also *centred*: the effective matrix is
    /// `translate(c) · transform · translate(-c)` for `c = bounds.center()`, which is what makes
    /// a rotation spin about the shape rather than about the page origin. Use
    /// [`Node::effective_transform`] rather than this field directly.
    pub transform: Affine,
    /// Children, in paint order — back to front. This is the authority on ordering; [`parent`]
    /// is carried for completeness and is not used to derive it.
    ///
    /// [`parent`]: Node::parent
    pub children: Vec<u128>,
    /// Set by `set_parent`. render-wasm uses it to invalidate a container's cached bounds; a
    /// renderer does not need it, because it walks down from the root through `children`.
    pub parent: Option<u128>,
    /// Whether this node clips its children to its own geometry (Penpot's `clip_content`).
    pub clip: bool,
    /// Paints, back to front. `peniko::Brush` already covers solid, gradient and image, so
    /// gradients need no new type here — only a converter in `model_export`.
    pub fills: Vec<Brush>,
    /// Strokes, back to front, painted over the fills.
    pub strokes: Vec<Stroke>,
    pub opacity: f32,
    pub hidden: bool,
}

impl Node {
    /// An empty node: no geometry, no paint, fully opaque, visible.
    ///
    /// The wire protocol is a stream of setters against a shape that already exists, so both
    /// backends need a blank to apply them to.
    pub fn new(id: u128, kind: ShapeKind) -> Self {
        Self {
            id,
            kind,
            bounds: Rect::ZERO,
            path: None,
            corners: None,
            transform: Affine::IDENTITY,
            children: Vec::new(),
            parent: None,
            clip: false,
            fills: Vec::new(),
            strokes: Vec::new(),
            opacity: 1.0,
            hidden: false,
        }
    }

    /// The matrix to draw with: the stored transform conjugated by the shape's centre.
    ///
    /// render-wasm computes exactly this before every draw (`matrix.post_translate(center);
    /// matrix.pre_translate(-center)`). Applying [`Node::transform`] raw instead spins a
    /// rotation about the page origin, which looks like the shape flying off rather than like a
    /// wrong matrix — so it is easy to misdiagnose.
    pub fn effective_transform(&self) -> Affine {
        let c = self.bounds.center();
        Affine::translate((c.x, c.y)) * self.transform * Affine::translate((-c.x, -c.y))
    }
}

/// The id of the implicit root. Penpot's root shape is the nil UUID, and the host addresses it
/// like any other node — `use_shape(0,0,0,0)` then `set_children(…)`.
///
/// The root itself is never painted and never clips (render-wasm short-circuits on
/// `id.is_nil()`); only its children are.
pub const ROOT_ID: u128 = 0;

/// A scene as a tree: every node by id, walked from [`ROOT_ID`] through [`Node::children`].
///
/// Keyed rather than flat because the wire format addresses nodes by id and delivers them in no
/// particular order — a child can arrive before the parent that lists it.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    nodes: std::collections::HashMap<u128, Node>,
}

impl Scene {
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace a node.
    #[inline]
    pub fn insert(&mut self, node: Node) {
        self.nodes.insert(node.id, node);
    }

    #[inline]
    pub fn get(&self, id: u128) -> Option<&Node> {
        self.nodes.get(&id)
    }

    #[inline]
    pub fn get_mut(&mut self, id: u128) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    /// Pre-size the map. The host announces its shape count up front
    /// (`init_shapes_pool`), and a scene built one `use_shape` at a time would otherwise
    /// rehash its way up to that size.
    #[inline]
    pub fn reserve(&mut self, additional: usize) {
        self.nodes.reserve(additional);
    }

    #[inline]
    pub fn clear(&mut self) {
        self.nodes.clear();
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The top-level nodes, in paint order. Empty when the host has not sent a root yet.
    pub fn roots(&self) -> &[u128] {
        self.get(ROOT_ID).map_or(&[], |root| &root.children)
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

    fn node(id: u128, kind: ShapeKind) -> Node {
        Node::new(id, kind)
    }

    #[test]
    fn builds_a_minimal_scene() {
        let mut scene = Scene::new();
        let mut n = node(42, ShapeKind::Rect);
        n.bounds = Rect::new(0.0, 0.0, 100.0, 50.0);
        n.fills = vec![Brush::Solid(Color::from_rgba8(255, 0, 0, 255))];
        scene.insert(n);

        assert_eq!(scene.len(), 1);
        let got = scene.get(42).unwrap();
        assert_eq!(
            got.fills[0],
            Brush::Solid(Color::from_rgba8(255, 0, 0, 255))
        );
        assert_eq!(got.bounds.width(), 100.0);
    }

    #[test]
    fn builds_a_path_node() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((10.0, 0.0));
        path.curve_to((11.0, 1.0), (12.0, 2.0), (10.0, 10.0));
        path.close_path();

        let mut n = node(7, ShapeKind::Path);
        n.bounds = Rect::new(0.0, 0.0, 12.0, 10.0);
        n.path = Some(path);
        assert_eq!(n.kind, ShapeKind::Path);

        let els = n.path.as_ref().unwrap().elements();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[3], PathEl::ClosePath);
    }

    /// A child can arrive before the parent that lists it, which is why the scene is keyed
    /// rather than ordered. `roots()` must not care.
    #[test]
    fn roots_come_from_the_root_node_regardless_of_insertion_order() {
        let mut scene = Scene::new();
        assert!(scene.roots().is_empty());

        scene.insert(node(20, ShapeKind::Rect));

        let mut root = node(ROOT_ID, ShapeKind::Group);
        root.children = vec![10, 20];
        scene.insert(root);
        scene.insert(node(10, ShapeKind::Rect));

        assert_eq!(scene.roots(), &[10, 20]);
        assert_eq!(scene.len(), 3);
        assert!(scene.get(999).is_none());
    }

    /// The centring is what makes a rotation spin about the shape instead of the page origin.
    #[test]
    fn effective_transform_is_centred_on_the_bounds() {
        let mut n = node(1, ShapeKind::Rect);
        n.bounds = Rect::new(10.0, 20.0, 30.0, 40.0); // centre (20, 30)
        n.transform = Affine::rotate(std::f64::consts::FRAC_PI_2);

        // A quarter turn about the centre leaves the centre fixed.
        let centre = Point::new(20.0, 30.0);
        let moved = n.effective_transform() * centre;
        assert!((moved - centre).hypot() < 1e-9);

        // Applying the raw transform instead would swing it right across the page.
        let naive = n.transform * centre;
        assert!((naive - centre).hypot() > 1.0);
    }

    #[test]
    fn identity_transform_is_unaffected_by_centring() {
        let mut n = node(1, ShapeKind::Rect);
        n.bounds = Rect::new(5.0, 5.0, 15.0, 25.0);
        assert_eq!(n.effective_transform(), Affine::IDENTITY);
    }

    #[test]
    fn containers_are_distinguishable() {
        assert!(ShapeKind::Frame.is_container());
        assert!(ShapeKind::Group.is_container());
        assert!(!ShapeKind::Rect.is_container());
        assert!(!ShapeKind::Path.is_container());
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
