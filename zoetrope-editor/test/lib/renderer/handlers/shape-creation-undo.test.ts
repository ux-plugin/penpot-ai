import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddObjChange, DelObjChange } from 'penpot-exporter/types'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { applyChanges, undo, redo } from '../../../../src/lib/page-crud'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: { [ROOT]: { id: ROOT, type: 'frame', name: 'Root', x: 0, y: 0, width: 800, height: 600, shapes: [] } },
  } as unknown as IndexedPage
}

describe('shape creation is undoable', () => {
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

  it('undo removes a created shape from the page tree; redo restores it', async () => {
    const rect = { id: RECT, type: 'rect', parentId: ROOT, frameId: ROOT, x: 0, y: 0, width: 100, height: 50 }
    const add: AddObjChange = {
      type: 'add-obj',
      id: RECT,
      obj: rect as never,
      frameId: ROOT,
      parentId: ROOT,
      index: 0,
      pageId: PAGE_ID,
    }
    const del: DelObjChange = { type: 'del-obj', id: RECT, pageId: PAGE_ID }

    // Creation now pairs the add-obj with its inverse del-obj (the fix).
    await applyChanges([add], { undoChanges: [del] })
    let page = docProxy.pageMap.get(PAGE_ID) as IndexedPage
    expect(page.objects[RECT]).toBeDefined()
    expect(page.objects[ROOT].shapes).toContain(RECT)
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)

    await undo()
    page = docProxy.pageMap.get(PAGE_ID) as IndexedPage
    expect(page.objects[RECT]).toBeUndefined()
    expect(page.objects[ROOT].shapes ?? []).not.toContain(RECT)

    await redo()
    page = docProxy.pageMap.get(PAGE_ID) as IndexedPage
    expect(page.objects[RECT]).toBeDefined()
    expect(page.objects[ROOT].shapes).toContain(RECT)
  })
})
