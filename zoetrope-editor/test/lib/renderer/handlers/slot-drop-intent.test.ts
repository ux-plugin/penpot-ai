import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { pageObjects } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import {
  resolveDropIntent,
  resolveSlotDropIntent,
  SLOT_DROP_LABEL,
} from '../../../../src/lib/renderer/handlers/drop-intent'

const PAGE_ID = 'p1'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

/** A slot, a frame to drop, a plain rect, and a real container. */
function seedPage(): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [
          { id: 'slot1', type: 'slot', name: 'Outlet', ...box(100, 100, 300, 200), views: [] },
          { id: 'home', type: 'frame', name: 'Home', ...box(600, 100, 200, 150) },
          { id: 'plain', type: 'rect', name: 'Rect', ...box(600, 400, 100, 100) },
          { id: 'holder', type: 'frame', name: 'Holder', ...box(800, 400, 300, 200) },
        ] as unknown as PenpotNode[],
      },
    ],
  })
}

const objects = () => pageObjects(PAGE_ID)

/** A point inside the slot. */
const OVER_SLOT = { x: 200, y: 180 }

describe('slot drop intent', () => {
  beforeEach(() => {
    resetWorkspace()
    seedPage()
  })

  it('arms when a single frame is dragged with the cursor over a slot', () => {
    const intent = resolveSlotDropIntent(new Set(['home']), objects(), OVER_SLOT)
    expect(intent).not.toBeNull()
    expect(intent!.targetId).toBe('slot1')
    expect(intent!.label).toBe(SLOT_DROP_LABEL)
    expect(intent!.targetRect).toEqual({ x: 100, y: 100, width: 300, height: 200 })
    // Nothing about this is a reparent: no insertion line, no gap footprint.
    expect(intent!.line).toBeNull()
    expect(intent!.footprint).toBeNull()
  })

  it('does not arm off the slot', () => {
    expect(resolveSlotDropIntent(new Set(['home']), objects(), { x: 900, y: 700 })).toBeNull()
  })

  it('does not arm for a multi-selection — no answer for which view is active', () => {
    expect(resolveSlotDropIntent(new Set(['home', 'plain']), objects(), OVER_SLOT)).toBeNull()
  })

  it('does not arm for a non-frame — only frames are views', () => {
    expect(resolveSlotDropIntent(new Set(['plain']), objects(), OVER_SLOT)).toBeNull()
  })

  it('does not arm for the slot dragged over itself', () => {
    expect(resolveSlotDropIntent(new Set(['slot1']), objects(), OVER_SLOT)).toBeNull()
  })

  describe('coexistence with the reparent path', () => {
    it('the reparent path still ignores slots entirely', () => {
      // This is why the gesture is needed at all: dragging over a slot resolves
      // to nothing on the reparent side, so without arming, the drop falls
      // through to whatever container is underneath.
      const intent = resolveDropIntent(new Set(['home']), objects(), OVER_SLOT)
      expect(intent).toBeNull()
    })

    it('a real container still reparents, unaffected', () => {
      const intent = resolveDropIntent(new Set(['home']), objects(), { x: 900, y: 500 })
      expect(intent?.targetId).toBe('holder')
    })

    it('a frame over a real container never arms a slot drop', () => {
      expect(resolveSlotDropIntent(new Set(['home']), objects(), { x: 900, y: 500 })).toBeNull()
    })
  })
})
