import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { pageObjects } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import { resolveHoveredSlot } from '../../../../src/lib/renderer/slot/slot-hover'

const PAGE_ID = 'page1'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

/** Two slots (one nested inside the other's bounds) and a frame. */
function seedPage(): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [
          { id: 'slot1', type: 'slot', name: 'Body', ...box(100, 100, 400, 300) },
          { id: 'small', type: 'slot', name: 'Sidebar', ...box(150, 150, 100, 100) },
          { id: 'frame1', type: 'frame', name: 'Card', ...box(700, 100, 200, 200) },
        ] as unknown as PenpotNode[],
      },
    ],
  })
}

const objects = () => pageObjects(PAGE_ID)

describe('empty-slot hover', () => {
  beforeEach(() => {
    resetWorkspace()
    seedPage()
  })

  it('reveals the slot under the cursor, with its box and name', () => {
    const hovered = resolveHoveredSlot(objects(), { x: 300, y: 350 }, false)
    expect(hovered).toEqual({
      id: 'slot1',
      name: 'Body',
      rect: { x: 100, y: 100, width: 400, height: 300 },
    })
  })

  it('prefers the innermost slot when they overlap', () => {
    expect(resolveHoveredSlot(objects(), { x: 200, y: 200 }, false)?.id).toBe('small')
  })

  it('ignores frames — only slots need revealing', () => {
    expect(resolveHoveredSlot(objects(), { x: 800, y: 200 }, false)).toBeNull()
  })

  it('is silent off any slot', () => {
    expect(resolveHoveredSlot(objects(), { x: 1000, y: 700 }, false)).toBeNull()
  })

  it('is silent while a drag is in flight — the drop overlay owns that box', () => {
    expect(resolveHoveredSlot(objects(), { x: 300, y: 350 }, true)).toBeNull()
  })

  it('is silent without a pointer or a page', () => {
    expect(resolveHoveredSlot(objects(), null, false)).toBeNull()
    expect(resolveHoveredSlot(undefined, { x: 300, y: 350 }, false)).toBeNull()
  })
})
