/**
 * Overlap detection algorithms for shapes
 */

import type {
  Point,
  PenpotNode,
  Selrect,
  BoolShape,
  PathShape,
  TextShape,
  Matrix,
} from 'penpot-exporter/types'
import type { Line } from '../types'
import { makeSelrect } from '@skia-rs-wasm/common/conversions'
import { rectToPoints, overlapsRects } from './rect'
import { point } from './point'

/** Shape with ellipse geometry (CircleShape or synthetic bounds for stroke band). */
type EllipseGeometry = {
  x: number
  y: number
  width: number
  height: number
  selrect?: Selrect
  transform?: Matrix
}

function inverseTransformPoint(world: Point, t: Matrix): Point {
  const det = t.a * t.d - t.b * t.c
  if (Math.abs(det) < EPSILON) return world
  const px = world.x - t.e
  const py = world.y - t.f
  return point(
    (t.d * px - t.c * py) / det,
    (-t.b * px + t.a * py) / det
  )
}

const EPSILON = 1e-10

/** AABB of a query rect mapped by the INVERSE of an affine (world query -> rest space). */
function inverseTransformRect(rect: Selrect, t: Matrix): Selrect {
  const corners: Point[] = [
    point(rect.x, rect.y),
    point(rect.x + rect.width, rect.y),
    point(rect.x + rect.width, rect.y + rect.height),
    point(rect.x, rect.y + rect.height),
  ]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of corners) {
    const p = inverseTransformPoint(c, t)
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return makeSelrect(minX, minY, maxX - minX, maxY - minY)
}

function almostZero(value: number): boolean {
  return Math.abs(value) < EPSILON
}

function isIdentityTransform(t: Matrix | null | undefined): boolean {
  if (!t) return true
  return (
    Math.abs(t.a - 1) < EPSILON &&
    Math.abs(t.b) < EPSILON &&
    Math.abs(t.c) < EPSILON &&
    Math.abs(t.d - 1) < EPSILON &&
    Math.abs(t.e) < EPSILON &&
    Math.abs(t.f) < EPSILON
  )
}

function sq(value: number): number {
  return value * value
}

function sqrt(value: number): number {
  return Math.sqrt(value)
}

type Orientation = 'clockwise' | 'counter-clockwise' | 'coplanar'

function orientation(p1: Point, p2: Point, p3: Point): Orientation {
  const v = (p2.y - p1.y) * (p3.x - p2.x) - (p3.y - p2.y) * (p2.x - p1.x)
  if (v > 0) return 'clockwise'
  if (v < 0) return 'counter-clockwise'
  return 'coplanar'
}

function onSegment(q: Point, p: Point, r: Point): boolean {
  return (
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y)
  )
}

function intersectSegments([p1, q1]: Line, [p2, q2]: Line): boolean {
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)

  return (
    // General case
    (o1 !== o2 && o3 !== o4) ||
    // p1, q1 and p2 colinear and p2 lies on p1q1
    (o1 === 'coplanar' && onSegment(p2, p1, q1)) ||
    // p1, q1 and q2 colinear and q2 lies on p1q1
    (o2 === 'coplanar' && onSegment(q2, p1, q1)) ||
    // p2, q2 and p1 colinear and p1 lies on p2q2
    (o3 === 'coplanar' && onSegment(p1, p2, q2)) ||
    // p2, q2 and p1 colinear and q1 lies on p2q2
    (o4 === 'coplanar' && onSegment(q1, p2, q2))
  )
}

export function pointsToLines(points: Point[], closed: boolean = true): Line[] {
  if (points.length === 0) {
    return []
  }

  const lines: Line[] = []
  for (let i = 0; i < points.length; i++) {
    const next = closed && i === points.length - 1 ? 0 : i + 1
    if (next < points.length) {
      lines.push([points[i], points[next]])
    }
  }
  return lines
}

export function intersectsLines(linesA: Line[], linesB: Line[]): boolean {
  for (const curLine of linesA) {
    for (const lineB of linesB) {
      if (intersectSegments(curLine, lineB)) {
        return true
      }
    }
  }
  return false
}

function intersectRay(p: Point, [p1, p2]: Line): boolean {
  const { x: px, y: py } = p
  const { x: x1, y: y1 } = p1
  const { x: x2, y: y2 } = p2

  if ((y1 <= py && y2 > py) || (y1 > py && y2 <= py)) {
    const vt = (py - y1) / (y2 - y1)
    const ix = x1 + vt * (x2 - x1)
    return px < ix
  }

  return false
}

export function isPointInsideEvenOdd(p: Point, lines: Line[]): boolean {
  // Even-odd algorithm: cast a ray and count intersections
  // if odd, point is inside
  const intersections = lines.filter(line => intersectRay(p, line))
  return intersections.length % 2 === 1
}

function nextWindup(wn: number, p: Point, [p1, p2]: Line): number {
  const lineSide = (p2.x - p1.x) * (p.y - p1.y) - (p.x - p1.x) * (p2.y - p1.y)

  if (p1.y <= p.y) {
    // Upward crossing
    if (p2.y > p.y && lineSide > 0) {
      return wn + 1
    }
    return wn
  } else {
    // Downward crossing
    if (p2.y <= p.y && lineSide < 0) {
      return wn - 1
    }
    return wn
  }
}

function isPointInsideNonzero(p: Point, lines: Line[]): boolean {
  // Non-zero winding number
  let wn = 0
  for (const line of lines) {
    wn = nextWindup(wn, p, line)
  }
  return wn !== 0
}

export function overlapsRectPoints(rect: Selrect, points: Point[]): boolean {
  if (points.length === 0) {
    return false
  }

  const rectPoints = rectToPoints(rect)
  if (!rectPoints || rectPoints.length === 0) {
    return false
  }

  const rectLines = pointsToLines(rectPoints)
  const pointsLines = pointsToLines(points)

  return (
    isPointInsideEvenOdd(rectPoints[0], pointsLines) ||
    isPointInsideEvenOdd(points[0], rectLines) ||
    intersectsLines(rectLines, pointsLines)
  )
}

/** Structural path segment (absolute coords) — local to avoid coupling the worker
 *  to the renderer's PathSegment union. */
type SegLike =
  | { type: 'move-to'; x: number; y: number }
  | { type: 'line-to'; x: number; y: number }
  | { type: 'curve-to'; x: number; y: number; c1x: number; c1y: number; c2x: number; c2y: number }
  | { type: 'close-path' }

type FlatPoly = { pts: Point[]; closed: boolean }

/** Pull absolute path segments out of a path/bool content (object form `{ segments }`
 *  or a bare segment array). */
function pathSegmentsOf(content: unknown): SegLike[] {
  if (!content) return []
  if (Array.isArray(content)) return content as SegLike[]
  const seg = (content as { segments?: unknown }).segments
  return Array.isArray(seg) ? (seg as SegLike[]) : []
}

function cubicPoint(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return point(
    a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    a * p0.y + b * c1.y + c * c2.y + d * p3.y
  )
}

/** Flatten path segments into one polyline per sub-path, sampling curves so the
 *  hit-test follows the real outline instead of the chord between anchors. */
function flattenPathSegments(segments: SegLike[], steps = 12): FlatPoly[] {
  const polys: FlatPoly[] = []
  let cur: FlatPoly | null = null
  let pen: Point | null = null
  for (const s of segments) {
    if (s.type === 'move-to') {
      cur = { pts: [point(s.x, s.y)], closed: false }
      polys.push(cur)
      pen = point(s.x, s.y)
    } else if (s.type === 'line-to' && cur) {
      cur.pts.push(point(s.x, s.y))
      pen = point(s.x, s.y)
    } else if (s.type === 'curve-to' && cur && pen) {
      const p3 = point(s.x, s.y)
      const c1 = point(s.c1x, s.c1y)
      const c2 = point(s.c2x, s.c2y)
      for (let i = 1; i <= steps; i++) cur.pts.push(cubicPoint(pen, c1, c2, p3, i / steps))
      pen = p3
    } else if (s.type === 'close-path' && cur) {
      cur.closed = true
    }
  }
  return polys.filter((poly) => poly.pts.length >= 2)
}

function overlapsPath(shape: PathShape | BoolShape, rect: Selrect, includeContent: boolean): boolean {
  const content = 'content' in shape ? shape.content : undefined
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return false
  }

  const rectPoints = rectToPoints(rect)
  if (!rectPoints) {
    return false
  }
  const rectLines = pointsToLines(rectPoints)

  // Prefer the real outline: flatten the path's curve segments into polylines and
  // test against those, so a click anywhere on the stroke hits — not only where it
  // runs near the bounding box (the old `shape.points` approximation). Closed
  // sub-paths also get an inside-test when fills are in play (`includeContent`).
  const polys = flattenPathSegments(pathSegmentsOf(content))
  if (polys.length > 0) {
    for (const poly of polys) {
      const polyLines = pointsToLines(poly.pts, poly.closed)
      if (intersectsLines(rectLines, polyLines)) {
        return true
      }
      if (
        includeContent &&
        poly.closed &&
        (isPointInsideNonzero(rectPoints[0], polyLines) || isPointInsideNonzero(poly.pts[0], rectLines))
      ) {
        return true
      }
    }
    return false
  }

  // Legacy fallback: approximate with the shape's bounding points (no segments).
  const points = shape.points
  if (!points || points.length === 0) {
    return false
  }
  const pathLines = pointsToLines(points)
  if (intersectsLines(rectLines, pathLines)) {
    return true
  }
  if (includeContent) {
    return (
      isPointInsideNonzero(rectPoints[0], pathLines) ||
      (points.length > 0 && isPointInsideNonzero(points[0], rectLines))
    )
  }
  return false
}

function isPointInsideEllipse(
  pt: Point,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): boolean {
  const v = sq(pt.x - cx) / sq(rx) + sq(pt.y - cy) / sq(ry)
  return v <= 1
}

function intersectsLineEllipse(
  [p1, p2]: Line,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): boolean {
  const { x: x1, y: y1 } = p1
  const { x: x2, y: y2 } = p2

  const a = sq(x2 - x1) / sq(rx) + sq(y2 - y1) / sq(ry)
  const b =
    (2 * x1 * (x2 - x1) - 2 * cx * (x2 - x1)) / sq(rx) +
    (2 * y1 * (y2 - y1) - 2 * cy * (y2 - y1)) / sq(ry)
  const c =
    (sq(x1) + sq(cx) - 2 * x1 * cx) / sq(rx) +
    (sq(y1) + sq(cy) - 2 * y1 * cy) / sq(ry) -
    1

  const determ = sq(b) - 4 * a * c

  if (almostZero(a)) {
    if (almostZero(b)) {
      return false
    }
    const t = -c / b
    return t >= 0 && t <= 1
  }

  if (determ < 0) {
    return false
  }

  const t1 = (-b + sqrt(determ)) / (2 * a)
  const t2 = (-b - sqrt(determ)) / (2 * a)

  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1)
}

function overlapsEllipse(shape: EllipseGeometry, rect: Selrect): boolean {
  const x = shape.x
  const y = shape.y
  const width = shape.width
  const height = shape.height

  const rx = width / 2
  const ry = height / 2

  const transform = shape.transform

  let rectPoints = rectToPoints(rect)
  if (!rectPoints) {
    return false
  }

  // Ellipse center: in local space (no transform) it is (x+w/2, y+h/2); with transform we use local origin at center so (0,0).
  let cx: number
  let cy: number
  let center: Point

  if (transform) {
    // World = T(local) + world_center. Use selrect center.
    const sr = shape.selrect
    const worldCenterX =
      sr != null && typeof sr.x === 'number' && typeof sr.width === 'number'
        ? sr.x + sr.width / 2
        : x + width / 2
    const worldCenterY =
      sr != null && typeof sr.y === 'number' && typeof sr.height === 'number'
        ? sr.y + sr.height / 2
        : y + height / 2
    const det = transform.a * transform.d - transform.b * transform.c
    if (Math.abs(det) < EPSILON) return false
    // inverseTransformPoint(p, M) applies M^{-1} to p. We need local = T^{-1}(world - center), so pass
    // the forward transform (e=0, f=0) so the function applies T_2x2^{-1}; passing inv would apply inv^{-1} = T (wrong direction).
    const transformLinear = { ...transform, e: 0, f: 0 }
    rectPoints = rectPoints.map((p) =>
      inverseTransformPoint(point(p.x - worldCenterX, p.y - worldCenterY), transformLinear)
    )
    cx = 0
    cy = 0
    center = point(0, 0)
  } else {
    cx = x + width / 2
    cy = y + height / 2
    center = point(cx, cy)
  }

  const rectLines = pointsToLines(rectPoints)

  // Check if center is inside rect
  if (isPointInsideEvenOdd(center, rectLines)) {
    return true
  }

  // Check if any rect point is inside ellipse (all four corners, not just the first)
  for (const pt of rectPoints) {
    if (isPointInsideEllipse(pt, cx, cy, rx, ry)) {
      return true
    }
  }

  // Check if any rect line intersects ellipse
  for (const line of rectLines) {
    if (intersectsLineEllipse(line, cx, cy, rx, ry)) return true
  }

  return false
}

function overlapsText(shape: TextShape, rect: Selrect): boolean {
  const positionData = shape.positionData
  const points = shape.points

  // If shape has position data, use it (simplified - full impl would transform)
  if (positionData && Array.isArray(positionData) && positionData.length > 0) {
    // Simplified: fall back to points
    if (points && points.length > 0) {
      return overlapsRectPoints(rect, points)
    }
    return false
  }

  // Use points directly
  if (points && points.length > 0) {
    return overlapsRectPoints(rect, points)
  }

  // Fallback: AABB selrect overlap. Freshly-created text has a selrect but no
  // `points` and no `positionData` until layout runs; without this it would be
  // unhittable. Exact for unrotated text; matches how other shapes degrade.
  const sel = shape.selrect
  if (sel) {
    return overlapsRects(rect, sel)
  }

  return false
}

/** Get points from shape for overlap: use shape.points or derive from selrect. */
function getShapePointsForOverlap(shape: PenpotNode): Point[] {
  if (shape.points && shape.points.length > 0) {
    return shape.points
  }
  const sr = shape.selrect
  if (!sr) return []
  const x = sr.x
  const y = sr.y
  const width = sr.width ?? (typeof sr.x2 === 'number' && typeof sr.x1 === 'number' ? sr.x2 - sr.x1 : 0)
  const height = sr.height ?? (typeof sr.y2 === 'number' && typeof sr.y1 === 'number' ? sr.y2 - sr.y1 : 0)
  if (typeof x !== 'number' || typeof y !== 'number' || width <= 0 || height <= 0) return []
  const rect = makeSelrect(x, y, width, height)
  const pts = rectToPoints(rect)
  return pts ?? []
}

/** Half-width the stroke reaches outward from the spine, for hit padding. A
 *  variable-width ribbon (hand-authored `strokeWidthPoints`, flat `[t,l,r,mode,…]`)
 *  reaches `base_half × its largest l/r multiplier`, floored to mirror the
 *  renderer's MIN_WIDTH; a plain stroke is just `width/2`. */
function strokeHitHalf(stroke: { strokeWidth?: number }): number {
  const w = stroke.strokeWidth ?? 0
  const wp = (stroke as { strokeWidthPoints?: number[] }).strokeWidthPoints
  if (Array.isArray(wp) && wp.length >= 4) {
    let mult = 1
    for (let i = 0; i + 3 < wp.length; i += 4) mult = Math.max(mult, wp[i + 1], wp[i + 2])
    return (Math.max(w, 4) / 2) * mult
  }
  return w / 2
}

/** Outer padding (expansion): center → strokeWidth, outer → 2*strokeWidth, inner → 0. Max across strokes. */
function getStrokePaddingOuter(shape: PenpotNode): number {
  const strokes = shape.strokes
  if (!strokes || strokes.length === 0) return 0
  let max = 0
  for (const s of strokes) {
    const w = s.strokeWidth ?? 0
    const align = s.strokeAlignment ?? 'center'
    const padding =
      align === 'center' ? w : align === 'outer' ? 2 * w : 0
    if (padding > max) max = padding
  }
  return max
}

/** Inner padding (shrink): center → strokeWidth, outer → 0, inner → 2*strokeWidth. Max across strokes. */
function getStrokePaddingInner(shape: PenpotNode): number {
  const strokes = shape.strokes
  if (!strokes || strokes.length === 0) return 0
  let max = 0
  for (const s of strokes) {
    const w = s.strokeWidth ?? 0
    const align = s.strokeAlignment ?? 'center'
    const padding =
      align === 'center' ? w : align === 'inner' ? 2 * w : 0
    if (padding > max) max = padding
  }
  return max
}

/** Test if point (center of rect) is inside axis-aligned rect in local space. */
function isPointInLocalRect(
  localX: number,
  localY: number,
  halfW: number,
  halfH: number
): boolean {
  return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH
}

function overlapsOuterShape(shape: PenpotNode, rect: Selrect, shapeType: string): boolean {
  const bounds = shape.selrect
  if (!bounds) return false
  const padding = getStrokePaddingOuter(shape)
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const w = bounds.width + padding
  const h = bounds.height + padding
  const outerX = centerX - w / 2
  const outerY = centerY - h / 2

  if (shapeType === 'rect') {
    const transform = shape.transform
    if (transform && !isIdentityTransform(transform)) {
      // Rotated rect: transform click point to local space and test against local axis-aligned stroke band
      const clickX = rect.x + rect.width / 2
      const clickY = rect.y + rect.height / 2
      const worldRel = point(clickX - centerX, clickY - centerY)
      const transformLinear = { ...transform, e: 0, f: 0 }
      const local = inverseTransformPoint(worldRel, transformLinear)
      const halfW = bounds.width / 2 + padding / 2
      const halfH = bounds.height / 2 + padding / 2
      return isPointInLocalRect(local.x, local.y, halfW, halfH)
    }
    const outerRect = makeSelrect(outerX, outerY, w, h)
    const outerPoints = rectToPoints(outerRect)
    if (!outerPoints) return false
    return overlapsRectPoints(rect, outerPoints)
  }

  if (shapeType === 'circle') {
    const synthetic: EllipseGeometry = {
      x: outerX,
      y: outerY,
      width: w,
      height: h,
      selrect: makeSelrect(outerX, outerY, w, h),
      transform: shape.transform,
    }
    return overlapsEllipse(synthetic, rect)
  }

  return false
}

function overlapsInnerShape(shape: PenpotNode, rect: Selrect, shapeType: string): boolean {
  const bounds = shape.selrect
  if (!bounds) return false
  const padding = getStrokePaddingInner(shape)
  const w = bounds.width - padding
  const h = bounds.height - padding
  if (w <= 0 || h <= 0) return false
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const innerX = centerX - w / 2
  const innerY = centerY - h / 2

  if (shapeType === 'rect') {
    const transform = shape.transform
    if (transform && !isIdentityTransform(transform)) {
      // Rotated rect: transform click point to local space and test against local inner band
      const clickX = rect.x + rect.width / 2
      const clickY = rect.y + rect.height / 2
      const worldRel = point(clickX - centerX, clickY - centerY)
      const transformLinear = { ...transform, e: 0, f: 0 }
      const local = inverseTransformPoint(worldRel, transformLinear)
      const halfW = bounds.width / 2 - padding / 2
      const halfH = bounds.height / 2 - padding / 2
      return isPointInLocalRect(local.x, local.y, halfW, halfH)
    }
    const innerRect = makeSelrect(innerX, innerY, w, h)
    const innerPoints = rectToPoints(innerRect)
    if (!innerPoints) return false
    return overlapsRectPoints(rect, innerPoints)
  }

  if (shapeType === 'circle') {
    const synthetic: EllipseGeometry = {
      x: innerX,
      y: innerY,
      width: w,
      height: h,
      selrect: makeSelrect(innerX, innerY, w, h),
      transform: shape.transform,
    }
    return overlapsEllipse(synthetic, rect)
  }

  return false
}

/**
 * True when the shape has a visible background effect (background-blur or glass)
 * that makes its interior visually significant even without fills.
 */
function hasVisibleBackgroundEffect(shape: PenpotNode): boolean {
  const blur = shape.blur
  if (blur && blur.type === 'background-blur' && !blur.hidden) return true
  const glass = shape.glass
  if (glass && !glass.hidden) return true
  return false
}

/**
 * True when the shape backs an embedded 3D scene (carries a `scene3d` document).
 * The scene's container rect has a transparent fill — the three.js overlay paints
 * the scene over it — but it is a SOLID interactive surface, not a hollow stroked
 * box. So it must be interior-hittable on a click, not treated as stroke-only
 * (which would let clicks fall through its middle). `scene3d` is an app-level field
 * not in `PenpotNode`, so read it structurally.
 */
function isScene3dFrame(shape: PenpotNode): boolean {
  return (shape as { scene3d?: unknown }).scene3d != null
}

export function overlaps(shape: PenpotNode, rect: Selrect, usingSelrect: boolean = false): boolean {
  if (!shape) {
    return false
  }

  // Modifier-aware hit-test: a shape carrying a rest->animated overlay transform
  // (set during a paused motion preview) is DRAWN elsewhere than its rest
  // geometry, so map the world query back into rest space before testing.
  const hitTransform = (shape as { hitTransform?: Matrix }).hitTransform
  const src = hitTransform ? inverseTransformRect(rect, hitTransform) : rect

  // Adjust rect for stroke width. A variable-width ribbon reaches
  // base_half × its largest width-point multiplier — well past the base half-width
  // — so pad the hit test by that real extent, or clicks on the wide band miss.
  const firstStroke = shape.strokes?.[0]
  const swidth = firstStroke ? strokeHitHalf(firstStroke) : 0
  const adjustedRect: Selrect = makeSelrect(
    src.x - swidth,
    src.y - swidth,
    src.width + 2 * swidth,
    src.height + 2 * swidth
  )

  // Handle shapes without fills (stroke-only) — but skip stroke-only mode
  // when a visible background effect (background-blur or glass) makes the
  // interior visually significant.
  const svgAttrs = shape.svgAttrs
  if (
    !usingSelrect &&
    (!shape.fills || shape.fills.length === 0) &&
    !svgAttrs?.fill &&
    !svgAttrs?.style?.fill &&
    !hasVisibleBackgroundEffect(shape) &&
    !isScene3dFrame(shape)
  ) {
    const shapeTypeInner = shape.type

    if (shapeTypeInner === 'rect' || shapeTypeInner === 'circle') {
      // Use click point (center of query rect) for stroke-band test so a large query rect
      // doesn't overlap the inner area and prevent selection (log evidence: H2).
      const centerX = adjustedRect.x + adjustedRect.width / 2
      const centerY = adjustedRect.y + adjustedRect.height / 2
      const eps = 1e-6
      const centerRect = makeSelrect(centerX - eps / 2, centerY - eps / 2, eps, eps)
      return (
        overlapsOuterShape(shape, centerRect, shapeTypeInner) &&
        !overlapsInnerShape(shape, centerRect, shapeTypeInner)
      )
    }

    if (shapeTypeInner === 'path' || shapeTypeInner === 'bool') {
      return overlapsPath(shape, adjustedRect, false)
    }
  }

  // Per-shape overlap pipelines (switch narrows type, no casts needed)
  switch (shape.type) {
    case 'path':
    case 'bool': {
      const points = shape.points || []
      if (points.length === 0) {
        const pts = getShapePointsForOverlap(shape)
        return pts.length > 0 && overlapsRectPoints(adjustedRect, pts) && overlapsPath(shape, adjustedRect, true)
      }
      return (
        overlapsRectPoints(adjustedRect, points) &&
        overlapsPath(shape, adjustedRect, true)
      )
    }
    case 'circle':
      return overlapsEllipse(shape, adjustedRect)
    case 'text':
      return overlapsText(shape, adjustedRect)
    default: {
      const points = getShapePointsForOverlap(shape)
      return points.length > 0 && overlapsRectPoints(adjustedRect, points)
    }
  }
}

