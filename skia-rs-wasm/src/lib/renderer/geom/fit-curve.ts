/**
 * Fit a dense polyline ring (e.g. a boolean-cut boundary flattened from curves)
 * down to a FEW editable anchors that KEEP the curvature: sharp turns become
 * corner nodes, smooth runs are thinned (Douglas–Peucker) and given bézier
 * tangent handles (Catmull–Rom) so the curve is carried by handles, not a swarm
 * of straight dots. This is what lets the eraser cut a smooth arc yet leave you
 * a handful of nodes to edit.
 */

import type { Anchor, Pt } from './anchors'

/** A turn sharper than this (degrees) at a vertex is treated as a corner and kept
 *  as a sharp node; gentler bends are reconstructed as a smooth curve. */
const CORNER_ANGLE_DEG = 32

/** Perpendicular distance from `p` to the segment `a`→`b`. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Douglas–Peucker on an open polyline; returns the kept LOCAL indices. */
function rdpOpenIdx(pts: Pt[], eps: number): number[] {
  if (pts.length < 3) return pts.map((_, i) => i)
  const keep = new Array(pts.length).fill(false)
  keep[0] = true
  keep[pts.length - 1] = true
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let idx = -1
    let maxD = eps
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(pts[i], pts[lo], pts[hi])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx >= 0) {
      keep[idx] = true
      stack.push([lo, idx], [idx, hi])
    }
  }
  const out: number[] = []
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i)
  return out
}

/** RDP a run of the closed ring from dense index `s` to `e` (wrapping), keeping
 *  both endpoints; returns kept DENSE indices. */
function rdpRunIdx(pts: Pt[], s: number, e: number, eps: number): number[] {
  const n = pts.length
  const len = ((e - s + n) % n) || n
  const idxs: number[] = []
  for (let k = 0; k <= len; k++) idxs.push((s + k) % n)
  const sub = idxs.map((i) => pts[i])
  return rdpOpenIdx(sub, eps).map((li) => idxs[li])
}

/** RDP a corner-free closed ring: split at the vertex farthest from index 0. */
function rdpClosedIdx(pts: Pt[], eps: number): number[] {
  const n = pts.length
  if (n <= 4) return pts.map((_, i) => i)
  let far = 1
  let fd = -1
  for (let i = 1; i < n; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2
    if (d > fd) {
      fd = d
      far = i
    }
  }
  const set = new Set<number>([...rdpRunIdx(pts, 0, far, eps), ...rdpRunIdx(pts, far, 0, eps)])
  return [...set].sort((a, b) => a - b)
}

/** Douglas–Peucker simplify of an OPEN polyline (e.g. a brush drag, to drop hand
 *  jitter before offsetting it into a band). */
export function rdpSimplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  return rdpOpenIdx(pts, eps).map((i) => pts[i])
}

/**
 * Reduce a dense closed ring to smooth-plus-corner anchors. `eps` is the RDP
 * tolerance (world units) for thinning the smooth runs.
 */
export function fitClosedRing(pts: Pt[], eps: number): Anchor[] {
  const n = pts.length
  if (n < 3) return pts.map((p) => ({ point: { x: p.x, y: p.y } }))
  const cornerCos = Math.cos((CORNER_ANGLE_DEG * Math.PI) / 180)
  const at = (i: number) => pts[((i % n) + n) % n]

  // Corner = the turn between the two incident edges is sharper than the
  // threshold. On a flattened curve each step turns only slightly, so this
  // isolates true corners (straight-meets-straight) to single vertices.
  const cornerFlag = new Array<boolean>(n)
  for (let i = 0; i < n; i++) {
    const a = at(i)
    const p = at(i - 1)
    const q = at(i + 1)
    const ax = a.x - p.x
    const ay = a.y - p.y
    const bx = q.x - a.x
    const by = q.y - a.y
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    cornerFlag[i] = la > 1e-6 && lb > 1e-6 && (ax * bx + ay * by) / (la * lb) < cornerCos
  }
  const corners: number[] = []
  for (let i = 0; i < n; i++) if (cornerFlag[i]) corners.push(i)

  let kept: number[]
  if (corners.length === 0) {
    kept = rdpClosedIdx(pts, eps)
  } else {
    const set = new Set<number>()
    for (let c = 0; c < corners.length; c++) {
      for (const idx of rdpRunIdx(pts, corners[c], corners[(c + 1) % corners.length], eps)) set.add(idx)
    }
    kept = [...set].sort((a, b) => a - b)
  }
  if (kept.length < 3) kept = pts.map((_, i) => i)

  const keptPts = kept.map((i) => pts[i])
  const keptCorner = kept.map((i) => cornerFlag[i])
  const m = keptPts.length
  const K = (i: number) => keptPts[((i % m) + m) % m]

  return keptPts.map((p, i) => {
    if (keptCorner[i]) return { point: { x: p.x, y: p.y } }
    // Smooth node: tangent along neighbours (Catmull–Rom), handles 1/3 of the
    // chord to each side so the reconstructed curve hugs the original samples.
    const prev = K(i - 1)
    const next = K(i + 1)
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tl = Math.hypot(tx, ty) || 1
    const ux = tx / tl
    const uy = ty / tl
    const dPrev = Math.hypot(p.x - prev.x, p.y - prev.y) / 3
    const dNext = Math.hypot(next.x - p.x, next.y - p.y) / 3
    return {
      point: { x: p.x, y: p.y },
      handleIn: { x: p.x - ux * dPrev, y: p.y - uy * dPrev },
      handleOut: { x: p.x + ux * dNext, y: p.y + uy * dNext },
    }
  })
}
