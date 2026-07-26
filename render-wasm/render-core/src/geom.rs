//! Backend-neutral 2D geometry atoms, mirroring `skia::{Point, Vector, Rect, Matrix}`.
//!
//! Everything is `f32` to match Skia's precision, and [`Matrix`] uses the exact `SkMatrix`
//! element order so a value round-trips losslessly through the Skia boundary. Method names
//! match the subset render-wasm uses (`scale_x`, `map_point`, `pre_concat`, …) to keep the
//! eventual migration mechanical.

/// A 2D point. `Vector` is the same type, as in Skia.
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Skia aliases `Vector` to `Point`; we do the same so `Vector::new`, `.x`, `.y` all work.
pub type Vector = Point;

impl Point {
    #[inline]
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    /// Vector from `from` to `to` (Skia's `VectorExt::new_points`).
    #[inline]
    pub fn new_points(from: &Point, to: &Point) -> Vector {
        Vector::new(to.x - from.x, to.y - from.y)
    }

    #[inline]
    pub fn distance(&self, other: Point) -> f32 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }

    #[inline]
    pub fn length(&self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    /// A unit-length copy (returns the zero vector if length is ~0).
    #[inline]
    pub fn normalized(&self) -> Vector {
        let len = self.length();
        if len <= f32::EPSILON {
            Vector::new(0.0, 0.0)
        } else {
            Vector::new(self.x / len, self.y / len)
        }
    }

    #[inline]
    pub fn dot(&self, other: Vector) -> f32 {
        self.x * other.x + self.y * other.y
    }
}

impl core::ops::Sub for Point {
    type Output = Vector;
    #[inline]
    fn sub(self, rhs: Point) -> Vector {
        Vector::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl core::ops::Add for Point {
    type Output = Point;
    #[inline]
    fn add(self, rhs: Point) -> Point {
        Point::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl From<(f32, f32)> for Point {
    #[inline]
    fn from((x, y): (f32, f32)) -> Self {
        Point::new(x, y)
    }
}

impl From<Point> for (f32, f32) {
    #[inline]
    fn from(p: Point) -> Self {
        (p.x, p.y)
    }
}

/// An axis-aligned rectangle by edges, mirroring `skia::Rect` (public l/t/r/b fields).
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Rect {
    #[inline]
    pub const fn from_ltrb(left: f32, top: f32, right: f32, bottom: f32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    #[inline]
    pub fn width(&self) -> f32 {
        self.right - self.left
    }

    #[inline]
    pub fn height(&self) -> f32 {
        self.bottom - self.top
    }

    #[inline]
    pub fn center(&self) -> Point {
        Point::new(
            (self.left + self.right) * 0.5,
            (self.top + self.bottom) * 0.5,
        )
    }

    #[inline]
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.left && p.x < self.right && p.y >= self.top && p.y < self.bottom
    }
}

/// A 3x3 transform in `SkMatrix` element order:
/// `[ scaleX skewX transX ; skewY scaleY transY ; persp0 persp1 persp2 ]`, stored row-major.
///
/// Indices: 0=scaleX 1=skewX 2=transX 3=skewY 4=scaleY 5=transY 6=persp0 7=persp1 8=persp2.
#[derive(Debug, Copy, Clone, PartialEq)]
pub struct Matrix {
    m: [f32; 9],
}

impl Default for Matrix {
    #[inline]
    fn default() -> Self {
        Self::identity()
    }
}

impl Matrix {
    #[inline]
    pub const fn identity() -> Self {
        Self {
            m: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
    }

    /// Construct from all nine elements in `SkMatrix::new_all` order.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub const fn new_all(
        scale_x: f32,
        skew_x: f32,
        trans_x: f32,
        skew_y: f32,
        scale_y: f32,
        trans_y: f32,
        persp_0: f32,
        persp_1: f32,
        persp_2: f32,
    ) -> Self {
        Self {
            m: [
                scale_x, skew_x, trans_x, skew_y, scale_y, trans_y, persp_0, persp_1, persp_2,
            ],
        }
    }

    #[inline]
    pub const fn scale(sx: f32, sy: f32) -> Self {
        Self::new_all(sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0)
    }

    #[inline]
    pub const fn translate(tx: f32, ty: f32) -> Self {
        Self::new_all(1.0, 0.0, tx, 0.0, 1.0, ty, 0.0, 0.0, 1.0)
    }

    #[inline]
    pub fn scale_x(&self) -> f32 {
        self.m[0]
    }
    #[inline]
    pub fn skew_x(&self) -> f32 {
        self.m[1]
    }
    #[inline]
    pub fn translate_x(&self) -> f32 {
        self.m[2]
    }
    #[inline]
    pub fn skew_y(&self) -> f32 {
        self.m[3]
    }
    #[inline]
    pub fn scale_y(&self) -> f32 {
        self.m[4]
    }
    #[inline]
    pub fn translate_y(&self) -> f32 {
        self.m[5]
    }

    /// Raw element accessor in `SkMatrix` index order.
    #[inline]
    pub fn get(&self, index: usize) -> f32 {
        self.m[index]
    }

    /// Row-major 3x3 multiply, `out = a * b`.
    #[inline]
    fn mul(a: &[f32; 9], b: &[f32; 9]) -> [f32; 9] {
        let mut out = [0.0f32; 9];
        for r in 0..3 {
            for c in 0..3 {
                out[r * 3 + c] =
                    a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
        }
        out
    }

    /// `self = self * other` (Skia's `pre_concat`). Returns `&mut self` for chaining.
    #[inline]
    pub fn pre_concat(&mut self, other: &Matrix) -> &mut Self {
        self.m = Self::mul(&self.m, &other.m);
        self
    }

    /// `self = other * self` (Skia's `post_concat`). Returns `&mut self` for chaining.
    #[inline]
    pub fn post_concat(&mut self, other: &Matrix) -> &mut Self {
        self.m = Self::mul(&other.m, &self.m);
        self
    }

    /// Map a point through the matrix, applying the perspective divide when present.
    #[inline]
    pub fn map_point(&self, p: Point) -> Point {
        let m = &self.m;
        let x = m[0] * p.x + m[1] * p.y + m[2];
        let y = m[3] * p.x + m[4] * p.y + m[5];
        let w = m[6] * p.x + m[7] * p.y + m[8];
        if w != 0.0 && w != 1.0 {
            Point::new(x / w, y / w)
        } else {
            Point::new(x, y)
        }
    }

    /// Full 3x3 inverse via adjugate / determinant. `None` if singular.
    pub fn invert(&self) -> Option<Matrix> {
        let m = &self.m;
        let c00 = m[4] * m[8] - m[5] * m[7];
        let c01 = m[5] * m[6] - m[3] * m[8];
        let c02 = m[3] * m[7] - m[4] * m[6];
        let det = m[0] * c00 + m[1] * c01 + m[2] * c02;
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let inv_det = 1.0 / det;
        // Adjugate (transpose of the cofactor matrix), scaled by 1/det.
        let inv = [
            c00 * inv_det,
            (m[2] * m[7] - m[1] * m[8]) * inv_det,
            (m[1] * m[5] - m[2] * m[4]) * inv_det,
            c01 * inv_det,
            (m[0] * m[8] - m[2] * m[6]) * inv_det,
            (m[2] * m[3] - m[0] * m[5]) * inv_det,
            c02 * inv_det,
            (m[1] * m[6] - m[0] * m[7]) * inv_det,
            (m[0] * m[4] - m[1] * m[3]) * inv_det,
        ];
        Some(Matrix { m: inv })
    }
}

const THRESHOLD: f32 = 0.001;

#[inline]
pub fn is_close_to(current: f32, value: f32) -> bool {
    (current - value).abs() <= THRESHOLD
}

pub fn are_close_points(a: impl Into<(f32, f32)>, b: impl Into<(f32, f32)>) -> bool {
    let (ax, ay) = a.into();
    let (bx, by) = b.into();
    is_close_to(ax, bx) && is_close_to(ay, by)
}

pub fn is_close_matrix(m: &Matrix, other: &Matrix) -> bool {
    is_close_to(m.scale_x(), other.scale_x())
        && is_close_to(m.scale_y(), other.scale_y())
        && is_close_to(m.translate_x(), other.translate_x())
        && is_close_to(m.translate_y(), other.translate_y())
        && is_close_to(m.skew_x(), other.skew_x())
        && is_close_to(m.skew_y(), other.skew_y())
}

pub fn identitish(m: &Matrix) -> bool {
    is_close_to(m.scale_x(), 1.0)
        && is_close_to(m.scale_y(), 1.0)
        && is_close_to(m.translate_x(), 0.0)
        && is_close_to(m.translate_y(), 0.0)
        && is_close_to(m.skew_x(), 0.0)
        && is_close_to(m.skew_y(), 0.0)
}

pub fn is_move_only_matrix(m: &Matrix) -> bool {
    is_close_to(m.scale_x(), 1.0)
        && is_close_to(m.scale_y(), 1.0)
        && is_close_to(m.skew_x(), 0.0)
        && is_close_to(m.skew_y(), 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-4, "{a} != {b}");
    }

    #[test]
    fn identity_maps_point_unchanged() {
        let m = Matrix::identity();
        let p = m.map_point(Point::new(3.0, -7.0));
        approx(p.x, 3.0);
        approx(p.y, -7.0);
    }

    #[test]
    fn translate_and_scale_map_point() {
        let t = Matrix::translate(10.0, 20.0);
        let p = t.map_point(Point::new(1.0, 2.0));
        approx(p.x, 11.0);
        approx(p.y, 22.0);

        let s = Matrix::scale(2.0, 3.0);
        let q = s.map_point(Point::new(4.0, 5.0));
        approx(q.x, 8.0);
        approx(q.y, 15.0);
    }

    #[test]
    fn element_accessors_match_new_all_order() {
        // scaleX, skewX, transX, skewY, scaleY, transY, p0, p1, p2
        let m = Matrix::new_all(2.0, 0.5, 10.0, 0.25, 3.0, 20.0, 0.0, 0.0, 1.0);
        approx(m.scale_x(), 2.0);
        approx(m.skew_x(), 0.5);
        approx(m.translate_x(), 10.0);
        approx(m.skew_y(), 0.25);
        approx(m.scale_y(), 3.0);
        approx(m.translate_y(), 20.0);
    }

    #[test]
    fn pre_concat_is_self_times_other() {
        // Translate then scale: pre_concat(scale) => point is scaled first, then translated.
        let mut m = Matrix::translate(100.0, 100.0);
        m.pre_concat(&Matrix::scale(2.0, 2.0));
        let p = m.map_point(Point::new(1.0, 1.0));
        approx(p.x, 102.0);
        approx(p.y, 102.0);
    }

    #[test]
    fn post_concat_is_other_times_self() {
        // post_concat(M) makes M the OUTER (last-applied) transform: self = M * self.
        // scale first (1,1)->(2,2), then translate (+5,+5) -> (7,7).
        let mut m = Matrix::scale(2.0, 2.0);
        m.post_concat(&Matrix::translate(5.0, 5.0));
        let p = m.map_point(Point::new(1.0, 1.0));
        approx(p.x, 7.0);
        approx(p.y, 7.0);
    }

    #[test]
    fn invert_round_trips() {
        let mut m = Matrix::scale(2.0, 4.0);
        m.pre_concat(&Matrix::translate(3.0, -5.0));
        let inv = m.invert().expect("invertible");
        let p = Point::new(9.0, 11.0);
        let mapped = m.map_point(p);
        let back = inv.map_point(mapped);
        approx(back.x, p.x);
        approx(back.y, p.y);
    }

    #[test]
    fn singular_matrix_has_no_inverse() {
        assert!(Matrix::scale(0.0, 0.0).invert().is_none());
    }

    #[test]
    fn rect_dims_and_center() {
        let r = Rect::from_ltrb(10.0, 20.0, 40.0, 80.0);
        approx(r.width(), 30.0);
        approx(r.height(), 60.0);
        let c = r.center();
        approx(c.x, 25.0);
        approx(c.y, 50.0);
    }

    #[test]
    fn vector_helpers() {
        let a = Point::new(0.0, 0.0);
        let b = Point::new(3.0, 4.0);
        approx(a.distance(b), 5.0);
        let v = Vector::new_points(&a, &b);
        approx(v.length(), 5.0);
        let n = v.normalized();
        approx(n.length(), 1.0);
    }
}
