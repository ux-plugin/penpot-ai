//! What the host is told about a selection, computed once for both backends.
//!
//! This is the same argument as `model::apply_stroke_style`: the rule is arbitrary enough that
//! deriving it separately on each side is how two backends end up disagreeing about the same
//! document. Here the arbitrary parts are a wire layout the host indexes positionally and an
//! asymmetry that reads like a bug until you know it is deliberate — a **single** selected shape
//! reports its *oriented* box, while a **multi**-selection reports the axis-aligned hull.
//!
//! The input is quads rather than model nodes so that either backend can call it. render-vello
//! builds them from `Node`s via [`node_quad`]; render-wasm's own `Bounds` is already an oriented
//! quad of exactly these four corners, so it can hand them over without projecting its Skia
//! state through the neutral model first.

use crate::kurbo::{Affine, Point};
use crate::model::Node;

/// `width, height, cx, cy, a, b, c, d, e, f` — the layout the host reads out of `HEAPF32`.
pub const SELECTION_RECT_LEN: usize = 10;

/// A node's box in page space: `nw, ne, se, sw`.
///
/// The node's own transform is applied, so a rotated shape yields a rotated quad rather than
/// its axis-aligned hull — which is the whole point of reporting an oriented box for a single
/// selection.
///
/// `modifier` is the gesture-time transform in page space, [`crate::kurbo::Affine::IDENTITY`]
/// when no drag is in flight. It is applied here rather than by the caller because a selection
/// box that ignored it would sit at the shape's committed position while the shape itself moved.
pub fn node_quad(node: &Node, modifier: Affine) -> [Point; 4] {
    let m = modifier * node.effective_transform();
    let b = node.bounds;
    [
        m * Point::new(b.x0, b.y0),
        m * Point::new(b.x1, b.y0),
        m * Point::new(b.x1, b.y1),
        m * Point::new(b.x0, b.y1),
    ]
}

/// The selection's bounding box, as the ten floats the host expects.
///
/// Mirrors render-wasm's `get_selection_rect`:
///
/// - **nothing selected** — all zeros, which the host's finite-check turns into "no selection
///   box" rather than one anchored at the origin;
/// - **one shape** — its oriented box: width and height are the shape's own, and the rotation
///   lives in the matrix, so turning a shape does not make its reported width jump;
/// - **several** — `Bounds::join_bounds`: the axis-aligned hull of every corner, unrotated.
pub fn selection_rect(quads: &[[Point; 4]]) -> [f32; SELECTION_RECT_LEN] {
    match quads {
        [] => [0.0; SELECTION_RECT_LEN],
        [single] => oriented_rect(single),
        many => {
            let (mut x0, mut y0) = (f64::MAX, f64::MAX);
            let (mut x1, mut y1) = (f64::MIN, f64::MIN);
            for quad in many {
                for p in quad {
                    x0 = x0.min(p.x);
                    y0 = y0.min(p.y);
                    x1 = x1.max(p.x);
                    y1 = y1.max(p.y);
                }
            }
            oriented_rect(&[
                Point::new(x0, y0),
                Point::new(x1, y0),
                Point::new(x1, y1),
                Point::new(x0, y1),
            ])
        }
    }
}

/// Describe a parallelogram as `width, height, cx, cy` plus the affine mapping a centred,
/// axis-aligned box of that size onto it.
///
/// render-wasm's `Bounds::transform_matrix` reaches the same answer by solving a 3×3 system.
/// With an axis-aligned source box the solution is just the normalised edge vectors, so it is
/// written out directly rather than inverting a matrix per query.
fn oriented_rect(quad: &[Point; 4]) -> [f32; SELECTION_RECT_LEN] {
    let (nw, ne, se, sw) = (quad[0], quad[1], quad[2], quad[3]);
    let width = (ne - nw).hypot();
    let height = (sw - nw).hypot();
    let cx = (nw.x + se.x) * 0.5;
    let cy = (nw.y + se.y) * 0.5;

    // A degenerate edge has no direction to recover; fall back to the identity rather than
    // dividing by zero and handing the host NaNs, which it would reject wholesale — turning a
    // zero-width shape into "no selection at all".
    let (a, b) = if width > 0.0 {
        ((ne.x - nw.x) / width, (ne.y - nw.y) / width)
    } else {
        (1.0, 0.0)
    };
    let (c, d) = if height > 0.0 {
        ((sw.x - nw.x) / height, (sw.y - nw.y) / height)
    } else {
        (0.0, 1.0)
    };

    [
        width as f32,
        height as f32,
        cx as f32,
        cy as f32,
        a as f32,
        b as f32,
        c as f32,
        d as f32,
        cx as f32,
        cy as f32,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kurbo::Rect;
    use crate::model::{Node, ShapeKind};

    fn node(bounds: Rect, transform: Affine) -> Node {
        let mut n = Node::new(1, ShapeKind::Rect);
        n.bounds = bounds;
        n.transform = transform;
        n
    }

    #[test]
    fn nothing_selected_reports_zeros() {
        assert_eq!(selection_rect(&[]), [0.0; SELECTION_RECT_LEN]);
    }

    #[test]
    fn one_shape_reports_its_own_size_with_rotation_in_the_matrix() {
        let n = node(Rect::new(0.0, 0.0, 100.0, 50.0), Affine::rotate(0.5));
        let [w, h, cx, cy, a, b, c, d, e, f] = selection_rect(&[node_quad(&n, Affine::IDENTITY)]);

        assert!((w - 100.0).abs() < 1e-3, "width is the shape's own: {w}");
        assert!((h - 50.0).abs() < 1e-3, "height is the shape's own: {h}");
        // Rotation is about the shape's own centre, so the centre does not move.
        assert!((cx - 50.0).abs() < 1e-3 && (cy - 25.0).abs() < 1e-3);
        assert!((a - 0.5f64.cos() as f32).abs() < 1e-3);
        assert!((b - 0.5f64.sin() as f32).abs() < 1e-3);
        assert!((c + 0.5f64.sin() as f32).abs() < 1e-3);
        assert!((d - 0.5f64.cos() as f32).abs() < 1e-3);
        assert!((e - cx).abs() < 1e-6 && (f - cy).abs() < 1e-6);
    }

    /// The asymmetry, stated as a test: the *same* rotated shape reports a rotated box alone and
    /// an upright hull once a second shape joins it.
    #[test]
    fn several_shapes_report_an_upright_hull() {
        let rotated = node(Rect::new(0.0, 0.0, 100.0, 50.0), Affine::rotate(0.5));
        let other = node(Rect::new(200.0, 100.0, 260.0, 140.0), Affine::IDENTITY);

        let alone = selection_rect(&[node_quad(&rotated, Affine::IDENTITY)]);
        assert!(alone[5].abs() > 0.1, "alone, the box is rotated");

        let together = selection_rect(&[
            node_quad(&rotated, Affine::IDENTITY),
            node_quad(&other, Affine::IDENTITY),
        ]);
        assert_eq!(
            (together[4], together[5], together[6], together[7]),
            (1.0, 0.0, 0.0, 1.0),
            "the hull is never rotated"
        );
        // The hull must contain the rotated shape's swept extent, not just its selrect.
        let quad = node_quad(&rotated, Affine::IDENTITY);
        let min_x = quad.iter().map(|p| p.x).fold(f64::MAX, f64::min) as f32;
        let hull_left = together[2] - together[0] * 0.5;
        assert!(hull_left <= min_x + 1e-3, "{hull_left} vs {min_x}");
        assert!((together[2] + together[0] * 0.5 - 260.0).abs() < 1e-3);
    }

    /// The selection box must track the *gesture*, not the committed document — otherwise the
    /// handles stay behind while the shape moves under them.
    #[test]
    fn a_modifier_moves_the_reported_box() {
        let n = node(Rect::new(0.0, 0.0, 100.0, 50.0), Affine::IDENTITY);
        let dragged = selection_rect(&[node_quad(&n, Affine::translate((30.0, -10.0)))]);

        assert!((dragged[0] - 100.0).abs() < 1e-3, "a drag does not resize");
        assert!(
            (dragged[2] - 80.0).abs() < 1e-3,
            "centre followed x: {dragged:?}"
        );
        assert!(
            (dragged[3] - 15.0).abs() < 1e-3,
            "centre followed y: {dragged:?}"
        );
    }

    /// A zero-area shape must still produce a finite answer; NaNs are rejected wholesale by the
    /// host, so a degenerate shape would silently show no selection at all.
    #[test]
    fn a_degenerate_shape_stays_finite() {
        let n = node(Rect::new(10.0, 10.0, 10.0, 10.0), Affine::IDENTITY);
        let out = selection_rect(&[node_quad(&n, Affine::IDENTITY)]);
        assert!(out.iter().all(|v| v.is_finite()), "{out:?}");
        assert_eq!((out[4], out[5], out[6], out[7]), (1.0, 0.0, 0.0, 1.0));
    }
}
