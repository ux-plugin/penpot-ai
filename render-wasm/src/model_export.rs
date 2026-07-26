//! Export render-wasm's Skia-typed shapes into the backend-neutral [`render_core::model`],
//! for handing off to a non-Skia backend (e.g. a Vello module).
//!
//! Approach B (docs/vello-backend-plan.md): the Skia engine is left untouched; this is a
//! read-only projection from `crate::shapes::Shape` to the neutral model, going through the
//! [`crate::core_convert`] geometry boundary. It starts with solid-filled rects/circles and
//! grows as the neutral model does.

#![allow(dead_code)]

use crate::core_convert::{matrix_to_core, rect_to_core};
use crate::shapes::{Fill, Path, Segment, Shape, Type};
use render_core::geom as g;
use render_core::model as m;

/// Project a shape into the neutral model. Returns `None` for shape kinds not yet supported.
pub fn node_from_shape(shape: &Shape) -> Option<m::Node> {
    let (kind, path) = match &shape.shape_type {
        Type::Rect(_) => (m::ShapeKind::Rect, None),
        Type::Circle => (m::ShapeKind::Circle, None),
        Type::Path(path) => (m::ShapeKind::Path, Some(path_to_core(path))),
        // Frame/Group/Text/Bool/SVGRaw are deferred to later increments.
        _ => return None,
    };

    let fills = shape.fills.iter().filter_map(fill_to_core).collect();

    Some(m::Node {
        id: shape.id.as_u128(),
        kind,
        bounds: rect_to_core(shape.selrect),
        path,
        transform: matrix_to_core(&shape.transform),
        fills,
        opacity: shape.opacity,
        hidden: shape.hidden,
    })
}

fn path_to_core(path: &Path) -> m::Path {
    let segments = path.segments().iter().map(seg_to_core).collect();
    m::Path { segments }
}

fn seg_to_core(seg: &Segment) -> m::PathSeg {
    match *seg {
        Segment::MoveTo((x, y)) => m::PathSeg::MoveTo(g::Point::new(x, y)),
        Segment::LineTo((x, y)) => m::PathSeg::LineTo(g::Point::new(x, y)),
        Segment::CurveTo(((c1x, c1y), (c2x, c2y), (ex, ey))) => m::PathSeg::CubicTo {
            c1: g::Point::new(c1x, c1y),
            c2: g::Point::new(c2x, c2y),
            end: g::Point::new(ex, ey),
        },
        Segment::Close => m::PathSeg::Close,
    }
}

fn fill_to_core(fill: &Fill) -> Option<m::Fill> {
    match fill {
        Fill::Solid(solid) => {
            let c = solid.0;
            Some(m::Fill::Solid(m::Color::rgba(c.r(), c.g(), c.b(), c.a())))
        }
        // Gradients and image fills are deferred until the neutral model gains them.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Matrix;
    use crate::shapes::{Group, Rect as ShapeRect, SolidColor};
    use crate::uuid::Uuid;
    use render_core::geom as g;
    use skia_safe as skia;

    #[test]
    fn projects_a_solid_rect_into_the_neutral_model() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        shape.set_selrect(10.0, 20.0, 40.0, 80.0);
        shape.transform = Matrix::translate((5.0, 7.0));
        shape.opacity = 0.5;
        // ARGB: a=255, r=10, g=20, b=30
        shape.add_fill(Fill::Solid(SolidColor(skia::Color::from_argb(255, 10, 20, 30))));

        let node = node_from_shape(&shape).expect("a solid rect must project");

        assert_eq!(node.id, Uuid::nil().as_u128());
        assert_eq!(node.kind, m::ShapeKind::Rect);
        assert_eq!(node.bounds, g::Rect::from_ltrb(10.0, 20.0, 40.0, 80.0));
        assert_eq!(node.transform.translate_x(), 5.0);
        assert_eq!(node.transform.translate_y(), 7.0);
        assert_eq!(node.opacity, 0.5);
        assert_eq!(node.hidden, false);
        assert_eq!(
            node.fills,
            vec![m::Fill::Solid(m::Color::rgba(10, 20, 30, 255))]
        );
    }

    #[test]
    fn unsupported_kind_projects_to_none() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Group(Group { masked: false }));
        assert!(node_from_shape(&shape).is_none());
    }

    #[test]
    fn projects_a_vector_path() {
        use crate::shapes::{Path as ShapePath, Segment};

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
        assert_eq!(path.segments.len(), 4);
        assert_eq!(path.segments[0], m::PathSeg::MoveTo(g::Point::new(0.0, 0.0)));
        assert_eq!(path.segments[1], m::PathSeg::LineTo(g::Point::new(10.0, 0.0)));
        assert_eq!(
            path.segments[2],
            m::PathSeg::CubicTo {
                c1: g::Point::new(11.0, 1.0),
                c2: g::Point::new(12.0, 2.0),
                end: g::Point::new(10.0, 10.0),
            }
        );
        assert_eq!(path.segments[3], m::PathSeg::Close);
    }

    #[test]
    fn rect_has_no_path_geometry() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.path.is_none());
    }

    #[test]
    fn non_solid_fills_are_skipped_for_now() {
        // A rect with only a (currently-unsupported) fill projects, but with no fills yet.
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Rect(ShapeRect::default()));
        shape.set_selrect(0.0, 0.0, 10.0, 10.0);
        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.fills.is_empty());
    }
}
