/**
 * Editable anchor model — the bridge between the pen/vector-editor's working
 * representation and the WORLD-space path segments stored on a node. An anchor
 * is a point with optional bézier handles (absolute world coords, not deltas);
 * a missing handle means a corner (straight) on that side.
 *
 * `anchorsToSegments` is the forward map (used at commit), `segmentsToAnchors`
 * the inverse (used when entering vector-edit). They round-trip: building
 * segments from anchors and reading them back yields equivalent anchors. This is
 * the shared substrate for B2 (pen curves) and the later C (vector edit) phase.
 */

import type { PathSegment } from '../types'

export interface Pt {
  x: number
  y: number
}

export interface Anchor {
  point: Pt
  /** Incoming control point — shapes the curve arriving from the previous anchor. */
  handleIn?: Pt
  /** Outgoing control point — shapes the curve leaving toward the next anchor. */
  handleOut?: Pt
}

const eq = (a: Pt, b: Pt, eps = 1e-6): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

/** Reflect `h` through `pivot` — mirrors a dragged handle onto the opposite side. */
export function reflect(pivot: Pt, h: Pt): Pt {
  return { x: 2 * pivot.x - h.x, y: 2 * pivot.y - h.y }
}

/**
 * One edge from `a` to `b`: a curve-to when either endpoint carries a handle on
 * that edge, otherwise a straight line-to. A handleless endpoint contributes its
 * own point as the control (a degenerate handle), so a one-sided curve still works.
 */
function edgeSegment(a: Anchor, b: Anchor): PathSegment {
  if (a.handleOut || b.handleIn) {
    const c1 = a.handleOut ?? a.point
    const c2 = b.handleIn ?? b.point
    return { type: 'curve-to', x: b.point.x, y: b.point.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y }
  }
  return { type: 'line-to', x: b.point.x, y: b.point.y }
}

export function anchorsToSegments(anchors: Anchor[], closed = false): PathSegment[] {
  if (anchors.length === 0) return []
  const segs: PathSegment[] = [{ type: 'move-to', x: anchors[0].point.x, y: anchors[0].point.y }]
  for (let i = 1; i < anchors.length; i++) segs.push(edgeSegment(anchors[i - 1], anchors[i]))
  if (closed && anchors.length >= 2) {
    const last = anchors[anchors.length - 1]
    const first = anchors[0]
    // A curved closing edge needs an explicit curve-to back to the start; a
    // straight one is left to close-path alone (parity with createPolyline).
    if (last.handleOut || first.handleIn) segs.push(edgeSegment(last, first))
    segs.push({ type: 'close-path' })
  }
  return segs
}

export function segmentsToAnchors(segments: PathSegment[]): { anchors: Anchor[]; closed: boolean } {
  const anchors: Anchor[] = []
  let closed = false
  for (const seg of segments) {
    switch (seg.type) {
      case 'move-to':
      case 'line-to':
        anchors.push({ point: { x: seg.x, y: seg.y } })
        break
      case 'curve-to': {
        const prev = anchors[anchors.length - 1]
        if (prev) prev.handleOut = { x: seg.c1x, y: seg.c1y }
        anchors.push({ point: { x: seg.x, y: seg.y }, handleIn: { x: seg.c2x, y: seg.c2y } })
        break
      }
      case 'close-path':
        closed = true
        break
    }
  }
  // An explicit curved closing edge leaves a duplicate of the first anchor at the
  // end; fold its in-handle back onto the first anchor and drop the duplicate.
  if (closed && anchors.length >= 2) {
    const last = anchors[anchors.length - 1]
    if (eq(last.point, anchors[0].point)) {
      if (last.handleIn) anchors[0].handleIn = last.handleIn
      anchors.pop()
    }
  }
  return { anchors, closed }
}

/** Axis-aligned bounds over the anchors *and* their handles, so a curve bulging
 * past its vertices stays inside the box. Empty input → a zero rect. */
export function anchorsBounds(anchors: Anchor[]): {
  x: number
  y: number
  width: number
  height: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const ext = (p: Pt) => {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  for (const a of anchors) {
    ext(a.point)
    if (a.handleIn) ext(a.handleIn)
    if (a.handleOut) ext(a.handleOut)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
const dist2 = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** Cubic bézier point at parameter t (Bernstein form). */
function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** The control points of the edge from anchor `a` to anchor `b`, treating a
 * missing handle as a degenerate one at its own point (so lines and curves share
 * one cubic representation). */
function edgeControls(a: Anchor, b: Anchor): { p0: Pt; p1: Pt; p2: Pt; p3: Pt; curve: boolean } {
  const curve = !!(a.handleOut || b.handleIn)
  return { p0: a.point, p1: a.handleOut ?? a.point, p2: b.handleIn ?? b.point, p3: b.point, curve }
}

export interface PathHit {
  /** Index of the anchor that starts the hit edge (its successor closes it). */
  edge: number
  /** Parameter along that edge, 0..1. */
  t: number
  /** The closest point on the edge (same coord space as the query). */
  point: Pt
  /** Distance from the query point to `point`. */
  dist: number
}

/**
 * Closest point on the path outline to `target` (same coord space as the
 * anchors). Walks every edge — straight edges by perpendicular projection,
 * curved edges by coarse sampling refined with a ternary search — and returns
 * the nearest, or null for a path with fewer than two anchors. Used by the
 * vector editor to preview/insert an anchor under the cursor.
 */
export function nearestPointOnPath(anchors: Anchor[], closed: boolean, target: Pt): PathHit | null {
  const n = anchors.length
  if (n < 2) return null
  const edges = closed ? n : n - 1
  let best: PathHit | null = null
  const consider = (hit: PathHit) => {
    if (!best || hit.dist < best.dist) best = hit
  }
  for (let i = 0; i < edges; i++) {
    const a = anchors[i]
    const b = anchors[(i + 1) % n]
    const { p0, p1, p2, p3, curve } = edgeControls(a, b)
    if (!curve) {
      const dx = p3.x - p0.x
      const dy = p3.y - p0.y
      const len2 = dx * dx + dy * dy
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((target.x - p0.x) * dx + (target.y - p0.y) * dy) / len2))
      const point = lerpPt(p0, p3, t)
      consider({ edge: i, t, point, dist: Math.sqrt(dist2(point, target)) })
      continue
    }
    const SAMPLES = 24
    let bt = 0
    let bd = Infinity
    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES
      const d = dist2(cubicAt(p0, p1, p2, p3, t), target)
      if (d < bd) {
        bd = d
        bt = t
      }
    }
    let lo = Math.max(0, bt - 1 / SAMPLES)
    let hi = Math.min(1, bt + 1 / SAMPLES)
    for (let r = 0; r < 16; r++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (dist2(cubicAt(p0, p1, p2, p3, m1), target) < dist2(cubicAt(p0, p1, p2, p3, m2), target)) hi = m2
      else lo = m1
    }
    const t = (lo + hi) / 2
    const point = cubicAt(p0, p1, p2, p3, t)
    consider({ edge: i, t, point, dist: Math.sqrt(dist2(point, target)) })
  }
  return best
}

/**
 * Insert an anchor splitting the edge that starts at anchor `i` at parameter
 * `t`. A curved edge is split with De Casteljau so the outline is unchanged
 * (the two new sub-curves trace the original); a straight edge splits linearly.
 * Returns a new anchor array (the input is not mutated).
 */
export function insertAnchorOnEdge(anchors: Anchor[], closed: boolean, i: number, t: number): Anchor[] {
  const n = anchors.length
  if (n < 2 || i < 0 || i >= (closed ? n : n - 1)) return anchors.map(cloneAnchor)
  const j = (i + 1) % n
  const next = anchors.map(cloneAnchor)
  const { p0, p1, p2, p3, curve } = edgeControls(anchors[i], anchors[j])
  let inserted: Anchor
  if (!curve) {
    inserted = { point: lerpPt(p0, p3, t) }
  } else {
    const q0 = lerpPt(p0, p1, t)
    const q1 = lerpPt(p1, p2, t)
    const q2 = lerpPt(p2, p3, t)
    const r0 = lerpPt(q0, q1, t)
    const r1 = lerpPt(q1, q2, t)
    const s = lerpPt(r0, r1, t)
    next[i].handleOut = q0
    next[j].handleIn = q2
    inserted = { point: s, handleIn: r0, handleOut: r1 }
  }
  // i+1 lands at the array end for the closing edge (i = n-1) — a plain push.
  next.splice(i + 1, 0, inserted)
  return next
}

const cloneAnchor = (a: Anchor): Anchor => ({
  point: { x: a.point.x, y: a.point.y },
  ...(a.handleIn ? { handleIn: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
  ...(a.handleOut ? { handleOut: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
})

/** Render segments to an SVG path `d` (world coords) — shared by the pen preview
 * and the future vector editor. */
export function segmentsToSvgPath(segments: PathSegment[]): string {
  let d = ''
  for (const seg of segments) {
    switch (seg.type) {
      case 'move-to':
        d += `M${seg.x} ${seg.y}`
        break
      case 'line-to':
        d += `L${seg.x} ${seg.y}`
        break
      case 'curve-to':
        d += `C${seg.c1x} ${seg.c1y} ${seg.c2x} ${seg.c2y} ${seg.x} ${seg.y}`
        break
      case 'close-path':
        d += 'Z'
        break
    }
  }
  return d
}
