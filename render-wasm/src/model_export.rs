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
use render_core::gradient::{GradientGeometry, GradientShape, gradient_paint};
use render_core::peniko::{Brush, ColorStop};

/// Project the whole document into a neutral scene, for [`render_core::model::Scene::digest`].
///
/// Shapes this projection does not understand yet — text, bools, svg-raw — are skipped rather
/// than faked. That is visible in the digest as a *missing child*: the parent still lists the
/// id, and the neutral model hashes "referenced but absent" distinctly. So an unsupported shape
/// reads as a known hole rather than as agreement, which is the honest answer while the
/// projection is incomplete.
///
/// Unreachable shapes cost nothing: the digest walks the tree from the root, so pool slots left
/// over from a previous page are skipped without needing to be swept first.
pub fn scene_from_shapes<'a>(shapes: impl Iterator<Item = &'a Shape>) -> m::Scene {
    let mut scene = m::Scene::new();
    for shape in shapes {
        if let Some(node) = node_from_shape(shape) {
            scene.insert(node);
        }
    }
    scene
}

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

/// Project a Skia-side fill into neutral paint.
///
/// The gradient maths is **not** re-derived here. `render_core::gradient` builds the peniko
/// gradient and its unit-box transform together, and `shapes/fills.rs` builds the equivalent
/// Skia shaders for this engine's own rendering — two implementations is already one more than
/// ideal, and a third, subtly different one in the projection is how the backends drift.
fn fill_to_core(fill: &Fill) -> Option<m::Paint> {
    let geometry = |g: &Gradient| GradientGeometry {
        start: g.start,
        end: g.end,
        width: g.width,
    };
    let gradient = |shape: GradientShape, g: &Gradient| {
        gradient_paint(shape, geometry(g), &stops(g)[..]).map(|(gradient, transform)| m::Paint {
            brush: Brush::Gradient(gradient),
            transform,
        })
    };

    match fill {
        Fill::Solid(solid) => Some(m::Paint::plain(Brush::Solid(color_to_core(solid.0)))),
        Fill::LinearGradient(g) => gradient(GradientShape::Linear, g),
        Fill::RadialGradient(g) => gradient(GradientShape::Radial, g),
        Fill::AngularGradient(g) => gradient(GradientShape::Angular, g),
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
    let paint = fill_to_core(&stroke.fill)?;

    // Skia's defaults, not kurbo's: `kurbo::Stroke::new` gives a round join and round caps,
    // while Skia gives miter and butt — and `Stroke::to_paint` leaves those alone when the
    // shape carries no explicit join or cap. Projecting kurbo's defaults would make an
    // unstyled stroke render differently from how this very engine draws it.
    let mut style = kurbo::Stroke::new(stroke.width as f64)
        .with_join(kurbo::Join::Miter)
        .with_caps(kurbo::Cap::Butt);

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
    // Dash pattern comes from the shared helper, not from `stroke.dashes` alone. Penpot's
    // Dotted/Dashed/Mixed styles imply a pattern built from the width (`width + 10`, and so on),
    // and reading only the custom dashes here dropped those three styles entirely — a dotted
    // border projected as solid. `apply_stroke_style` is the one place those constants live, so
    // the two backends cannot drift apart on them.
    m::apply_stroke_style(
        &mut style,
        match stroke.style {
            crate::shapes::StrokeStyle::Solid => m::StrokeStyle::Solid,
            crate::shapes::StrokeStyle::Dotted => m::StrokeStyle::Dotted,
            crate::shapes::StrokeStyle::Dashed => m::StrokeStyle::Dashed,
            crate::shapes::StrokeStyle::Mixed => m::StrokeStyle::Mixed,
        },
        stroke.width,
        &stroke.dashes,
    );

    // `StrokeKind` (inner/outer/center) is an offsetting decision, not a stroke style, and
    // kurbo has no slot for it. Centre needs nothing; inner/outer need the path offset before
    // it reaches this model, which is not done yet — so they are dropped rather than projected
    // as if they were centred.
    match stroke.kind {
        StrokeKind::Center => Some(m::Stroke { style, paint }),
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
            vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(10, 20, 30, 255)))]
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
        let Brush::Gradient(g) = &node.fills[0].brush else {
            panic!("expected a gradient brush, got {:?}", node.fills[0]);
        };
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].offset, 0.0);
        assert_eq!(g.stops[1].offset, 1.0);
    }

    /// Radial and angular both project — the old converter dropped them.
    ///
    /// Angular needs a genuine second axis. `width` is `pointAt90`, the end of the gradient's
    /// other axis, so a `width` collinear with `end` describes a gradient with no area: Skia
    /// builds a singular matrix from it and paints something arbitrary, and we decline instead.
    #[test]
    fn radial_and_angular_both_project() {
        let mut angular = two_stop_gradient();
        angular.width = (50.0, 50.0);

        for fill in [
            Fill::RadialGradient(two_stop_gradient()),
            Fill::AngularGradient(angular),
        ] {
            let mut shape = rect_shape();
            shape.add_fill(fill);
            let node = node_from_shape(&shape).expect("rect projects");
            assert!(matches!(node.fills[0].brush, Brush::Gradient(_)));
        }
    }

    /// The degenerate angular case, stated: collinear axes are dropped rather than painted from
    /// a singular matrix.
    #[test]
    fn an_angular_gradient_with_collinear_axes_is_dropped() {
        let mut shape = rect_shape();
        // `two_stop_gradient` has `end` and `width` both on the x axis.
        shape.add_fill(Fill::AngularGradient(two_stop_gradient()));
        let node = node_from_shape(&shape).expect("rect projects");
        assert!(node.fills.is_empty());
    }

    /// Radial and angular carry their placement in the paint transform; linear does not need one.
    #[test]
    fn only_the_shaped_gradients_carry_a_transform() {
        let linear = {
            let mut shape = rect_shape();
            shape.add_fill(Fill::LinearGradient(two_stop_gradient()));
            node_from_shape(&shape).unwrap().fills.remove(0)
        };
        assert_eq!(linear.transform, render_core::kurbo::Affine::IDENTITY);

        let radial = {
            let mut shape = rect_shape();
            shape.add_fill(Fill::RadialGradient(two_stop_gradient()));
            node_from_shape(&shape).unwrap().fills.remove(0)
        };
        assert_ne!(
            radial.transform,
            render_core::kurbo::Affine::IDENTITY,
            "a radial's rotation and ellipse live in the transform"
        );
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
        // Through `set_dashes`, which forces `Dashed` — a solid stroke ignores its dash list,
        // both here and in `to_paint`, so the combination the field-assignment version of this
        // test used is one the host cannot actually produce.
        stroke.set_dashes(vec![6.0, 2.0]);
        stroke.miter_limit = Some(9.0);
        shape.add_stroke(stroke);

        let node = node_from_shape(&shape).expect("rect projects");
        assert_eq!(node.strokes.len(), 1);
        let s = &node.strokes[0];
        assert_eq!(s.style.width, 4.0);
        assert_eq!(s.style.miter_limit, 9.0);
        assert_eq!(s.style.dash_pattern.as_slice(), &[6.0, 2.0]);
        assert_eq!(s.paint.brush, Brush::Solid(Color::from_rgba8(1, 2, 3, 255)));
        // Skia's defaults, not kurbo's — see `stroke_to_core`.
        assert_eq!(s.style.join, kurbo::Join::Miter);
        assert_eq!(s.style.start_cap, kurbo::Cap::Butt);
    }

    /// A style with no custom dashes still implies a pattern, built from the width. Reading
    /// only `stroke.dashes` — as this projection used to — dropped Dotted, Dashed and Mixed
    /// entirely, projecting a dotted border as solid.
    #[test]
    fn stroke_styles_project_to_their_dash_patterns() {
        use crate::shapes::StrokeStyle as SS;
        let pattern = |style: SS| {
            let mut shape = rect_shape();
            let mut stroke = crate::shapes::Stroke::new_center_stroke(4.0, style, None, None);
            stroke.fill = Fill::Solid(SolidColor(skia::Color::from_argb(255, 1, 2, 3)));
            shape.add_stroke(stroke);
            node_from_shape(&shape).unwrap().strokes[0]
                .style
                .dash_pattern
                .to_vec()
        };

        assert!(pattern(SS::Solid).is_empty());
        assert_eq!(pattern(SS::Dashed), vec![14.0, 14.0]);
        assert_eq!(pattern(SS::Mixed), vec![9.0, 9.0, 5.0, 9.0]);
        assert_eq!(pattern(SS::Dotted), vec![0.01, 8.99]);
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

    // --- digest parity -------------------------------------------------------------------
    //
    // The Skia half of the differential harness. render-vello builds a neutral scene straight
    // from the wire; this side reaches the same model through Skia shapes. These tests assert
    // the two meet — stated as a digest, because that is the value the two backends actually
    // compare at runtime.

    /// A small document, built the long way round: Skia shapes projected through this module.
    ///
    /// One builder, so a second fixture cannot quietly drift from the first.
    fn document_shapes() -> Vec<Shape> {
        let child = Uuid::from_u64_pair(0, 0x1234);

        let mut root = Shape::new(Uuid::nil());
        root.set_shape_type(Type::Frame(crate::shapes::Frame::default()));
        root.set_selrect(0.0, 0.0, 400.0, 300.0);
        root.add_child(child);

        let mut rect = Shape::new(child);
        rect.set_shape_type(Type::Rect(ShapeRect::default()));
        rect.set_selrect(10.0, 20.0, 110.0, 70.0);
        rect.parent_id = Some(Uuid::nil());
        rect.add_fill(Fill::Solid(SolidColor(skia::Color::from_argb(
            255, 10, 20, 30,
        ))));

        // Set explicitly on both, exactly as the host does for every shape it syncs
        // (`orchestration.ts`). Left to the constructors these two disagree — see
        // `the_two_models_disagree_on_the_default_clip`.
        root.set_clip(false);
        rect.set_clip(false);

        vec![root, rect]
    }

    fn projected_document() -> m::Scene {
        scene_from_shapes(document_shapes().iter())
    }

    /// The same document, hand-built in the neutral model — what render-vello would hold after
    /// reading the equivalent wire bytes.
    fn neutral_document() -> m::Scene {
        let mut scene = m::Scene::new();

        let mut root = m::Node::new(m::ROOT_ID, m::ShapeKind::Frame);
        root.bounds = Rect::new(0.0, 0.0, 400.0, 300.0);
        root.children = vec![0x1234];
        scene.insert(root);

        let mut rect = m::Node::new(0x1234, m::ShapeKind::Rect);
        rect.bounds = Rect::new(10.0, 20.0, 110.0, 70.0);
        rect.parent = Some(m::ROOT_ID);
        rect.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(10, 20, 30, 255)))];
        scene.insert(rect);

        scene
    }

    /// The whole point of the harness: two routes to the same document must agree exactly.
    #[test]
    fn a_projected_document_digests_the_same_as_a_hand_built_one() {
        assert_eq!(projected_document().digest(), neutral_document().digest());
    }

    /// The first thing the harness caught, pinned so it is not rediscovered.
    ///
    /// `Shape::new` defaults `clip_content` to **true**; `Node::new` defaults it to false. Every
    /// shape the host syncs carries an explicit value (`orchestration.ts` sends
    /// `type === 'frame' || type === 'slot'` for all of them), so no real document is affected —
    /// but any path that creates a shape without the flag would have the two backends disagree
    /// about whether it hides its children.
    ///
    /// The defaults are deliberately *not* aligned to Skia's. Failing open is the safer of the
    /// two: an unclipped shape spills visibly, while a wrongly-clipped one makes content vanish
    /// with nothing on screen to explain it.
    #[test]
    fn the_two_models_disagree_on_the_default_clip() {
        let mut shape = Shape::new(Uuid::nil());
        shape.set_shape_type(Type::Frame(crate::shapes::Frame::default()));

        assert!(
            node_from_shape(&shape).unwrap().clip,
            "Skia's shape defaults to clipping"
        );
        assert!(
            !m::Node::new(0, m::ShapeKind::Frame).clip,
            "the neutral model defaults to not clipping"
        );
    }

    /// …and the digest must be able to *fail*. A test that only ever compares equal things
    /// proves nothing about the comparison itself.
    #[test]
    fn the_digest_notices_a_difference_between_the_two_routes() {
        let mut altered = neutral_document();
        altered.get_mut(0x1234).unwrap().bounds = Rect::new(10.0, 20.0, 111.0, 70.0);
        assert_ne!(projected_document().digest(), altered.digest());
    }

    /// Pool slots left over from a previous page must not change the answer — the digest walks
    /// the tree, so anything the root cannot reach is not part of the picture.
    #[test]
    fn unreachable_pool_shapes_do_not_affect_the_digest() {
        let mut stale = Shape::new(Uuid::from_u64_pair(0, 0x9999));
        stale.set_shape_type(Type::Rect(ShapeRect::default()));
        stale.set_selrect(500.0, 500.0, 600.0, 600.0);

        let mut shapes = document_shapes();
        shapes.push(stale);

        assert_eq!(
            scene_from_shapes(shapes.iter()).digest(),
            projected_document().digest()
        );
    }

    /// A shape kind this projection does not understand yet must read as a *hole*, not as
    /// agreement: the parent still lists the id, and the neutral model hashes "referenced but
    /// absent" distinctly. Otherwise adding text to a document would silently look like parity.
    #[test]
    fn an_unsupported_shape_reads_as_a_missing_child_not_as_agreement() {
        let text_id = Uuid::from_u64_pair(0, 0x5555);

        let mut root = Shape::new(Uuid::nil());
        root.set_shape_type(Type::Frame(crate::shapes::Frame::default()));
        root.set_selrect(0.0, 0.0, 400.0, 300.0);
        root.add_child(text_id);

        let mut text = Shape::new(text_id);
        text.set_shape_type(Type::SVGRaw(crate::shapes::SVGRaw::default()));

        let projected = scene_from_shapes([root, text].iter());
        assert!(projected.get(text_id.as_u128()).is_none(), "not projected");

        // A scene whose root lists nothing at all must not hash the same as one listing a child
        // that never arrived.
        let mut empty_root = m::Scene::new();
        let mut r = m::Node::new(m::ROOT_ID, m::ShapeKind::Frame);
        r.bounds = Rect::new(0.0, 0.0, 400.0, 300.0);
        empty_root.insert(r);

        assert_ne!(projected.digest(), empty_root.digest());
    }
}
