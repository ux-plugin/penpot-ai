/**
 * Apply a 2D affine transform matrix to a shape's geometry.
 * Used for move, resize, and rotate commit (propagated result from WASM).
 */

import type { Matrix, PenpotNode } from 'penpot-exporter/types'
import type { PathSegment } from '../types'
import { makeSelrect } from '../types'
import { invertMatrix } from './matrix'
import { cubicBounds } from './anchors'

export function applyTransformToNode(
  node: PenpotNode,
  matrix: Matrix
): Partial<PenpotNode> | null {
  const sr = node.selrect
  if (!sr) return null
  const x = sr.x ?? 0
  const y = sr.y ?? 0
  const w = sr.width ?? 0
  const h = sr.height ?? 0
  if (w <= 0 || h <= 0) return null

  const { a: ma, b: mb, c: mc, d: md, e: me, f: mf } = matrix
  const T = node.transform

  const cx = x + w / 2
  const cy = y + h / 2

  const worldCorner = (dx: number, dy: number): { x: number; y: number } => {
    if (!T) return { x: cx + dx, y: cy + dy }
    return {
      x: cx + T.a * dx + T.c * dy,
      y: cy + T.b * dx + T.d * dy,
    }
  }

  const wNw = worldCorner(-w / 2, -h / 2)
  const wNe = worldCorner(w / 2, -h / 2)
  const wSe = worldCorner(w / 2, h / 2)
  const wSw = worldCorner(-w / 2, h / 2)

  const applyM = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: ma * p.x + mc * p.y + me,
    y: mb * p.x + md * p.y + mf,
  })

  const newNw = applyM(wNw)
  const newNe = applyM(wNe)
  const newSe = applyM(wSe)
  const newSw = applyM(wSw)

  const newCx = ma * cx + mc * cy + me
  const newCy = mb * cx + md * cy + mf

  const newWidth = Math.sqrt((newNe.x - newNw.x) ** 2 + (newNe.y - newNw.y) ** 2)
  const newHeight = Math.sqrt((newSw.x - newNw.x) ** 2 + (newSw.y - newNw.y) ** 2)

  if (newWidth <= 0 || newHeight <= 0) return null

  const newX = newCx - newWidth / 2
  const newY = newCy - newHeight / 2
  const selrect = makeSelrect(newX, newY, newWidth, newHeight)

  const hvx = (newNe.x - newNw.x) / newWidth
  const hvy = (newNe.y - newNw.y) / newWidth
  const vvx = (newSw.x - newNw.x) / newHeight
  const vvy = (newSw.y - newNw.y) / newHeight
  const newTransform: Matrix = { a: hvx, b: hvy, c: vvx, d: vvy, e: 0, f: 0 }
  const newTransformInverse = invertMatrix(newTransform)
  const points = [newNw, newNe, newSe, newSw]

  const updates: Partial<PenpotNode> = {
    selrect,
    points,
    transform: newTransform,
    transformInverse: newTransformInverse ?? undefined,
    rotation: Math.atan2(hvy, hvx) * (180 / Math.PI),
  }
  if (typeof node.x === 'number') updates.x = newX
  if (typeof node.y === 'number') updates.y = newY
  if (typeof node.width === 'number') updates.width = newWidth
  if (typeof node.height === 'number') updates.height = newHeight

  // Path geometry lives in absolute `content.segments` — render-wasm draws them
  // directly (applying only the shape transform around its centre). The rect/
  // circle decomposition above updates selrect/transform but leaves the segments
  // untouched, so a path snaps back to its original shape on commit (and never
  // moves). Bake the matrix into the segments instead, derive the bbox from
  // them, and keep the transform identity (its creation state) so the renderer
  // doesn't double-apply.
  type XY = { x: number; y: number }
  type VertexLike = { point: XY; handleIn?: XY; handleOut?: XY }
  type SubpathLike = { vertices: VertexLike[]; closed: boolean }
  type EdgeLike = { a: number; b: number; ha?: XY; hb?: XY }
  type NetworkLike = { nodes: XY[]; edges: EdgeLike[] }
  const bakeVerts = (vs: VertexLike[]): VertexLike[] =>
    vs.map((v) => ({
      point: applyM(v.point),
      ...(v.handleIn ? { handleIn: applyM(v.handleIn) } : {}),
      ...(v.handleOut ? { handleOut: applyM(v.handleOut) } : {}),
    }))
  const content = (
    node as {
      content?: {
        segments?: PathSegment[]
        vertices?: VertexLike[]
        subpaths?: SubpathLike[]
        network?: NetworkLike
      }
    }
  ).content
  const segs = content?.segments
  if (content && Array.isArray(segs) && segs.length > 0) {
    // Vertices / sub-paths are the canonical editable model — bake the matrix into
    // them too, in lockstep with the segments, so the editable path doesn't go
    // stale (the editor reads sub-paths first, so this is what kept the overlay
    // sitting at the old position after a move/resize).
    const verts = content.vertices
    const newVertices: VertexLike[] | undefined = Array.isArray(verts) ? bakeVerts(verts) : undefined
    const subs = content.subpaths
    const newSubpaths: SubpathLike[] | undefined = Array.isArray(subs)
      ? subs.map((sp) => ({ vertices: bakeVerts(sp.vertices), closed: sp.closed }))
      : undefined
    // The vector network is canonical for editing junctions — bake its node points
    // and edge handles too, so a moved/resized junction shape stays consistent.
    const net = content.network
    const newNetwork: NetworkLike | undefined =
      net && Array.isArray(net.nodes)
        ? {
            nodes: net.nodes.map((n) => applyM(n)),
            edges: net.edges.map((e) => ({
              a: e.a,
              b: e.b,
              ...(e.ha ? { ha: applyM(e.ha) } : {}),
              ...(e.hb ? { hb: applyM(e.hb) } : {}),
            })),
          }
        : undefined
    const newSegments: PathSegment[] = segs.map((s) => {
      if (s.type === 'move-to' || s.type === 'line-to') {
        const p = applyM({ x: s.x, y: s.y })
        return { ...s, x: p.x, y: p.y }
      }
      if (s.type === 'curve-to') {
        const p = applyM({ x: s.x, y: s.y })
        const c1 = applyM({ x: s.c1x, y: s.c1y })
        const c2 = applyM({ x: s.c2x, y: s.c2y })
        return { ...s, x: p.x, y: p.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y }
      }
      return s
    })

    const bakedContent = {
      ...content,
      ...(newVertices ? { vertices: newVertices } : {}),
      ...(newSubpaths ? { subpaths: newSubpaths } : {}),
      ...(newNetwork ? { network: newNetwork } : {}),
      segments: newSegments,
    } as PenpotNode['content']

    // The BOX is recomputed as the TIGHT bounds of the baked CURVE, expressed in the
    // box's own (possibly rotated) orientation — not carried from the old selrect.
    // Carrying it forward let two errors persist: a control-hull-loose original box
    // stayed loose forever (visible slack between box and path), and the box centre
    // tracked the old selrect centre rather than the curve's. Re-measuring the actual
    // cubics here (exact extrema, in the oriented frame) makes the box hug the curve
    // AND keeps an existing rotation tight through later move/resize — Penpot's selrect
    // is likewise always the tight geometry bounds. render-wasm honors the stored
    // selrect/transform for the box and draws the baked geometry directly (no
    // double-transform). Falls back to `updates` if the orientation isn't invertible.
    const tight = newTransformInverse
      ? tightOrientedBox(newSegments, newCx, newCy, newTransform, newTransformInverse)
      : null
    if (tight) {
      const boxed: Partial<PenpotNode> = {
        ...updates,
        selrect: makeSelrect(tight.x, tight.y, tight.width, tight.height),
        points: tight.points,
      }
      if (typeof node.x === 'number') boxed.x = tight.x
      if (typeof node.y === 'number') boxed.y = tight.y
      if (typeof node.width === 'number') boxed.width = tight.width
      if (typeof node.height === 'number') boxed.height = tight.height
      return { ...boxed, content: bakedContent }
    }
    return { ...updates, content: bakedContent }
  }

  return updates
}

type XYp = { x: number; y: number }

/** Walk path segments into cubic control quads (a line becomes a degenerate cubic
 *  with handles at its endpoints). `close-path` is a straight join between points
 *  already covered by other segments, so it contributes nothing new. */
function cubicsFromSegments(segs: PathSegment[]): [XYp, XYp, XYp, XYp][] {
  const out: [XYp, XYp, XYp, XYp][] = []
  let cur: XYp | null = null
  for (const s of segs) {
    if (s.type === 'move-to') {
      cur = { x: s.x, y: s.y }
    } else if (s.type === 'line-to') {
      if (cur) out.push([cur, cur, { x: s.x, y: s.y }, { x: s.x, y: s.y }])
      cur = { x: s.x, y: s.y }
    } else if (s.type === 'curve-to') {
      const end = { x: s.x, y: s.y }
      if (cur) out.push([cur, { x: s.c1x, y: s.c1y }, { x: s.c2x, y: s.c2y }, end])
      cur = end
    }
  }
  return out
}

/** Tight bounds of the baked curve in the box's oriented frame: project each cubic
 *  into local coords (via the inverse transform), take its exact extent, then map
 *  the local AABB's centre + corners back to world. Returns the centred selrect
 *  (x/y/width/height) plus the four rotated corner `points`. */
function tightOrientedBox(
  segs: PathSegment[],
  cx: number,
  cy: number,
  transform: Matrix,
  inverse: Matrix
): { x: number; y: number; width: number; height: number; points: XYp[] } | null {
  const toLocal = (p: XYp): XYp => {
    const dx = p.x - cx
    const dy = p.y - cy
    return { x: inverse.a * dx + inverse.c * dy, y: inverse.b * dx + inverse.d * dy }
  }
  let lminX = Infinity
  let lminY = Infinity
  let lmaxX = -Infinity
  let lmaxY = -Infinity
  for (const [c0, c1, c2, c3] of cubicsFromSegments(segs)) {
    const lb = cubicBounds(toLocal(c0), toLocal(c1), toLocal(c2), toLocal(c3))
    if (lb.minX < lminX) lminX = lb.minX
    if (lb.minY < lminY) lminY = lb.minY
    if (lb.maxX > lmaxX) lmaxX = lb.maxX
    if (lb.maxY > lmaxY) lmaxY = lb.maxY
  }
  if (!Number.isFinite(lminX) || lmaxX <= lminX || lmaxY <= lminY) return null
  const tW = lmaxX - lminX
  const tH = lmaxY - lminY
  const lcx = (lminX + lmaxX) / 2
  const lcy = (lminY + lmaxY) / 2
  const toWorld = (lx: number, ly: number): XYp => ({
    x: cx + transform.a * lx + transform.c * ly,
    y: cy + transform.b * lx + transform.d * ly,
  })
  const wc = toWorld(lcx, lcy)
  const corner = (sx: number, sy: number): XYp => toWorld(lcx + sx * (tW / 2), lcy + sy * (tH / 2))
  return {
    x: wc.x - tW / 2,
    y: wc.y - tH / 2,
    width: tW,
    height: tH,
    points: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
  }
}
