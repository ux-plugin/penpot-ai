/**
 * Selection rect preview math for move/rotate drags (overlay sync with WASM modifiers).
 */

import type { SelectionRectResult } from '../types'
import type { Matrix } from 'penpot-exporter/types'

export function finiteSelectionRect(r: SelectionRectResult | null): r is SelectionRectResult {
  return (
    r != null &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    Number.isFinite(r.center.x) &&
    Number.isFinite(r.center.y) &&
    Number.isFinite(r.transform.a) &&
    Number.isFinite(r.transform.b) &&
    Number.isFinite(r.transform.c) &&
    Number.isFinite(r.transform.d)
  )
}

export function cloneSelectionRect(sel: SelectionRectResult): SelectionRectResult {
  return {
    width: sel.width,
    height: sel.height,
    center: { x: sel.center.x, y: sel.center.y },
    transform: { ...sel.transform },
  }
}

export function translateSelectionRectWorld(
  sel: SelectionRectResult,
  dx: number,
  dy: number,
): SelectionRectResult {
  return {
    width: sel.width,
    height: sel.height,
    center: { x: sel.center.x + dx, y: sel.center.y + dy },
    transform: { ...sel.transform },
  }
}

/**
 * Apply a propagated matrix (read from `modifierOverlay.workspaceWasmModifiers`)
 * to a baseline selection rect. Used during gestures to derive the post-flex /
 * post-constraint preview rect without a `querySelectionRect` round-trip.
 *
 * `width` and `height` are propagated as-is — fine for rotation and translation
 * (which preserve edge length) but **not** for resize, where the matrix scales
 * the shape. Resize handlers should keep using `querySelectionRect`.
 */
export function applyMatrixToSelectionRect(
  sel: SelectionRectResult,
  m: Matrix,
): SelectionRectResult {
  const { center, transform } = sel
  const newCenterX = m.a * center.x + m.c * center.y + m.e
  const newCenterY = m.b * center.x + m.d * center.y + m.f
  // Compose 2×2 parts: result = M * T (columns).
  return {
    width: sel.width,
    height: sel.height,
    center: { x: newCenterX, y: newCenterY },
    transform: {
      a: m.a * transform.a + m.c * transform.b,
      b: m.b * transform.a + m.d * transform.b,
      c: m.a * transform.c + m.c * transform.d,
      d: m.b * transform.c + m.d * transform.d,
      e: 0,
      f: 0,
    },
  }
}

/** Rotate selection bounds in world space around pivot (px, py) by deltaDeg (same convention as WASM rotation modifier). */
export function rotateSelectionRectAroundPivot(
  sel: SelectionRectResult,
  px: number,
  py: number,
  deltaDeg: number,
): SelectionRectResult {
  const theta = (deltaDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const { center, transform, width, height } = sel
  const dx = center.x - px
  const dy = center.y - py
  const nx = px + cos * dx - sin * dy
  const ny = py + sin * dx + cos * dy
  const { a: a0, b: b0, c: c0, d: d0 } = transform
  return {
    width,
    height,
    center: { x: nx, y: ny },
    transform: {
      ...transform,
      a: cos * a0 - sin * b0,
      c: cos * c0 - sin * d0,
      b: sin * a0 + cos * b0,
      d: sin * c0 + cos * d0,
    },
  }
}
