/**
 * Compound paths (J1) — a path node can hold multiple sub-paths (disjoint strokes,
 * shapes with holes, several rings joined later). Each sub-path is an ordered
 * vertex ring, open or closed; the node's `content.segments` is their concatenation
 * (one `move-to` per sub-path), which render-wasm already draws as standard SVG.
 *
 * Sub-paths are the canonical compound model; a plain single path is just
 * `subpaths.length === 1`. `getSubpaths` normalizes whatever a node carries
 * (subpaths, the legacy single vertices+closed, or raw segments) into a sub-path
 * list, so callers never branch on representation.
 */

import type { PathSegment } from '../types'
import { anchorsToSegments, segmentsToAnchors, type Anchor } from './anchors'

export interface Subpath {
  vertices: Anchor[]
  closed: boolean
}

const cloneAnchor = (a: Anchor): Anchor => ({
  point: { x: a.point.x, y: a.point.y },
  ...(a.handleIn ? { handleIn: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
  ...(a.handleOut ? { handleOut: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
})

const cloneSubpath = (s: Subpath): Subpath => ({
  vertices: s.vertices.map(cloneAnchor),
  closed: s.closed,
})

/** Split a flat segment list into sub-paths at each `move-to`. */
export function segmentsToSubpaths(segments: PathSegment[]): Subpath[] {
  const out: Subpath[] = []
  let cur: PathSegment[] = []
  const flush = () => {
    if (cur.length > 0) {
      const { anchors, closed } = segmentsToAnchors(cur)
      if (anchors.length > 0) out.push({ vertices: anchors, closed })
    }
  }
  for (const s of segments) {
    if (s.type === 'move-to') {
      flush()
      cur = [s]
    } else {
      cur.push(s)
    }
  }
  flush()
  return out
}

/** Concatenate sub-paths into one segment list (each begins with a `move-to`). */
export function subpathsToSegments(subpaths: Subpath[]): PathSegment[] {
  const segs: PathSegment[] = []
  for (const sp of subpaths) {
    if (sp.vertices.length > 0) segs.push(...anchorsToSegments(sp.vertices, sp.closed))
  }
  return segs
}

type PathContentLike = {
  subpaths?: Subpath[]
  vertices?: Anchor[]
  closed?: boolean
  segments?: PathSegment[]
}

/**
 * Normalize a node's path content to a sub-path list, regardless of how it's
 * stored: explicit `subpaths`, the single `vertices` + `closed`, or raw segments.
 */
export function getSubpaths(content: PathContentLike | null | undefined): Subpath[] {
  if (!content) return []
  if (Array.isArray(content.subpaths) && content.subpaths.length > 0) {
    return content.subpaths.map(cloneSubpath)
  }
  if (Array.isArray(content.vertices) && content.vertices.length > 0) {
    return [{ vertices: content.vertices.map(cloneAnchor), closed: !!content.closed }]
  }
  if (Array.isArray(content.segments) && content.segments.length > 0) {
    return segmentsToSubpaths(content.segments)
  }
  return []
}

/** Reverse a sub-path's direction: vertices back-to-front, with each anchor's
 * `handleIn`/`handleOut` swapped (the tangents flip with the travel direction). */
export function reverseSubpath(sp: Subpath): Subpath {
  return {
    closed: sp.closed,
    vertices: sp.vertices
      .slice()
      .reverse()
      .map((a) => ({
        point: { x: a.point.x, y: a.point.y },
        ...(a.handleOut ? { handleIn: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
        ...(a.handleIn ? { handleOut: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
      })),
  }
}

/**
 * Join two open ends. With `aIdx === bIdx` this closes that one sub-path. With
 * two different sub-paths it merges them into a single OPEN ring: each is oriented
 * so the chosen ends become adjacent (A's joining end last, B's first), then their
 * vertices are concatenated — the connecting edge spans A's last and B's first
 * vertex. The merged ring takes the lower of the two slots; the other is removed.
 * Returns a new sub-path list (inputs untouched); a no-op clone if an index is bad.
 */
export function joinOpenEnds(
  subpaths: Subpath[],
  aIdx: number,
  aEnd: 'start' | 'end',
  bIdx: number,
  bEnd: 'start' | 'end',
): Subpath[] {
  const a = subpaths[aIdx]
  const b = subpaths[bIdx]
  if (!a || !b) return subpaths.map(cloneSubpath)

  if (aIdx === bIdx) {
    const out = subpaths.map(cloneSubpath)
    out[aIdx] = { vertices: a.vertices.map(cloneAnchor), closed: true }
    return out
  }

  const aOriented = aEnd === 'end' ? cloneSubpath(a) : reverseSubpath(a)
  const bOriented = bEnd === 'start' ? cloneSubpath(b) : reverseSubpath(b)
  const merged: Subpath = {
    vertices: [...aOriented.vertices, ...bOriented.vertices],
    closed: false,
  }

  const lo = Math.min(aIdx, bIdx)
  const out: Subpath[] = []
  for (let i = 0; i < subpaths.length; i++) {
    if (i === aIdx || i === bIdx) {
      if (i === lo) out.push(merged)
      continue
    }
    out.push(cloneSubpath(subpaths[i]))
  }
  return out
}

/**
 * Move every vertex coincident with `target` (within `eps` world units) by `delta`,
 * carrying its bézier handles. A node shared across sub-paths — a junction, e.g. a
 * line branching off a closed shape's corner — is exactly a set of coincident
 * vertices, so moving them together keeps the branch attached and the shape closed.
 * A non-shared vertex is a cluster of one, so an ordinary drag is unchanged.
 */
export function moveCoincidentPoint(
  subpaths: Subpath[],
  target: { x: number; y: number },
  delta: { x: number; y: number },
  eps = 1e-3,
): Subpath[] {
  const hit = (p: { x: number; y: number }) =>
    Math.abs(p.x - target.x) <= eps && Math.abs(p.y - target.y) <= eps
  const shift = (p: { x: number; y: number }) => ({ x: p.x + delta.x, y: p.y + delta.y })
  return subpaths.map((sp) => ({
    closed: sp.closed,
    vertices: sp.vertices.map((v) => {
      if (!hit(v.point)) return cloneAnchor(v)
      return {
        point: shift(v.point),
        ...(v.handleIn ? { handleIn: shift(v.handleIn) } : {}),
        ...(v.handleOut ? { handleOut: shift(v.handleOut) } : {}),
      }
    }),
  }))
}

/**
 * Build path content from sub-paths: stores the (cloned) sub-paths and a derived
 * SHARP `segments` mirror. A lone open/closed sub-path also exposes the single
 * `vertices`/`closed` fields so the existing single-path readers keep working.
 */
export function compoundContent(subpaths: Subpath[]): {
  subpaths: Subpath[]
  segments: PathSegment[]
  vertices?: Anchor[]
  closed?: boolean
} {
  const sp = subpaths.filter((s) => s.vertices.length > 0).map(cloneSubpath)
  const segments = subpathsToSegments(sp)
  if (sp.length === 1) {
    return { subpaths: sp, segments, vertices: sp[0].vertices, closed: sp[0].closed }
  }
  return { subpaths: sp, segments }
}
