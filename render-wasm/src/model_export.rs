//! Export render-wasm's Skia-typed shapes into the backend-neutral [`render_core::model`],
//! for handing off to a non-Skia backend (e.g. a Vello module).
//!
//! Approach B (docs/vello-backend-plan.md): the Skia engine is left untouched; this is a
//! read-only projection from `crate::shapes::Shape` to the neutral model, going through the
//! [`crate::core_convert`] geometry boundary. It starts with solid-filled rects/circles and
//! grows as the neutral model does.

#![allow(dead_code)]

use crate::core_convert::{affine_to_core, color_to_core, rect_to_core};
use crate::shapes::{Corners, Fill, Gradient, Path, Segment, Shape, StrokeKind, Type};
use crate::shapes::{StrokeLineCap, StrokeLineJoin};
use render_core::kurbo::{self, BezPath, Point};
use render_core::model as m;
use render_core::peniko::{Brush, ColorStop, Gradient as PGradient};

/// Project a shape into the neutral model. Returns `None` for shape kinds not yet supported.
pub fn node_from_shape(shape: &Shape) -> Option<m::Node> {
    let (kind, path) = match &shape.shape_type {
        Type::Rect(_) => (m::ShapeKind::Rect, None),
        Type::Circle => (m::ShapeKind::Circle, None),
        Type::Path(path) => (m::ShapeKind::Path, Some(path_to_core(path))),
        Type::Frame(_) => (m::ShapeKind::Frame, None),
        Type::Group(_) => (m::ShapeKind::Group, None),
        // Text/Bool/SVGRaw are deferred to later increments.
        _ => return None,
    };

    let fills = shape.fills.iter().filter_map(fill_to_core).collect();
    let strokes = shape.strokes.iter().filter_map(stroke_to_core).collect();

    Some(m::Node {
        id: shape.id.as_u128(),
        kind,
        bounds: rect_to_core(shape.selrect),
        path,
        corners: corners_to_core(shape.shape_type.corners()),
        transform: affine_to_core(&shape.transform),
        children: shape.children.iter().map(|id| id.as_u128()).collect(),
        parent: shape.parent_id.map(|id| id.as_u128()),
        // Projected verbatim. render-wasm clips on `clip_content` alone, with no type check —
        // it is the *host* that decides only frames and slots may clip
        // (`orchestration.ts`: `clips = type === 'frame' || type === 'slot'`), sending false
        // for everything else. Re-deriving that rule here would be a second, divergent copy.
        clip: shape.clip_content,
        fills,
        strokes,
        opacity: shape.opacity,
        hidden: shape.hidden,
    })
}

/// Skia's `Corners` is four `Point`s, so it can express elliptical corners; Penpot only ever
/// builds them from a single scalar per corner (`make_corners` writes `(r, r)`), and
/// `RoundedRectRadii` is scalar too. The `y` component is therefore dropped rather than lost.
fn corners_to_core(corners: Option<Corners>) -> Option<kurbo::RoundedRectRadii> {
    corners.map(|c| {
        kurbo::RoundedRectRadii::new(c[0].x as f64, c[1].x as f64, c[2].x as f64, c[3].x as f64)
    })
}

fn path_to_core(path: &Path) -> BezPath {
    let mut bp = BezPath::new();
    for seg in path.segments() {
        match *seg {
            Segment::MoveTo((x, y)) => bp.move_to((x as f64, y as f64)),
            Segment::LineTo((x, y)) => bp.line_to((x as f64, y as f64)),
            Segment::CurveTo(((c1x, c1y), (c2x, c2y), (ex, ey))) => bp.curve_to(
                (c1x as f64, c1y as f64),
                (c2x as f64, c2y as f64),
                (ex as f64, ey as f64),
            ),
            Segment::Close => bp.close_path(),
        }
    }
    bp
}

fn fill_to_core(fill: &Fill) -> Option<Brush> {
    match fill {
        Fill::Solid(solid) => Some(Brush::Solid(color_to_core(solid.0))),
        Fill::LinearGradient(g) => Some(Brush::Gradient(
            PGradient::new_linear(pt(g.start), pt(g.end)).with_stops(&stops(g)[..]),
        )),
        // `width.0` is the radius scalar for radial (see `Gradient::width`).
        Fill::RadialGradient(g) => Some(Brush::Gradient(
            PGradient::new_radial(pt(g.start), g.width.0).with_stops(&stops(g)[..]),
        )),
        // Angular is peniko's sweep. Penpot's angular stops are already normalised over a
        // full turn, so the sweep spans 0..2π.
        Fill::AngularGradient(g) => Some(Brush::Gradient(
            PGradient::new_sweep(pt(g.start), 0.0, std::f32::consts::TAU).with_stops(&stops(g)[..]),
        )),
        // Diamond has no peniko equivalent — it is a Penpot/Figma construct, not a CSS/SVG
        // one. It is already on the SkSL->WGSL list for Phase 4 via `FilterPrimitive::Custom`
        // (D10), and rides along with the other custom shaders rather than getting a model type.
        Fill::DiamondGradient(_) => None,
        // Image fills map onto `Brush::Image`; deferred with the rest of the image work.
        Fill::Image(_) => None,
    }
}

#[inline]
fn pt(p: (f32, f32)) -> Point {
    Point::new(p.0 as f64, p.1 as f64)
}

/// `ColorStops` is a newtype over a `SmallVec` with no `FromIterator`, and `with_stops` takes
/// any `ColorStopsSource` — `&[ColorStop]` is one — so a plain `Vec` is the simplest bridge.
fn stops(g: &Gradient) -> Vec<ColorStop> {
    g.colors
        .iter()
        .zip(g.offsets.iter())
        .map(|(c, off)| ColorStop {
            offset: *off,
            color: color_to_core(*c).into(),
        })
        .collect()
}

fn stroke_to_core(stroke: &crate::shapes::Stroke) -> Option<m::Stroke> {
    let brush = fill_to_core(&stroke.fill)?;

    let mut style = kurbo::Stroke::new(stroke.width as f64);

    if let Some(join) = stroke.line_join {
        style.join = match join {
            StrokeLineJoin::Miter => kurbo::Join::Miter,
            StrokeLineJoin::Round => kurbo::Join::Round,
            StrokeLineJoin::Bevel => kurbo::Join::Bevel,
        };
    }
    if let Some(limit) = stroke.miter_limit {
        style.miter_limit = limit as f64;
    }
    if let Some(cap) = stroke.dash_cap {
        let cap = match cap {
            StrokeLineCap::Butt => kurbo::Cap::Butt,
            StrokeLineCap::Round => kurbo::Cap::Round,
            StrokeLineCap::Square => kurbo::Cap::Square,
        };
        style.start_cap = cap;
        style.end_cap = cap;
    }
    if !stroke.dashes.is_empty() {
        style.dash_pattern = stroke.dashes.iter().map(|d| *d as f64).collect();
    }

    // `StrokeKind` (inner/outer/center) is an offsetting decision, not a stroke style, and
    // kurbo has no slot for it. Centre needs nothing; inner/outer need the path offset before
    // it reaches this model, which is not done yet — so they are dropped rather than projected
    // as if they were centred.
    match stroke.kind {
        StrokeKind::Center => Some(m::Stroke { style, brush }),
        StrokeKind::Inner | StrokeKind::Outer => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Matrix;
    use crate::shapes::{Group, Rect as ShapeRect, SolidColor};
    use crate::uuid::Uuid;
    use render_core::kurbo::{PathEl, Point, Rect};
    use render_core::peniko::Color;
    use skia_safe as skia;

    #[test]
    fn projects_a_solid_rect_into_the_neutral_model() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        shape.set_selrect(10.0, 20.0, 40.0, 80.0);
        shape.transform = Matrix::translate((5.0, 7.0));
        shape.opacity = 0.5;
        // ARGB: a=255, r=10, g=20, b=30
        shape.add_fill(Fill::Solid(SolidColor(skia::Color::from_argb(
            255, 10, 20, 30,
        ))));

        let node = node_from_shape(&shape).expect("a solid rect must project");

        assert_eq!(node.id, Uuid::nil().as_u128());
        assert_eq!(node.kind, m::ShapeKind::Rect);
        assert_eq!(node.bounds, Rect::new(10.0, 20.0, 40.0, 80.0));
        let [_, _, _, _, tx, ty] = node.transform.as_coeffs();
        assert_eq!((tx, ty), (5.0, 7.0));
        assert_eq!(node.opacity, 0.5);
        assert!(!node.hidden);
        assert_eq!(
            node.fills,
            vec![Brush::Solid(Color::from_rgba8(10, 20, 30, 255))]
        );
    }

    /// Text, Bool and SVGRaw have no model kind yet. Frame and Group do, as of the hierarchy
    /// slice — a container that projected to `None` would take its whole subtree with it.
    #[test]
    fn unsupported_kind_projects_to_none() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::SVGRaw(crate::shapes::SVGRaw::default()));
        assert!(node_from_shape(&shape).is_none());
    }

    #[test]
    fn containers_project_with_their_children() {
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();

        let mut shape = Shape::new(parent);
        shape.set_shape_type(Type::Group(Group { masked: false }));
        shape.add_child(child);

        let node = node_from_shape(&shape).expect("a group must project");
        assert_eq!(node.kind, m::ShapeKind::Group);
        assert_eq!(node.children, vec![child.as_u128()]);
    }

    /// `clip_content` is projected verbatim — the frame-only rule lives in the host, and
    /// re-deriving it here would be a second, divergent copy.
    #[test]
    fn frames_carry_clip_and_parent() {
        let parent = Uuid::new_v4();

        let mut shape = Shape::new(Uuid::new_v4());
        shape.set_shape_type(Type::Frame(crate::shapes::Frame::default()));
        shape.parent_id = Some(parent);
        shape.set_clip(true);

        let node = node_from_shape(&shape).expect("a frame must project");
        assert_eq!(node.kind, m::ShapeKind::Frame);
        assert_eq!(node.parent, Some(parent.as_u128()));
        assert!(node.clip);

        shape.set_clip(false);
        assert!(!node_from_shape(&shape).unwrap().clip);
    }

    #[test]
    fn projects_a_vector_path() {
        use crate::shapes::Path as ShapePath;

        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Path(ShapePath::new(vec![
            Segment::MoveTo((0.0, 0.0)),
            Segment::LineTo((10.0, 0.0)),
            Segment::CurveTo(((11.0, 1.0), (12.0, 2.0), (10.0, 10.0))),
            Segment::Close,
        ])));

        let node = node_from_shape(&shape).expect("a path must project");
        assert_eq!(node.kind, m::ShapeKind::Path);

        let path = node.path.expect("path geometry present");
        let els = path.elements();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[1], PathEl::LineTo(Point::new(10.0, 0.0)));
        assert_eq!(
            els[2],
            PathEl::CurveTo(
                Point::new(11.0, 1.0),
                Point::new(12.0, 2.0),
                Point::new(10.0, 10.0),
            )
        );
        assert_eq!(els[3], PathEl::ClosePath);
    }

    #[test]
    fn rect_has_no_path_geometry() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.path.is_none());
    }

    fn rect_shape() -> Shape {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        shape.set_selrect(0.0, 0.0, 100.0, 100.0);
        shape
    }

    fn two_stop_gradient() -> Gradient {
        Gradient::new(
            (0.0, 0.0),
            (100.0, 0.0),
            255,
            (50.0, 0.0),
            &[
                (skia::Color::from_argb(255, 255, 0, 0), 0.0),
                (skia::Color::from_argb(255, 0, 0, 255), 1.0),
            ],
        )
    }

    #[test]
    fn projects_a_linear_gradient_with_its_stops() {
        let mut shape = rect_shape();
        shape.add_fill(Fill::LinearGradient(two_stop_gradient()));

        let node = node_from_shape(&shape).expect("rect projects");
        let Brush::Gradient(g) = &node.fills[0] else {
            panic!("expected a gradient brush, got {:?}", node.fills[0]);
        };
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].offset, 0.0);
        assert_eq!(g.stops[1].offset, 1.0);
    }

    /// Angular is peniko's sweep; radial carries its radius from `width.0`. Both must produce
    /// a gradient rather than silently dropping, which is what the old converter did.
    #[test]
    fn radial_and_angular_both_project() {
        for fill in [
            Fill::RadialGradient(two_stop_gradient()),
            Fill::AngularGradient(two_stop_gradient()),
        ] {
            let mut shape = rect_shape();
            shape.add_fill(fill);
            let node = node_from_shape(&shape).expect("rect projects");
            assert!(matches!(node.fills[0], Brush::Gradient(_)));
        }
    }

    /// Diamond has no peniko equivalent and rides along with the Phase-4 custom shaders.
    #[test]
    fn diamond_gradient_is_not_projected() {
        let mut shape = rect_shape();
        shape.add_fill(Fill::DiamondGradient(two_stop_gradient()));

        let node = node_from_shape(&shape).expect("rect still projects");
        assert!(node.fills.is_empty());
    }

    #[test]
    fn projects_a_centre_stroke() {
        use crate::shapes::{SolidColor, StrokeStyle};

        let mut shape = rect_shape();
        let mut stroke =
            crate::shapes::Stroke::new_center_stroke(4.0, StrokeStyle::Solid, None, None);
        stroke.fill = Fill::Solid(SolidColor(skia::Color::from_argb(255, 1, 2, 3)));
        stroke.dashes = vec![6.0, 2.0];
        stroke.miter_limit = Some(9.0);
        shape.add_stroke(stroke);

        let node = node_from_shape(&shape).expect("rect projects");
        assert_eq!(node.strokes.len(), 1);
        let s = &node.strokes[0];
        assert_eq!(s.style.width, 4.0);
        assert_eq!(s.style.miter_limit, 9.0);
        assert_eq!(s.style.dash_pattern.as_slice(), &[6.0, 2.0]);
        assert_eq!(s.brush, Brush::Solid(Color::from_rgba8(1, 2, 3, 255)));
    }

    /// Inner/outer need the path offset before this model; projecting them as centred would
    /// render them in the wrong place, so they are dropped instead.
    #[test]
    fn inner_stroke_is_dropped_rather_than_mis_projected() {
        use crate::shapes::{SolidColor, StrokeStyle};

        let mut shape = rect_shape();
        let mut stroke =
            crate::shapes::Stroke::new_inner_stroke(4.0, StrokeStyle::Solid, None, None);
        stroke.fill = Fill::Solid(SolidColor(skia::Color::from_argb(255, 1, 2, 3)));
        shape.add_stroke(stroke);

        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.strokes.is_empty());
    }

    #[test]
    fn rect_with_no_fills_projects_empty() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        shape.set_selrect(0.0, 0.0, 10.0, 10.0);
        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.fills.is_empty());
        assert!(node.strokes.is_empty());
    }
}
