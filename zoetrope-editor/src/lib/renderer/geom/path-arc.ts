/**
 * Arc-length parameterisation of a path outline.
 *
 * Why this exists: the width ribbon is sampled in the renderer by **global
 * arc-fraction** (Rust `PathMeasure`), but the editor's hit-test
 * (`nearestPointOnPath`) reports an **edge index + edge-local t**. Those are
 * different parameterisations — a curve's local `t` is not proportional to
 * arc length. Without converting, a width handle would sit somewhere other than
 * where the rendered width actually changes.
 *
 * So: flatten every edge into samples, accumulate real arc length, and offer
 *   • `fractionOfHit` — hit (edge + local t) → global arc-fraction 0..1
 *   • `sampleFraction` — global arc-fraction → point + unit tangent
 * Both approximate the renderer's arc length closely enough for handle
 * placement (sub-pixel at `STEPS` = 24 per curved edge).
 */

import type { Anchor, PathHit, Pt } from './anchors'

/** Samples per curved edge. Straight edges need only their two endpoints. */
const STEPS = 24

export interface ArcTable {
  /** Flattened polyline of the whole outline. */
  pts: Pt[]
  /** Cumulative arc length at each point in `pts`. */
  cum: number[]
  /** Index into `pts` where edge `i` starts. */
  edgeStart: number[]
  /** How many samples edge `i` contributes (1 straight, STEPS curved). */
  edgeSteps: number[]
  total: number
}

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

function edgeControls(a: Anchor, b: Anchor) {
  const curve = !!(a.handleOut || b.handleIn)
  return { p0: a.point, p1: a.handleOut ?? a.point, p2: b.handleIn ?? b.point, p3: b.point, curve }
}

/** Flatten `anchors` into an arc-length table. Empty for fewer than 2 anchors. */
export function buildArcTable(anchors: Anchor[], closed: boolean): ArcTable {
  const pts: Pt[] = []
  const cum: number[] = []
  const edgeStart: number[] = []
  const edgeSteps: number[] = []
  let total = 0

  const n = anchors.length
  if (n < 2) return { pts, cum, edgeStart, edgeSteps, total: 0 }

  const push = (p: Pt) => {
    if (pts.length === 0) {
      pts.push(p)
      cum.push(0)
      return
    }
    const prev = pts[pts.length - 1]
    total += Math.hypot(p.x - prev.x, p.y - prev.y)
    pts.push(p)
    cum.push(total)
  }

  const edges = closed ? n : n - 1
  for (let i = 0; i < edges; i++) {
    const { p0, p1, p2, p3, curve } = edgeControls(anchors[i], anchors[(i + 1) % n])
    if (i === 0) push(p0)
    edgeStart[i] = pts.length - 1
    if (!curve) {
      edgeSteps[i] = 1
      push(p3)
    } else {
      edgeSteps[i] = STEPS
      for (let s = 1; s <= STEPS; s++) push(cubicAt(p0, p1, p2, p3, s / STEPS))
    }
  }

  return { pts, cum, edgeStart, edgeSteps, total }
}

/** Hit (edge + edge-local t) → global arc-fraction 0..1. */
export function fractionOfHit(table: ArcTable, hit: PathHit): number {
  const { cum, edgeStart, edgeSteps, total } = table
  if (total <= 0 || edgeStart[hit.edge] === undefined) return 0
  // Samples within an edge are at uniform local t, so index-interpolating their
  // (real) cumulative lengths recovers arc length at this t.
  const idxF = edgeStart[hit.edge] + Math.max(0, Math.min(1, hit.t)) * edgeSteps[hit.edge]
  const i0 = Math.max(0, Math.min(Math.floor(idxF), cum.length - 1))
  const i1 = Math.min(i0 + 1, cum.length - 1)
  const u = idxF - i0
  const len = cum[i0] + (cum[i1] - cum[i0]) * u
  return Math.max(0, Math.min(1, len / total))
}

/** Global arc-fraction 0..1 → point + unit tangent on the outline. */
export function sampleFraction(table: ArcTable, f: number): { point: Pt; tangent: Pt } | null {
  const { pts, cum, total } = table
  if (pts.length < 2 || total <= 0) return null
  const target = Math.max(0, Math.min(1, f)) * total

  // Binary-search the first sample whose cumulative length reaches `target`.
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < target) lo = mid + 1
    else hi = mid
  }
  const i1 = Math.max(1, lo)
  const i0 = i1 - 1
  const span = cum[i1] - cum[i0] || 1
  const u = (target - cum[i0]) / span
  const a = pts[i0]
  const b = pts[i1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return {
    point: { x: a.x + dx * u, y: a.y + dy * u },
    tangent: { x: dx / len, y: dy / len },
  }
}
