/**
 * Apply a 2D affine transform matrix to a shape's geometry.
 * Used for move, resize, and rotate commit (propagated result from WASM).
 */

import type { Matrix, PenpotNode } from 'penpot-exporter/types'
import type { PathSegment } from '../types'
import { makeSelrect } from '../types'
import { invertMatrix } from './matrix'

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

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
  const content = (node as { content?: { segments?: PathSegment[]; vertices?: VertexLike[] } }).content
  const segs = content?.segments
  if (content && Array.isArray(segs) && segs.length > 0) {
    // Vertices are the canonical model — bake the matrix into them too, in
    // lockstep with the segments, so the editable path doesn't go stale.
    const verts = content.vertices
    const newVertices: VertexLike[] | undefined = Array.isArray(verts)
      ? verts.map((v) => ({
          point: applyM(v.point),
          ...(v.handleIn ? { handleIn: applyM(v.handleIn) } : {}),
          ...(v.handleOut ? { handleOut: applyM(v.handleOut) } : {}),
        }))
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

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const acc = (px: number, py: number) => {
      if (px < minX) minX = px
      if (py < minY) minY = py
      if (px > maxX) maxX = px
      if (py > maxY) maxY = py
    }
    for (const s of newSegments) {
      if (s.type === 'move-to' || s.type === 'line-to') acc(s.x, s.y)
      else if (s.type === 'curve-to') {
        acc(s.x, s.y)
        acc(s.c1x, s.c1y)
        acc(s.c2x, s.c2y)
      }
    }
    if (!Number.isFinite(minX)) return updates

    const bw = Math.max(0, maxX - minX)
    const bh = Math.max(0, maxY - minY)

    const pathUpdates: Partial<PenpotNode> = {
      content: {
        ...content,
        ...(newVertices ? { vertices: newVertices } : {}),
        segments: newSegments,
      } as PenpotNode['content'],
      selrect: makeSelrect(minX, minY, bw, bh),
      points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
      transform: IDENTITY,
      transformInverse: IDENTITY,
      rotation: 0,
    }
    if (typeof node.x === 'number') pathUpdates.x = minX
    if (typeof node.y === 'number') pathUpdates.y = minY
    if (typeof node.width === 'number') pathUpdates.width = bw
    if (typeof node.height === 'number') pathUpdates.height = bh
    return pathUpdates
  }

  return updates
}
