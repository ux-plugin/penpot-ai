import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { undo } from '../../../../src/lib/page-crud'
import {
  convertFrameToSlot,
  convertSlotToFrame,
} from '../../../../src/lib/renderer/slot/slot-authoring'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

/**
 * Root
 *  └ shell (frame 100,100 300x200)
 *      ├ child (rect 120,120 50x50)
 *      └ inner (frame 200,140 80x40)
 *          └ deep (rect 210,150 20x20)
 */
function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: { id: ROOT, type: 'frame', name: 'Root', ...box(0, 0, 1200, 800), shapes: ['shell'] },
      shell: { id: 'shell', type: 'frame', name: 'Shell', ...box(100, 100, 300, 200), parentId: ROOT, frameId: ROOT, shapes: ['child', 'inner'] },
      child: { id: 'child', type: 'rect', name: 'Child', ...box(120, 120, 50, 50), parentId: 'shell', frameId: 'shell' },
      inner: { id: 'inner', type: 'frame', name: 'Inner', ...box(200, 140, 80, 40), parentId: 'shell', frameId: 'shell', shapes: ['deep'] },
      deep: { id: 'deep', type: 'rect', name: 'Deep', ...box(210, 150, 20, 20), parentId: 'inner', frameId: 'inner' },
    },
  } as unknown as IndexedPage
}

const objects = (): Record<string, IndexedShape> => docProxy.pageMap.get(PAGE_ID)!.objects
const node = (id: string) => objects()[id] as IndexedShape & { views?: string[]; activeView?: string }

describe('convert frame <-> slot', () => {
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

  it('extracts a populated frame\'s content into a view frame the new slot shows', async () => {
    const viewId = await convertFrameToSlot('shell')
    expect(viewId).toBeTruthy()

    // the frame became a slot referencing the extracted view, and owns no children
    const slot = node('shell')
    expect(slot.type).toBe('slot')
    expect(slot.views).toEqual([viewId])
    expect(slot.activeView).toBe(viewId)
    expect(Array.isArray(slot.shapes)).toBe(false)
    // ...keeping its own id and box
    expect(slot.selrect).toMatchObject({ x: 100, y: 100, width: 300, height: 200 })

    // the view frame sits beside the slot, same size
    const view = node(viewId as string)
    expect(view.type).toBe('frame')
    expect(view.selrect).toMatchObject({ x: 100 + 300 + 40, y: 100, width: 300, height: 200 })
    expect(view.shapes).toEqual(['child', 'inner'])
  })

  it('translates the whole extracted subtree so content lands inside the view frame', async () => {
    await convertFrameToSlot('shell')
    const dx = 300 + 40

    // direct child, nested frame, and its descendant all shift by the same delta
    expect(node('child').selrect).toMatchObject({ x: 120 + dx, y: 120 })
    expect(node('inner').selrect).toMatchObject({ x: 200 + dx, y: 140 })
    expect(node('deep').selrect).toMatchObject({ x: 210 + dx, y: 150 })

    // and the nesting is preserved
    expect(node('child').parentId).toBe(node('shell').views?.[0])
    expect(node('deep').parentId).toBe('inner')
  })

  it('converts an empty frame to an empty slot without inventing a view', async () => {
    const o = objects()
    o['shell'].shapes = []
    delete o['child']
    delete o['inner']
    delete o['deep']

    const viewId = await convertFrameToSlot('shell')
    expect(viewId).toBeNull()

    const slot = node('shell')
    expect(slot.type).toBe('slot')
    expect(slot.views).toEqual([])
    expect(slot.activeView).toBeUndefined()
  })

  it('undo restores the frame, its children, and their original coordinates', async () => {
    const viewId = await convertFrameToSlot('shell')
    await undo()

    const shell = node('shell')
    expect(shell.type).toBe('frame')
    expect(shell.shapes).toEqual(['child', 'inner'])
    expect(shell.views).toBeUndefined()
    // geometry is back where it started
    expect(node('child').selrect).toMatchObject({ x: 120, y: 120 })
    expect(node('deep').selrect).toMatchObject({ x: 210, y: 150 })
    expect(node('child').parentId).toBe('shell')
    // and the extracted view frame is gone
    expect(objects()[viewId as string]).toBeUndefined()
  })

  it('refuses to convert the page root', async () => {
    expect(await convertFrameToSlot(ROOT)).toBeNull()
    expect(node(ROOT).type).toBe('frame')
  })

  it('slot -> frame clears the references but leaves the view frames alive', async () => {
    const viewId = (await convertFrameToSlot('shell')) as string
    expect(await convertSlotToFrame('shell')).toBe(true)

    const shell = node('shell')
    expect(shell.type).toBe('frame')
    expect(shell.views).toBeUndefined()
    expect(shell.activeView).toBeUndefined()
    // the view is shared/independent — converting back must not consume it
    expect(node(viewId).type).toBe('frame')
    expect(node(viewId).shapes).toEqual(['child', 'inner'])
  })
})
