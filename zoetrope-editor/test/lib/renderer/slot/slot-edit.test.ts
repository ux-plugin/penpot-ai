import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { count, getNode, undo } from '../../../../src/lib/doc'
import { framesOf } from '../../../../src/lib/doc/undo'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import { isSlotShape } from '../../../../src/lib/worker/geometry/shapes'
import { setActiveView, removeViewFromSlot, setSlotClip } from '../../../../src/lib/renderer/slot/slot-edit'
import { addNewViewToSlot } from '../../../../src/lib/renderer/slot/slot-authoring'
import type { SlotShape } from '../../../../src/lib/common/slot-shape'

const PAGE_ID = 'page1'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

/** One slot referencing two view frames. */
function seedPage(): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [
          { id: 'slot1', type: 'slot', name: 'Outlet', ...box(100, 100, 300, 200), views: ['home', 'about'], activeView: 'home', showContent: false },
          { id: 'home', type: 'frame', name: 'Home', ...box(500, 100, 300, 200) },
          { id: 'about', type: 'frame', name: 'About', ...box(900, 100, 300, 200) },
        ] as unknown as PenpotNode[],
      },
    ],
  })
}

function slot(): SlotShape {
  const s = getNode('slot1') as unknown as SlotShape | undefined
  if (!isSlotShape(s)) throw new Error('slot1 is not a slot')
  return s
}

describe('slot write-path (integration through the commit pipeline)', () => {
  beforeEach(() => {
    resetWorkspace()
    seedPage()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('setActiveView switches the design-time default', async () => {
    expect(slot().activeView).toBe('home')
    await setActiveView('slot1', 'about')
    expect(slot().activeView).toBe('about')
    expect(slot().views).toEqual(['home', 'about'])
  })

  it('removeViewFromSlot drops the candidate and re-defaults the active view', async () => {
    await removeViewFromSlot('slot1', 'home') // home was active
    expect(slot().views).toEqual(['about'])
    expect(slot().activeView).toBe('about') // fell back to the remaining candidate
  })

  it('setSlotClip toggles showContent and is a no-op when unchanged', async () => {
    expect(slot().showContent).toBe(false) // starts clipped
    await setSlotClip('slot1', false) // clip off -> showContent true
    expect(slot().showContent).toBe(true)

    const depth = framesOf().length
    await setSlotClip('slot1', false) // already unclipped -> no new history frame
    expect(framesOf().length).toBe(depth)
  })

  it('addNewViewToSlot creates a pre-sized view frame, registers it active, and is undoable', async () => {
    const before = count('node')
    const newId = await addNewViewToSlot('slot1')
    expect(newId).toBeTruthy()

    const created = getNode(newId as string)
    expect(created?.type).toBe('frame')
    // pre-sized to the slot's box
    expect(created?.width).toBe(300)
    expect(created?.height).toBe(200)
    // a top-level sibling, like any board
    expect(created?.parentId).toBeUndefined()

    // registered as a candidate and made active
    expect(slot().views).toContain(newId)
    expect(slot().activeView).toBe(newId)

    // undo removes the registration, then undo removes the frame
    await undo()
    await undo()
    expect(getNode(newId as string)).toBeUndefined()
    expect(count('node')).toBe(before)
  })
})
