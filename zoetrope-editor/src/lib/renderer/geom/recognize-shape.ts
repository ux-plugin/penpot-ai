/**
 * Recognize a primitive shape from a path's segments — the inverse of the
 * `shapeOutline` generator and the second half of the matched pair.
 *
 * Strategy: normalize the path into its unit bounding box, then for each
 * candidate kind regenerate the canonical unit outline with `shapeOutline` and
 * compare. Using the forward generator as the oracle makes the round-trip exact
 * by construction: `recognizeShape(toSegments(shapeOutline(kind, p))) === kind`.
 *
 * Tolerance is tight (≈0.1% of the bounding box) — enough to absorb float drift
 * from the trig/bézier generators and minor import rounding, but far from the
 * "1°" that would let a visibly-skewed quad read as a rectangle. Recognition
 * runs in the shape's local/unit space, so translation never enters the test.
 *
 * Scope: recognizes the canonical (axis-aligned-in-bbox) forms the tools emit.
 * Rotated paths bake their rotation into content (see applyTransformToNode), so
 * recognizing an arbitrary rotated primitive is a follow-up.
 */

import type { PathSegment } from '../types'
import { shapeOutline, type ParametricShapeKind } from './primitives'

export type RecognizedKind = 'line' | 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'star'

export interface RecognizedShape {
  kind: RecognizedKind
  params: { sides?: number; points?: number; innerRatio?: number }
}

interface Pt {
  x: number
  y: number
}

interface SelrectLike {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** Unit-space match tolerance (~0.1% of the bounding box). */
const TOL = 1e-3

/** Anchor (move/line/curve endpoint) coordinates, in order. */
function anchorPoints(segments: PathSegment[]): Pt[] {
  const pts: Pt[] = []
  for (const s of segments) {
    if (s.type === 'move-to' || s.type === 'line-to' || s.type === 'curve-to') {
      pts.push({ x: s.x, y: s.y })
    }
  }
  return pts
}

/** Drop a trailing anchor that coincides with the first (closed-ring artifact). */
function dropClosingDuplicate(pts: Pt[]): Pt[] {
  if (pts.length > 1) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
      return pts.slice(0, -1)
    }
  }
  return pts
}

/** Canonical unit-box anchors for a generated kind. */
function unitAnchors(kind: ParametricShapeKind, params: Record<string, number> = {}): Pt[] {
  return dropClosingDuplicate(
    anchorPoints(shapeOutline(kind, { width: 1, height: 1, ...params })),
  )
}

/** True if `a` matches `b` (same length) under any cyclic rotation, within tol. */
function matchCyclic(a: Pt[], b: Pt[], tol: number): boolean {
  const n = a.length
  if (n !== b.length || n === 0) return false
  for (let shift = 0; shift < n; shift++) {
    let ok = true
    for (let i = 0; i < n; i++) {
      const p = a[i]
      const q = b[(i + shift) % n]
      if (Math.abs(p.x - q.x) > tol || Math.abs(p.y - q.y) > tol) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Recover a star's inner/outer radius ratio from its unit vertices. */
function recoverStarRatio(unit: Pt[]): number | null {
  let cx = 0
  let cy = 0
  for (const p of unit) {
    cx += p.x
    cy += p.y
  }
  cx /= unit.length
  cy /= unit.length
  let minR = Infinity
  let maxR = -Infinity
  for (const p of unit) {
    const r = Math.hypot(p.x - cx, p.y - cy)
    if (r < minR) minR = r
    if (r > maxR) maxR = r
  }
  if (maxR <= 1e-9) return null
  return minR / maxR
}

/**
 * Classify a path. Returns the recognized kind + params (in the matched-pair
 * parameterization), or null if the geometry isn't one of the primitives.
 */
export function recognizeShape(
  segments: PathSegment[],
  selrect: SelrectLike,
): RecognizedShape | null {
  if (!Array.isArray(segments) || segments.length === 0) return null

  // More than one sub-path (move-to) → a compound path or vector network, never a
  // single primitive. Bail so a junction/compound shape stays a plain path.
  if (segments.filter((s) => s.type === 'move-to').length > 1) return null

  const closed = segments.some((s) => s.type === 'close-path')
  const curveCount = segments.filter((s) => s.type === 'curve-to').length
  const ox = selrect.x ?? 0
  const oy = selrect.y ?? 0
  const local = dropClosingDuplicate(anchorPoints(segments)).map((p) => ({
    x: p.x - ox,
    y: p.y - oy,
  }))

  // Line: an open, straight, two-point path (handled before normalization so a
  // perfectly axis-aligned line with a zero-height bbox still classifies).
  if (!closed && curveCount === 0 && local.length === 2) {
    return { kind: 'line', params: {} }
  }

  const w = selrect.width ?? 0
  const h = selrect.height ?? 0
  if (!(w > 0) || !(h > 0)) return null
  const unit = local.map((p) => ({ x: p.x / w, y: p.y / h }))

  // Ellipse: closed, four cubic béziers at the bbox mid-edges.
  if (closed && curveCount === 4 && unit.length === 4) {
    if (matchCyclic(unit, unitAnchors('ellipse'), TOL)) {
      return { kind: 'ellipse', params: {} }
    }
  }

  if (closed && curveCount === 0) {
    const n = unit.length

    // Rect before polygon(4): a square's corners would also satisfy a regular
    // 4-gon, but rect is the more specific reading.
    if (n === 4 && matchCyclic(unit, unitAnchors('rect'), TOL)) {
      return { kind: 'rect', params: {} }
    }
    // Triangle before polygon(3): the bbox-filling apex-up triangle is a
    // distinct form from a regular 3-gon.
    if (n === 3 && matchCyclic(unit, unitAnchors('triangle'), TOL)) {
      return { kind: 'triangle', params: {} }
    }
    if (n >= 3 && matchCyclic(unit, unitAnchors('polygon', { sides: n }), TOL)) {
      return { kind: 'polygon', params: { sides: n } }
    }
    if (n >= 4 && n % 2 === 0) {
      const ratio = recoverStarRatio(unit)
      if (ratio !== null) {
        const points = n / 2
        if (matchCyclic(unit, unitAnchors('star', { points, innerRatio: ratio }), TOL)) {
          return { kind: 'star', params: { points, innerRatio: Math.round(ratio * 1000) / 1000 } }
        }
      }
    }
  }

  return null
}
