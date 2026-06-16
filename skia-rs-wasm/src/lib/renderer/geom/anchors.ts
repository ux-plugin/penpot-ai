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
