import { describe, expect, it } from 'vitest'
import type { IndexedShape } from '../../../../src/lib/worker/types'
import { resolveHoveredSlot } from '../../../../src/lib/renderer/slot/slot-hover'

const ROOT = '00000000-0000-0000-0000-000000000000'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

const objects = {
  [ROOT]: {
    id: ROOT,
    type: 'frame',
    name: 'Root',
    ...box(0, 0, 1200, 800),
    selrect: box(0, 0, 1200, 800),
    shapes: ['slot1', 'small', 'frame1'],
  },
  slot1: {
    id: 'slot1',
    type: 'slot',
    name: 'Body',
    ...box(100, 100, 400, 300),
    selrect: box(100, 100, 400, 300),
    parentId: ROOT,
  },
  // A smaller slot nested inside the first one's bounds.
  small: {
    id: 'small',
    type: 'slot',
    name: 'Sidebar',
    ...box(150, 150, 100, 100),
    selrect: box(150, 150, 100, 100),
    parentId: ROOT,
  },
  frame1: {
    id: 'frame1',
    type: 'frame',
    name: 'Card',
    ...box(700, 100, 200, 200),
    selrect: box(700, 100, 200, 200),
    parentId: ROOT,
  },
} as unknown as Record<string, IndexedShape>

describe('empty-slot hover', () => {
  it('reveals the slot under the cursor, with its box and name', () => {
    const hovered = resolveHoveredSlot(objects, { x: 300, y: 350 }, false)
    expect(hovered).toEqual({
      id: 'slot1',
      name: 'Body',
      rect: { x: 100, y: 100, width: 400, height: 300 },
    })
  })

  it('prefers the innermost slot when they overlap', () => {
    expect(resolveHoveredSlot(objects, { x: 200, y: 200 }, false)?.id).toBe('small')
  })

  it('ignores frames — only slots need revealing', () => {
    expect(resolveHoveredSlot(objects, { x: 800, y: 200 }, false)).toBeNull()
  })

  it('is silent off any slot', () => {
    expect(resolveHoveredSlot(objects, { x: 1000, y: 700 }, false)).toBeNull()
  })

  it('is silent while a drag is in flight — the drop overlay owns that box', () => {
    expect(resolveHoveredSlot(objects, { x: 300, y: 350 }, true)).toBeNull()
  })

  it('is silent without a pointer or a page', () => {
    expect(resolveHoveredSlot(objects, null, false)).toBeNull()
    expect(resolveHoveredSlot(undefined, { x: 300, y: 350 }, false)).toBeNull()
  })
})
