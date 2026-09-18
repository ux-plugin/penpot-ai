import { describe, expect, it } from 'vitest'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import {
  resolveDropIntent,
  resolveSlotDropIntent,
  SLOT_DROP_LABEL,
} from '../../../../src/lib/renderer/handlers/drop-intent'

const ROOT = '00000000-0000-0000-0000-000000000000'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

/** Root with a slot, a frame to drop, a plain rect, and a real container. */
function makePage(): IndexedPage {
  return {
    id: 'p1',
    objects: {
      [ROOT]: {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        ...box(0, 0, 1200, 800),
        selrect: box(0, 0, 1200, 800),
        shapes: ['slot1', 'home', 'plain', 'holder'],
      },
      slot1: {
        id: 'slot1',
        type: 'slot',
        name: 'Outlet',
        ...box(100, 100, 300, 200),
        selrect: box(100, 100, 300, 200),
        parentId: ROOT,
        views: [],
      },
      home: {
        id: 'home',
        type: 'frame',
        name: 'Home',
        ...box(600, 100, 200, 150),
        selrect: box(600, 100, 200, 150),
        parentId: ROOT,
        shapes: [],
      },
      plain: {
        id: 'plain',
        type: 'rect',
        name: 'Rect',
        ...box(600, 400, 100, 100),
        selrect: box(600, 400, 100, 100),
        parentId: ROOT,
      },
      holder: {
        id: 'holder',
        type: 'frame',
        name: 'Holder',
        ...box(800, 400, 300, 200),
        selrect: box(800, 400, 300, 200),
        parentId: ROOT,
        shapes: [],
      },
    },
  } as unknown as IndexedPage
}

/** A point inside the slot. */
const OVER_SLOT = { x: 200, y: 180 }

describe('slot drop intent', () => {
  const page = makePage()

  it('arms when a single frame is dragged with the cursor over a slot', () => {
    const intent = resolveSlotDropIntent(new Set(['home']), page, OVER_SLOT)
    expect(intent).not.toBeNull()
    expect(intent!.targetId).toBe('slot1')
    expect(intent!.label).toBe(SLOT_DROP_LABEL)
    expect(intent!.targetRect).toEqual({ x: 100, y: 100, width: 300, height: 200 })
    // Nothing about this is a reparent: no insertion line, no gap footprint.
    expect(intent!.line).toBeNull()
    expect(intent!.footprint).toBeNull()
  })

  it('does not arm off the slot', () => {
    expect(resolveSlotDropIntent(new Set(['home']), page, { x: 900, y: 700 })).toBeNull()
  })

  it('does not arm for a multi-selection — no answer for which view is active', () => {
    expect(resolveSlotDropIntent(new Set(['home', 'plain']), page, OVER_SLOT)).toBeNull()
  })

  it('does not arm for a non-frame — only frames are views', () => {
    expect(resolveSlotDropIntent(new Set(['plain']), page, OVER_SLOT)).toBeNull()
  })

  it('does not arm for the slot dragged over itself', () => {
    expect(resolveSlotDropIntent(new Set(['slot1']), page, OVER_SLOT)).toBeNull()
  })

  describe('coexistence with the reparent path', () => {
    it('the reparent path still ignores slots entirely', () => {
      // This is why the gesture is needed at all: dragging over a slot resolves
      // to nothing on the reparent side, so without arming, the drop falls
      // through to whatever container is underneath.
      const intent = resolveDropIntent(new Set(['home']), page, OVER_SLOT)
      expect(intent).toBeNull()
    })

    it('a real container still reparents, unaffected', () => {
      const intent = resolveDropIntent(new Set(['home']), page, { x: 900, y: 500 })
      expect(intent?.targetId).toBe('holder')
    })

    it('a frame over a real container never arms a slot drop', () => {
      expect(resolveSlotDropIntent(new Set(['home']), page, { x: 900, y: 500 })).toBeNull()
    })
  })
})
