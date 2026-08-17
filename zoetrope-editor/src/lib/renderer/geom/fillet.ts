/**
 * Corner fillets (P4) — round a sharp path vertex by trimming its two edges and
 * inserting a tangent circular arc, approximated by one cubic bézier. A fillet is
 * pure geometry that emits standard `curve-to` segments, so render-wasm draws it
 * with no changes.
 *
 * Per the design, the *stored* path keeps its sharp corners; a single shape-wide
 * `cornerRadius` is applied here at the render/serialize boundary via
 * `roundedSegments`, so deleting/adding a vertex needs no per-corner bookkeeping.
 */

import type { PathSegment } from '../types'
import { anchorsToSegments, type Anchor, type Pt } from './anchors'

export interface CornerFillet {
  /** Tangent point on the incoming edge (toward the previous vertex). */
  t1: Pt
  /** Tangent point on the outgoing edge (toward the next vertex). */
  t2: Pt
  /** Out-handle of t1 / in-handle of t2 — the arc's bézier controls. */
  c1: Pt
  c2: Pt
  /** Effective radius after clamping to the available edge length. */
  rEff: number
}

/**
 * Fillet the corner at `p` between neighbours `prev` and `next` with radius `r`.
 * Returns null when the corner can't be rounded — a zero-length edge, a straight
 * run, a fully folded spike, or `r <= 0`. The trim distance `t = r / tan(θ/2)` is
 * clamped to half the shorter adjacent edge (and `r` reduced to match) so
 * neighbouring fillets can't overrun each other.
 */
export function filletCorner(prev: Pt, p: Pt, next: Pt, r: number): CornerFillet | null {
  if (r <= 0) return null
  const ax = prev.x - p.x
  const ay = prev.y - p.y
  const bx = next.x - p.x
  const by = next.y - p.y
  const la = Math.hypot(ax, ay)
  const lb = Math.hypot(bx, by)
  if (la < 1e-9 || lb < 1e-9) return null
  const ux = ax / la
  const uy = ay / la // unit vector toward prev
  const vx = bx / lb
  const vy = by / lb // unit vector toward next
  const cosT = Math.max(-1, Math.min(1, ux * vx + uy * vy))
  const theta = Math.acos(cosT) // interior angle in [0, π]
  if (theta > Math.PI - 1e-3 || theta < 1e-3) return null
  const tanHalf = Math.tan(theta / 2)
  let t = r / tanHalf
  let rEff = r
  const maxT = Math.min(la, lb) / 2
  if (t > maxT) {
    t = maxT
    rEff = t * tanHalf
  }
  const t1 = { x: p.x + ux * t, y: p.y + uy * t }
  const t2 = { x: p.x + vx * t, y: p.y + vy * t }
  // Arc central angle is the turn angle (π − θ); k is the standard
  // arc→cubic-bézier handle length. Handles point back toward the corner.
  const k = (4 / 3) * Math.tan((Math.PI - theta) / 4) * rEff
  return {
    t1,
    t2,
    c1: { x: t1.x - ux * k, y: t1.y - uy * k },
    c2: { x: t2.x - vx * k, y: t2.y - vy * k },
    rEff,
  }
}

/**
 * Build path segments with every pure-corner vertex rounded to `radius`. Smooth
 * vertices (those carrying bézier handles) and the endpoints of an open path are
 * left untouched. `radius <= 0` falls straight through to the sharp segments.
 */
export function roundedSegments(anchors: Anchor[], radius: number, closed = false): PathSegment[] {
  const n = anchors.length
  if (radius <= 0 || n < 2) return anchorsToSegments(anchors, closed)

  // Fillet data per vertex (null = stays sharp / not filletable).
  const fillets = anchors.map((a, i): CornerFillet | null => {
    if (a.handleIn || a.handleOut) return null // smooth vertex — already curved
    const prev = i > 0 ? anchors[i - 1] : closed ? anchors[n - 1] : null
    const next = i < n - 1 ? anchors[i + 1] : closed ? anchors[0] : null
    if (!prev || !next) return null
    return filletCorner(prev.point, a.point, next.point, radius)
  })

  const entry = (i: number): Pt => fillets[i]?.t1 ?? anchors[i].point
  const exit = (i: number): Pt => fillets[i]?.t2 ?? anchors[i].point

  // Straight (or curved, if the endpoints carry handles) edge from vertex i's
  // exit to vertex j's entry.
  const edge = (i: number, j: number): PathSegment => {
    const a = anchors[i]
    const b = anchors[j]
    const to = entry(j)
    if (a.handleOut || b.handleIn) {
      const from = exit(i)
      const c1 = a.handleOut ?? from
      const c2 = b.handleIn ?? to
      return { type: 'curve-to', x: to.x, y: to.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y }
    }
    return { type: 'line-to', x: to.x, y: to.y }
  }

  const arc = (i: number): PathSegment | null => {
    const f = fillets[i]
    return f ? { type: 'curve-to', x: f.t2.x, y: f.t2.y, c1x: f.c1.x, c1y: f.c1.y, c2x: f.c2.x, c2y: f.c2.y } : null
  }

  const segs: PathSegment[] = [{ type: 'move-to', x: entry(0).x, y: entry(0).y }]
  const a0 = arc(0)
  if (a0) segs.push(a0)

  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n
    segs.push(edge(i, j))
    // The arc for vertex 0 was already emitted at the start.
    if (j !== 0) {
      const aj = arc(j)
      if (aj) segs.push(aj)
    }
  }
  if (closed) segs.push({ type: 'close-path' })
  return segs
}
