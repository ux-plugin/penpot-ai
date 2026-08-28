//! Curve-native 2D boolean operations on [`kurbo::BezPath`], backed by the
//! [`linesweeper`] robust sweep-line engine.
//!
//! The whole point of this crate is that béziers stay béziers: unlike a polygon
//! clipper it never flattens curves to line soup and never has to re-fit them
//! afterward. Inputs and outputs are `kurbo::BezPath`, so the caller converts its
//! own segment model at the boundary and nothing here knows about Skia, the DOM,
//! or the renderer. That keeps it usable by the Skia backend today and a Vello
//! backend later with no change.

use kurbo::{BezPath, PathEl};
use linesweeper::{binary_op, BinaryOp, FillRule};

pub use kurbo;

/// The boolean to compute, mirroring the editor's four bool types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoolOp {
    /// Everything covered by either operand.
    Union,
    /// `subject` with `clip` cut out of it — the eraser's operation.
    Difference,
    /// Only the region covered by both operands.
    Intersection,
    /// Covered by exactly one operand (symmetric difference).
    Exclude,
}

impl From<BoolOp> for BinaryOp {
    fn from(op: BoolOp) -> Self {
        match op {
            BoolOp::Union => BinaryOp::Union,
            BoolOp::Difference => BinaryOp::Difference,
            BoolOp::Intersection => BinaryOp::Intersection,
            BoolOp::Exclude => BinaryOp::Xor,
        }
    }
}

/// How nested/overlapping input contours decide what counts as "inside".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fill {
    /// Winding-number fill (the renderer's default).
    NonZero,
    /// Parity fill; nested rings alternate solid/hole regardless of direction.
    EvenOdd,
}

impl From<Fill> for FillRule {
    fn from(f: Fill) -> Self {
        match f {
            Fill::NonZero => FillRule::NonZero,
            Fill::EvenOdd => FillRule::EvenOdd,
        }
    }
}

/// Compute `subject OP clip`, curve-native.
///
/// Either argument may hold several sub-paths (a compound fill with holes, a
/// multi-piece brush band); each is treated as a closed region. The result is a
/// list of closed contours (outer rings and hole rings, per the engine's own
/// winding). Returns an empty vec if the engine fails on degenerate input, so the
/// caller can treat that as a no-op rather than a panic.
pub fn path_boolean(subject: &BezPath, clip: &BezPath, op: BoolOp, fill: Fill) -> Vec<BezPath> {
    let a = force_closed(subject);
    let b = force_closed(clip);
    match binary_op(&a, &b, fill.into(), op.into()) {
        Ok(contours) => contours.contours().map(|c| c.path.clone()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Ensure every sub-path is explicitly closed. Booleans are defined on closed
/// regions; an open ring reaching the engine would be dropped or mis-filled, so a
/// dangling sub-path gets its closing edge here.
fn force_closed(path: &BezPath) -> BezPath {
    let mut out = BezPath::new();
    let mut open = false;
    for el in path.elements() {
        match el {
            PathEl::MoveTo(p) => {
                if open {
                    out.close_path();
                }
                out.move_to(*p);
                open = true;
            }
            PathEl::ClosePath => {
                out.close_path();
                open = false;
            }
            other => out.push(*other),
        }
    }
    if open {
        out.close_path();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::{Rect, Shape};

    fn total_abs_area(paths: &[BezPath]) -> f64 {
        paths.iter().map(|p| p.area()).sum::<f64>().abs()
    }

    #[test]
    fn difference_interior_makes_hole() {
        let outer = Rect::new(0.0, 0.0, 100.0, 100.0).into_path(0.01);
        let inner = Rect::new(40.0, 40.0, 60.0, 60.0).into_path(0.01);
        let res = path_boolean(&outer, &inner, BoolOp::Difference, Fill::NonZero);
        assert!(res.len() >= 2, "interior cut should yield outer + hole, got {}", res.len());
        assert!((total_abs_area(&res) - 9600.0).abs() < 1.0, "area {}", total_abs_area(&res));
    }

    #[test]
    fn difference_edge_bite_reduces_area() {
        let sq = Rect::new(0.0, 0.0, 100.0, 100.0).into_path(0.01);
        let bite = Rect::new(80.0, 80.0, 140.0, 140.0).into_path(0.01);
        let res = path_boolean(&sq, &bite, BoolOp::Difference, Fill::NonZero);
        assert!((total_abs_area(&res) - 9600.0).abs() < 1.0, "area {}", total_abs_area(&res));
    }

    #[test]
    fn full_cover_erases_to_nothing() {
        let sq = Rect::new(0.0, 0.0, 100.0, 100.0).into_path(0.01);
        let cover = Rect::new(-10.0, -10.0, 110.0, 110.0).into_path(0.01);
        let res = path_boolean(&sq, &cover, BoolOp::Difference, Fill::NonZero);
        assert!(total_abs_area(&res) < 1.0, "expected nothing left, area {}", total_abs_area(&res));
    }

    #[test]
    fn union_merges_overlap() {
        let a = Rect::new(0.0, 0.0, 100.0, 100.0).into_path(0.01);
        let b = Rect::new(50.0, 0.0, 150.0, 100.0).into_path(0.01);
        let res = path_boolean(&a, &b, BoolOp::Union, Fill::NonZero);
        assert!((total_abs_area(&res) - 15000.0).abs() < 1.0, "area {}", total_abs_area(&res));
    }
}
