import { describe, expect, it } from 'vitest'
import { createLine, createPolyline, createBezierPath } from '../../../src/lib/renderer/node-factory'
import type { Anchor } from '../../../src/lib/renderer/geom/anchors'

describe('createLine', () => {
  it('stores the actual endpoints as world segments (any direction)', () => {
    // Drag up-and-to-the-right: end is above-right of start.
    const node = createLine({ x1: 100, y1: 200, x2: 260, y2: 80, strokeColor: '#1E40AF' })
    const segs = (node as { content: { segments: Array<Record<string, number>> } }).content.segments
    expect(segs).toEqual([
      { type: 'move-to', x: 100, y: 200 },
      { type: 'line-to', x: 260, y: 80 },
    ])
    // points mirror the endpoints
    expect(node.points).toEqual([
      { x: 100, y: 200 },
      { x: 260, y: 80 },
    ])
  })

  it('selrect is the bounding box of the endpoints (top-left origin)', () => {
    const node = createLine({ x1: 100, y1: 200, x2: 260, y2: 80 })
    expect(node.selrect).toMatchObject({ x: 100, y: 80, width: 160, height: 120 })
    expect(node).toMatchObject({ type: 'path', x: 100, y: 80, width: 160, height: 120 })
  })

  it('is an open, stroke-only path (no fill, no close)', () => {
    const node = createLine({ x1: 0, y1: 0, x2: 50, y2: 50, strokeColor: '#000' })
    const segs = (node as { content: { segments: Array<{ type: string }> } }).content.segments
    expect(segs.some((s) => s.type === 'close-path')).toBe(false)
    expect(node.fills ?? []).toHaveLength(0)
    expect(node.strokes).toHaveLength(1)
  })
})

describe('createPolyline', () => {
  const pts = [
    { x: 10, y: 10 },
    { x: 110, y: 30 },
    { x: 60, y: 130 },
  ]

  it('open polyline: move-to + line-tos, no close, stroke only', () => {
    const node = createPolyline(pts, { strokeColor: '#1E40AF' })
    const segs = (node as { content: { segments: Array<{ type: string }> } }).content.segments
    expect(segs.map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to'])
    expect(node.fills ?? []).toHaveLength(0)
    expect(node.strokes).toHaveLength(1)
    expect(node.selrect).toMatchObject({ x: 10, y: 10, width: 100, height: 120 })
  })

  it('closed polyline: appends close-path and carries a fill', () => {
    const node = createPolyline(pts, { closed: true, strokeColor: '#1E40AF', fillColor: '#3B82F6' })
    const segs = (node as { content: { segments: Array<{ type: string }> } }).content.segments
    expect(segs.map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to', 'close-path'])
    expect(node.fills).toHaveLength(1)
  })

  it('points hull mirrors the anchors', () => {
    expect(createPolyline(pts, {}).points).toEqual(pts)
  })
})

describe('createBezierPath', () => {
  it('all-corner anchors produce the same line segments as a polyline', () => {
    const anchors: Anchor[] = [
      { point: { x: 10, y: 10 } },
      { point: { x: 110, y: 30 } },
      { point: { x: 60, y: 130 } },
    ]
    const node = createBezierPath(anchors, { strokeColor: '#1E40AF' })
    const segs = (node as { content: { segments: Array<{ type: string }> } }).content.segments
    expect(segs.map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to'])
    expect(node.points).toEqual(anchors.map((a) => a.point))
    expect(node.selrect).toMatchObject({ x: 10, y: 10, width: 100, height: 120 })
  })

  it('emits curve-to segments and selrect bounds the tight curve, not the handles', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 10, y: -40 } },
      { point: { x: 100, y: 0 }, handleIn: { x: 90, y: -40 } },
    ]
    const node = createBezierPath(anchors, { strokeColor: '#1E40AF' })
    const segs = (node as { content: { segments: Array<Record<string, number>> } }).content.segments
    expect(segs[1]).toMatchObject({ type: 'curve-to', x: 100, y: 0, c1x: 10, c1y: -40, c2x: 90, c2y: -40 })
    // Handles reach y = -40, but the symmetric cubic only peaks at y = -30 (¾ of
    // the handle), so the TIGHT box stops there instead of at the control hull.
    expect(node.selrect).toMatchObject({ x: 0, y: -30, width: 100, height: 30 })
    // points stays the vertex hull (handles excluded).
    expect(node.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
  })

  it('closed path appends close-path and carries a fill', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 } },
      { point: { x: 10, y: 0 } },
      { point: { x: 5, y: 10 } },
    ]
    const node = createBezierPath(anchors, { closed: true, strokeColor: '#1E40AF', fillColor: '#3B82F6' })
    const segs = (node as { content: { segments: Array<{ type: string }> } }).content.segments
    expect(segs[segs.length - 1].type).toBe('close-path')
    expect(node.fills).toHaveLength(1)
  })
})
