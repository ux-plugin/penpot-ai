import { describe, expect, it } from 'vitest'
import { applyTransformToNode } from '../../../../src/lib/renderer/geom/apply-transform-to-node'
import type { Matrix, PenpotNode } from 'penpot-exporter/types'

const sr = (x: number, y: number, w: number, h: number) => ({
  x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h,
})

// A unit-square triangle path at world (100,100), 100×100.
const trianglePath = (): PenpotNode =>
  ({
    id: 't', type: 'path', name: 'Triangle 1',
    x: 100, y: 100, width: 100, height: 100,
    selrect: sr(100, 100, 100, 100),
    points: [
      { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 },
    ],
    content: {
      segments: [
        { type: 'move-to', x: 150, y: 100 },
        { type: 'line-to', x: 200, y: 200 },
        { type: 'line-to', x: 100, y: 200 },
        { type: 'close-path' },
      ],
    },
  }) as unknown as PenpotNode

describe('applyTransformToNode — path content', () => {
  it('bakes a 2x scale (about origin) into content.segments and bbox', () => {
    const scale2: Matrix = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }
    const out = applyTransformToNode(trianglePath(), scale2)
    expect(out).not.toBeNull()
    const segs = (out as { content: { segments: Array<Record<string, number>> } }).content.segments
    // every coordinate doubled
    expect(segs[0]).toMatchObject({ type: 'move-to', x: 300, y: 200 })
    expect(segs[1]).toMatchObject({ type: 'line-to', x: 400, y: 400 })
    // selrect follows the scaled geometry, not the old size
    expect(out!.selrect).toMatchObject({ x: 200, y: 200, width: 200, height: 200 })
    expect(out!.width).toBe(200)
    expect(out!.height).toBe(200)
  })

  it('keeps the transform identity so render does not double-apply', () => {
    const scale: Matrix = { a: 1.5, b: 0, c: 0, d: 1.5, e: 0, f: 0 }
    const out = applyTransformToNode(trianglePath(), scale)
    expect(out!.transform).toMatchObject({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(out!.rotation).toBe(0)
  })

  it('translates path content on a move (matrix with e/f offset)', () => {
    const move: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 40, f: -25 }
    const out = applyTransformToNode(trianglePath(), move)
    const segs = (out as { content: { segments: Array<Record<string, number>> } }).content.segments
    expect(segs[0]).toMatchObject({ type: 'move-to', x: 190, y: 75 })
    expect(out!.selrect).toMatchObject({ x: 140, y: 75 })
  })

  it('bakes the matrix into content.vertices and content.subpaths in lockstep', () => {
    const node = {
      id: 'c', type: 'path', name: 'Compound 1',
      x: 100, y: 100, width: 100, height: 100, selrect: sr(100, 100, 100, 100),
      points: [{ x: 100, y: 100 }],
      content: {
        vertices: [{ point: { x: 150, y: 100 } }, { point: { x: 200, y: 200 } }],
        subpaths: [
          { vertices: [{ point: { x: 150, y: 100 } }, { point: { x: 200, y: 200 } }], closed: false },
          { vertices: [{ point: { x: 100, y: 200 }, handleOut: { x: 110, y: 210 } }], closed: true },
        ],
        segments: [
          { type: 'move-to', x: 150, y: 100 },
          { type: 'line-to', x: 200, y: 200 },
          { type: 'move-to', x: 100, y: 200 },
          { type: 'close-path' },
        ],
      },
    } as unknown as PenpotNode
    const move: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 40, f: -25 }
    const out = applyTransformToNode(node, move)
    const content = (out as { content: Record<string, unknown> }).content as {
      vertices: Array<{ point: { x: number; y: number } }>
      subpaths: Array<{ vertices: Array<{ point: { x: number; y: number }; handleOut?: { x: number; y: number } }> }>
    }
    // vertices moved
    expect(content.vertices[0].point).toEqual({ x: 190, y: 75 })
    // both sub-paths moved (points + handles), in lockstep with segments
    expect(content.subpaths[0].vertices[0].point).toEqual({ x: 190, y: 75 })
    expect(content.subpaths[1].vertices[0].point).toEqual({ x: 140, y: 175 })
    expect(content.subpaths[1].vertices[0].handleOut).toEqual({ x: 150, y: 185 })
  })

  it('bakes the matrix into content.network nodes and edge handles', () => {
    const node = {
      id: 'n', type: 'path', name: 'Net 1',
      x: 100, y: 100, width: 100, height: 100, selrect: sr(100, 100, 100, 100),
      points: [{ x: 100, y: 100 }],
      content: {
        network: {
          nodes: [{ x: 150, y: 100 }, { x: 200, y: 200 }],
          edges: [{ a: 0, b: 1, ha: { x: 160, y: 110 } }],
        },
        segments: [
          { type: 'move-to', x: 150, y: 100 },
          { type: 'line-to', x: 200, y: 200 },
        ],
      },
    } as unknown as PenpotNode
    const move: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 40, f: -25 }
    const out = applyTransformToNode(node, move)
    const content = (out as { content: Record<string, unknown> }).content as {
      network: { nodes: Array<{ x: number; y: number }>; edges: Array<{ ha?: { x: number; y: number } }> }
    }
    expect(content.network.nodes[0]).toEqual({ x: 190, y: 75 })
    expect(content.network.nodes[1]).toEqual({ x: 240, y: 175 })
    expect(content.network.edges[0].ha).toEqual({ x: 200, y: 85 })
  })

  it('leaves a rect (no content.segments) on the standard selrect path', () => {
    const rect = {
      id: 'r', type: 'rect', x: 0, y: 0, width: 100, height: 100,
      selrect: sr(0, 0, 100, 100),
    } as unknown as PenpotNode
    const out = applyTransformToNode(rect, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })
    expect((out as { content?: unknown }).content).toBeUndefined()
    expect(out!.width).toBe(200)
  })
})

describe('applyTransformToNode — path rotation: baked geometry + oriented box metadata', () => {
  it('bakes the rotated segments AND keeps rotation/transform (oriented box)', () => {
    const rot90: Matrix = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }
    const out = applyTransformToNode(trianglePath(), rot90)
    expect(out).not.toBeNull()
    const segs = (out as { content: { segments: Array<Record<string, number>> } }).content.segments
    // segments ARE baked (rotated): (150,100) -> (-100,150) under (x,y)->(-y,x)
    expect(segs[0]).toMatchObject({ type: 'move-to', x: -100, y: 150 })
    // ...but the box is oriented, not flattened
    expect(out!.rotation).toBeCloseTo(90, 3)
    expect(out!.transform).toMatchObject({ a: 0, b: 1, c: -1, d: 0 })
  })
})
