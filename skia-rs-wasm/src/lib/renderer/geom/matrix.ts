/**
 * 2D affine matrix utilities.
 */

import type { Matrix } from 'penpot-exporter/types'

export const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function translateMatrix(dx: number, dy: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }
}

/** Identity matrix. Rust `propagate_modifiers` converts identitish entries into reflow signals. */
export function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

/** Compose two affine matrices: (m1 ∘ m2) applies m2 first, then m1. */
export function composeMatrix(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

/**
 * Resize matrix in the shape's own frame: T · S(localOrigin) · T⁻¹. Scales by
 * (sx, sy) around the local anchor offset (localOx, localOy) from the shape
 * center (shapeCx, shapeCy). When T = identity this degenerates to an
 * axis-aligned scale. Shared by the canvas resize handler and the sidebar
 * geometry commit so the two can't diverge.
 */
export function buildResizeMatrix(
  T: Matrix,
  Tinv: Matrix,
  sx: number,
  sy: number,
  shapeCx: number,
  shapeCy: number,
  localOx: number,
  localOy: number
): Matrix {
  const Aa = sx * T.a * Tinv.a + sy * T.c * Tinv.b
  const Ab = sx * T.b * Tinv.a + sy * T.d * Tinv.b
  const Ac = sx * T.a * Tinv.c + sy * T.c * Tinv.d
  const Ad = sx * T.b * Tinv.c + sy * T.d * Tinv.d
  const woX = shapeCx + T.a * localOx + T.c * localOy
  const woY = shapeCy + T.b * localOx + T.d * localOy
  return {
    a: Aa,
    b: Ab,
    c: Ac,
    d: Ad,
    e: (1 - Aa) * woX - Ac * woY,
    f: (1 - Ad) * woY - Ab * woX,
  }
}

/** Rotation (degrees CCW) around world point (cx, cy); matches WASM modifier convention. */
export function rotationMatrixAroundPoint(cx: number, cy: number, angleDeg: number): Matrix {
  const theta = (angleDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx * (1 - cos) + cy * sin,
    f: cy * (1 - cos) - cx * sin,
  }
}

/** Full 6-component inverse matching Clojure's gmt/inverse. Returns null if singular. */
export function invertMatrix(T: Matrix): Matrix | null {
  const det = T.a * T.d - T.b * T.c
  if (Math.abs(det) < 1e-10) return null
  return {
    a: T.d / det,
    b: -T.b / det,
    c: -T.c / det,
    d: T.a / det,
    e: (T.c * T.f - T.d * T.e) / det,
    f: (T.b * T.e - T.a * T.f) / det,
  }
}
