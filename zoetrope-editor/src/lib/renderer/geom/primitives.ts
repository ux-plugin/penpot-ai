/**
 * Parametric primitive outlines — the forward half of the matched pair that
 * drives path-composition shapes. `shapeOutline(kind, params)` turns a shape's
 * semantic parameters into a path segment list in **local** coordinates
 * (origin at 0,0, extent `width × height`); the inverse `recognizeShape`
 * (added with the recognizer) recovers the same parameters from segments.
 *
 * Tools that have a native Penpot type (rect, circle/ellipse) don't draw
 * through here — they keep their native node. The generators for `rect` and
 * `ellipse` exist so the forward/inverse round-trip can be unit-tested across
 * every kind with one code path.
 */

import type { PathSegment } from '../types'

/** Shapes that commit to a `path` node (no native Penpot type). */
export type PathShapeKind = 'line' | 'triangle' | 'polygon' | 'star'

/** Every kind the generator understands, including the natively-stored ones. */
export type ParametricShapeKind = PathShapeKind | 'rect' | 'ellipse'

export interface OutlineParams {
  /** Local bounding-box width (≥ 0). */
  width: number
  /** Local bounding-box height (≥ 0). */
  height: number
  /** Polygon vertex count (default 6). Ignored by other kinds. */
  sides?: number
  /** Star point count (default 5). Ignored by other kinds. */
  points?: number
  /** Star inner/outer radius ratio in (0,1) (default 0.5). */
  innerRatio?: number
}

const DEFAULT_POLYGON_SIDES = 6
const DEFAULT_STAR_POINTS = 5
const DEFAULT_STAR_INNER_RATIO = 0.5

/** Point on the ellipse inscribed in the bbox, `angle` in radians. */
function inscribed(width: number, height: number, angle: number): { x: number; y: number } {
  const rx = width / 2
  const ry = height / 2
  return { x: rx + rx * Math.cos(angle), y: ry + ry * Math.sin(angle) }
}

/** Close a ring of anchor points into move-to + line-to* + close-path. */
function ring(pts: Array<{ x: number; y: number }>): PathSegment[] {
  if (pts.length === 0) return []
  const segs: PathSegment[] = [{ type: 'move-to', x: pts[0].x, y: pts[0].y }]
  for (let i = 1; i < pts.length; i++) {
    segs.push({ type: 'line-to', x: pts[i].x, y: pts[i].y })
  }
  segs.push({ type: 'close-path' })
  return segs
}

/** N points evenly placed on the inscribed ellipse, starting at the top (-90°). */
function regularRing(width: number, height: number, n: number): Array<{ x: number; y: number }> {
  const start = -Math.PI / 2
  const step = (2 * Math.PI) / n
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < n; i++) {
    pts.push(inscribed(width, height, start + i * step))
  }
  return pts
}

/**
 * Build the local-space outline for a parametric shape.
 *
 * - `line` is an open segment along the bbox diagonal (top-left → bottom-right).
 * - `triangle` is an apex-up isosceles triangle filling the bbox.
 * - `polygon` / `star` inscribe their vertices in the bbox ellipse so a
 *   non-square drag yields a stretched (but regular-in-ratio) shape.
 * - `rect` / `ellipse` mirror how the native nodes look as paths (used for
 *   recognition round-trip tests, not for the drawing tools).
 */
export function shapeOutline(kind: ParametricShapeKind, params: OutlineParams): PathSegment[] {
  const { width: w, height: h } = params

  switch (kind) {
    case 'line':
      return [
        { type: 'move-to', x: 0, y: 0 },
        { type: 'line-to', x: w, y: h },
      ]

    case 'triangle':
      return ring([
        { x: w / 2, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ])

    case 'polygon': {
      const n = Math.max(3, Math.round(params.sides ?? DEFAULT_POLYGON_SIDES))
      return ring(regularRing(w, h, n))
    }

    case 'star': {
      const n = Math.max(2, Math.round(params.points ?? DEFAULT_STAR_POINTS))
      const ratio = Math.min(0.999, Math.max(0.001, params.innerRatio ?? DEFAULT_STAR_INNER_RATIO))
      const rx = w / 2
      const ry = h / 2
      const start = -Math.PI / 2
      const step = Math.PI / n
      const pts: Array<{ x: number; y: number }> = []
      for (let i = 0; i < 2 * n; i++) {
        const angle = start + i * step
        const k = i % 2 === 0 ? 1 : ratio
        pts.push({ x: rx + rx * k * Math.cos(angle), y: ry + ry * k * Math.sin(angle) })
      }
      return ring(pts)
    }

    case 'rect':
      return ring([
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ])

    case 'ellipse': {
      // Four cubic béziers with the circle-approximation constant.
      const KAPPA = 0.5522847498307936
      const rx = w / 2
      const ry = h / 2
      const cx = rx
      const cy = ry
      const ox = rx * KAPPA
      const oy = ry * KAPPA
      return [
        { type: 'move-to', x: cx, y: 0 },
        { type: 'curve-to', c1x: cx + ox, c1y: 0, c2x: w, c2y: cy - oy, x: w, y: cy },
        { type: 'curve-to', c1x: w, c1y: cy + oy, c2x: cx + ox, c2y: h, x: cx, y: h },
        { type: 'curve-to', c1x: cx - ox, c1y: h, c2x: 0, c2y: cy + oy, x: 0, y: cy },
        { type: 'curve-to', c1x: 0, c1y: cy - oy, c2x: cx - ox, c2y: 0, x: cx, y: 0 },
        { type: 'close-path' },
      ]
    }
  }
}

/**
 * Translate every segment coordinate by `(dx, dy)`. render-wasm builds the skia
 * path straight from segment coordinates with no selrect offset (Penpot stores
 * path content in absolute coordinates), so a path node's segments must be in
 * world space — generators emit local (0,0)-origin outlines, and the factory
 * shifts them to the shape's world origin with this.
 */
export function translateSegments(
  segments: PathSegment[],
  dx: number,
  dy: number
): PathSegment[] {
  return segments.map((s) => {
    switch (s.type) {
      case 'move-to':
      case 'line-to':
        return { ...s, x: s.x + dx, y: s.y + dy }
      case 'curve-to':
        return {
          ...s,
          x: s.x + dx,
          y: s.y + dy,
          c1x: s.c1x + dx,
          c1y: s.c1y + dy,
          c2x: s.c2x + dx,
          c2y: s.c2y + dy,
        }
      case 'close-path':
        return s
    }
  })
}

/**
 * World-space anchor points (move-to / line-to / curve-to endpoints) for an
 * outline placed at `(originX, originY)`. Path selection in the worker tests
 * `shape.points` before the precise path hit-test, so every path node needs
 * this hull populated.
 */
export function outlineWorldPoints(
  segments: PathSegment[],
  originX: number,
  originY: number
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  for (const s of segments) {
    if (s.type === 'move-to' || s.type === 'line-to' || s.type === 'curve-to') {
      pts.push({ x: originX + s.x, y: originY + s.y })
    }
  }
  return pts
}
