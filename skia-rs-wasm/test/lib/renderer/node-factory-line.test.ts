import { describe, expect, it } from 'vitest'
import { createLine } from '../../../src/lib/renderer/node-factory'

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
