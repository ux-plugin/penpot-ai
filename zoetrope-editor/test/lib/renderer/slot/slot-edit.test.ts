import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { undo } from '../../../../src/lib/page-crud'
import { getCommittedNodeOnActivePage } from '../../../../src/lib/renderer/properties/commit-node-properties'
import { isSlotShape } from '../../../../src/lib/worker/geometry/shapes'
import { setActiveView, removeViewFromSlot, setSlotClip } from '../../../../src/lib/renderer/slot/slot-edit'
import { addNewViewToSlot } from '../../../../src/lib/renderer/slot/slot-authoring'
import type { SlotShape } from '../../../../src/lib/common/slot-shape'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

/** Root + one slot referencing two view frames. */
function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: { id: ROOT, type: 'frame', name: 'Root', ...rect(0, 0, 1200, 800), shapes: ['slot1', 'home', 'about'] },
      slot1: {
        id: 'slot1',
        type: 'slot',
        name: 'Outlet',
        ...rect(100, 100, 300, 200),
        selrect: rect(100, 100, 300, 200),
        parentId: ROOT,
        views: ['home', 'about'],
        activeView: 'home',
        showContent: false,
      },
      home: { id: 'home', type: 'frame', name: 'Home', ...rect(500, 100, 300, 200), selrect: rect(500, 100, 300, 200), parentId: ROOT, shapes: [] },
      about: { id: 'about', type: 'frame', name: 'About', ...rect(900, 100, 300, 200), selrect: rect(900, 100, 300, 200), parentId: ROOT, shapes: [] },
    },
  } as unknown as IndexedPage
}

function slot(): SlotShape {
  const s = getCommittedNodeOnActivePage('slot1')
  if (!isSlotShape(s)) throw new Error('slot1 is not a slot')
  return s
}

describe('slot write-path (integration through the commit pipeline)', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [], transaction: null })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, makePage())
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    useWorkspaceStore.setState({
      workerClient: { updatePageWithChanges: vi.fn(async () => {}), updatePage: vi.fn(async () => {}) } as never,
      renderer: null,
    })
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

    const depth = useHistoryStore.getState().undoStack.length
    await setSlotClip('slot1', false) // already unclipped -> no new history frame
    expect(useHistoryStore.getState().undoStack.length).toBe(depth)
  })

  it('addNewViewToSlot creates a pre-sized view frame, registers it active, and is undoable', async () => {
    const beforeIds = Object.keys(docProxy.pageMap.get(PAGE_ID)!.objects)
    const newId = await addNewViewToSlot('slot1')
    expect(newId).toBeTruthy()

    const objects = docProxy.pageMap.get(PAGE_ID)!.objects
    const created = objects[newId as string] as { type?: string; width?: number; height?: number; parentId?: string }
    expect(created?.type).toBe('frame')
    // pre-sized to the slot's box
    expect(created?.width).toBe(300)
    expect(created?.height).toBe(200)
    expect(created?.parentId).toBe(ROOT)

    // registered as a candidate and made active
    expect(slot().views).toContain(newId)
    expect(slot().activeView).toBe(newId)

    // undo removes the registration, then undo removes the frame
    await undo()
    await undo()
    const after = Object.keys(docProxy.pageMap.get(PAGE_ID)!.objects)
    expect(after.sort()).toEqual(beforeIds.sort())
  })
})
