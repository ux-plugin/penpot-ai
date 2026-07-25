//! The Skia backend's boundary to the backend-neutral kurbo/peniko types that `render-core`
//! re-exports.
//!
//! `render-core` never depends on Skia (so it also compiles for a Vello/wasm-bindgen module).
//! This module is where the *Skia* backend converts to and from those neutral types. As the
//! model migrates onto `render-core` (see docs/vello-backend-plan.md, Phase 1), call sites
//! that still hand geometry to Skia go through here.
//!
//! Two things to keep in mind:
//!
//! 1. **Precision.** kurbo is f64, Skia is f32. Skia -> core widens exactly; core -> Skia
//!    rounds. The pipeline runs Skia -> core -> Vello, so the lossy direction exists only for
//!    symmetry and for call sites that round-trip.
//! 2. **Matrix element order.** Skia is row-major
//!    (`x' = scale_x*x + skew_x*y + translate_x`), kurbo's `Affine::new([a,b,c,d,e,f])` is
//!    column-major (`x' = a*x + c*y + e`). So `b` is Skia's *skew_y* and `c` is its *skew_x* —
//!    swapping them is a silent shear. `affine_round_trips` pins this down.
//!
//! Matrix conversion is affine-only (persp = [0,0,1]), which holds for all Penpot transforms.

// Boundary helpers land ahead of the call sites that will use them during the migration.
#![allow(dead_code)]

use render_core::kurbo;
use render_core::peniko;
use skia_safe as skia;

#[inline]
pub fn point_to_core(p: skia::Point) -> kurbo::Point {
    kurbo::Point::new(p.x as f64, p.y as f64)
}

#[inline]
pub fn point_to_skia(p: kurbo::Point) -> skia::Point {
    skia::Point::new(p.x as f32, p.y as f32)
}

#[inline]
pub fn rect_to_core(r: skia::Rect) -> kurbo::Rect {
    kurbo::Rect::new(
        r.left as f64,
        r.top as f64,
        r.right as f64,
        r.bottom as f64,
    )
}

#[inline]
pub fn rect_to_skia(r: kurbo::Rect) -> skia::Rect {
    skia::Rect::from_ltrb(r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32)
}

/// Skia (row-major, affine rows) -> kurbo (column-major `[a,b,c,d,e,f]`).
#[inline]
pub fn affine_to_core(m: &skia::Matrix) -> kurbo::Affine {
    kurbo::Affine::new([
        m.scale_x() as f64,
        m.skew_y() as f64,
        m.skew_x() as f64,
        m.scale_y() as f64,
        m.translate_x() as f64,
        m.translate_y() as f64,
    ])
}

/// kurbo -> Skia, affine only (perspective row forced to `[0, 0, 1]`).
#[inline]
pub fn affine_to_skia(a: &kurbo::Affine) -> skia::Matrix {
    let [sx, ky, kx, sy, tx, ty] = a.as_coeffs();
    skia::Matrix::new_all(
        sx as f32, kx as f32, tx as f32, ky as f32, sy as f32, ty as f32, 0.0, 0.0, 1.0,
    )
}

#[inline]
pub fn color_to_core(c: skia::Color) -> peniko::Color {
    peniko::Color::from_rgba8(c.r(), c.g(), c.b(), c.a())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_round_trips() {
        let r = skia::Rect::from_ltrb(10.0, 20.0, 40.0, 80.0);
        assert_eq!(rect_to_skia(rect_to_core(r)), r);
    }

    /// The element-order trap: a matrix with *different* skew_x and skew_y must survive the
    /// round trip. Symmetric fixtures would pass even with the two swapped.
    #[test]
    fn affine_round_trips() {
        let m = skia::Matrix::new_all(2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 0.0, 0.0, 1.0);
        let core = affine_to_core(&m);

        // Column-major: [scale_x, skew_y, skew_x, scale_y, translate_x, translate_y].
        assert_eq!(core.as_coeffs(), [2.0, 7.0, 3.0, 11.0, 5.0, 13.0]);

        let back = affine_to_skia(&core);
        assert_eq!(back.scale_x(), 2.0);
        assert_eq!(back.skew_x(), 3.0);
        assert_eq!(back.translate_x(), 5.0);
        assert_eq!(back.skew_y(), 7.0);
        assert_eq!(back.scale_y(), 11.0);
        assert_eq!(back.translate_y(), 13.0);
    }

    /// Both matrices must map a point the same way — the check that actually catches a shear.
    #[test]
    fn affine_maps_points_identically() {
        let m = skia::Matrix::new_all(2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 0.0, 0.0, 1.0);
        let core = affine_to_core(&m);

        let p = skia::Point::new(1.5, -2.25);
        let via_skia = m.map_point(p);
        let via_core = core * point_to_core(p);

        assert_eq!(via_skia.x, via_core.x as f32);
        assert_eq!(via_skia.y, via_core.y as f32);
    }

    #[test]
    fn color_converts_channelwise() {
        let c = color_to_core(skia::Color::from_argb(255, 10, 20, 30));
        assert_eq!(c, peniko::Color::from_rgba8(10, 20, 30, 255));
    }
}
