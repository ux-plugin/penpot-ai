//! The Skia backend's boundary to the backend-neutral [`render_core::geom`] types.
//!
//! `render-core` never depends on Skia (so it also compiles for a Vello/wasm-bindgen
//! module). This module is where the *Skia* backend converts to and from those neutral
//! types. As the model migrates onto `render-core` (see docs/vello-backend-plan.md, Phase 1),
//! call sites that still hand geometry to Skia go through here.
//!
//! Matrix conversion is affine-only (persp = [0,0,1]), which holds for all Penpot
//! transforms; the neutral `Matrix` keeps the full 3x3 for generality.

// Boundary helpers land ahead of the call sites that will use them during the migration.
#![allow(dead_code)]

use render_core::geom as core_geom;
use skia_safe as skia;

#[inline]
pub fn point_to_core(p: skia::Point) -> core_geom::Point {
    core_geom::Point::new(p.x, p.y)
}

#[inline]
pub fn point_to_skia(p: core_geom::Point) -> skia::Point {
    skia::Point::new(p.x, p.y)
}

#[inline]
pub fn rect_to_core(r: skia::Rect) -> core_geom::Rect {
    core_geom::Rect::from_ltrb(r.left, r.top, r.right, r.bottom)
}

#[inline]
pub fn rect_to_skia(r: core_geom::Rect) -> skia::Rect {
    skia::Rect::from_ltrb(r.left, r.top, r.right, r.bottom)
}

#[inline]
pub fn matrix_to_core(m: &skia::Matrix) -> core_geom::Matrix {
    core_geom::Matrix::new_all(
        m.scale_x(),
        m.skew_x(),
        m.translate_x(),
        m.skew_y(),
        m.scale_y(),
        m.translate_y(),
        0.0,
        0.0,
        1.0,
    )
}

#[inline]
pub fn matrix_to_skia(m: &core_geom::Matrix) -> skia::Matrix {
    skia::Matrix::new_all(
        m.scale_x(),
        m.skew_x(),
        m.translate_x(),
        m.skew_y(),
        m.scale_y(),
        m.translate_y(),
        0.0,
        0.0,
        1.0,
    )
}
