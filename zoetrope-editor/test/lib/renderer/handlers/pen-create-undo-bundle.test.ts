import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddObjChange, Change, DelObjChange } from 'penpot-exporter/types'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { applyChanges, undo, redo } from '../../../../src/lib/page-crud'
import { PEN_CREATE_TX } from '../../../../src/lib/renderer/handlers/draw-path'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const PATH = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: { [ROOT]: { id: ROOT, type: 'frame', name: 'Root', shapes: [] } },
  } as unknown as IndexedPage
}
function pathObj(PATH: string) {
  return { id: PATH, type: 'path', parentId: ROOT, frameId: ROOT, content: { nodes: 1 } }
}
function modContent(value: unknown): Change {
  return { type: 'mod-obj', id: PATH, operations: [{ type: 'assign', value: { content: value } }], pageId: PAGE_ID } as unknown as Change
}
function present(): boolean {
  return (docProxy.pageMap.get(PAGE_ID) as IndexedPage).objects[PATH] !== undefined
}

describe('pen create: dot bundles with first edge into one undo entry', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [], transaction: null, transactionHolders: new Set() })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, makePage())
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    useWorkspaceStore.setState({
      workerClient: { updatePageWithChanges: vi.fn(async () => {}), updatePage: vi.fn(async () => {}) } as never,
      renderer: null,
    })
  })

  it('one undo removes the whole path (no lone dot); a later edge is its own frame', async () => {
    const add: AddObjChange = { type: 'add-obj', id: PATH, obj: pathObj(PATH) as never, frameId: ROOT, parentId: ROOT, index: 0, pageId: PAGE_ID }
    const del: DelObjChange = { type: 'del-obj', id: PATH, pageId: PAGE_ID }

    // createPenStartPath: open the transaction, commit the dot → merges in (no frame yet).
    useHistoryStore.getState().beginTransaction(PEN_CREATE_TX)
    await applyChanges([add], { undoChanges: [del] })
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)

    // First edge: commit, then close the transaction → dot + edge = ONE frame.
    await applyChanges([modContent({ edges: 1 })], { undoChanges: [modContent({ nodes: 1 })] })
    useHistoryStore.getState().commitTransaction(PEN_CREATE_TX)
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    expect(present()).toBe(true)

    // Second edge: its own frame (per-node undo preserved).
    await applyChanges([modContent({ edges: 2 })], { undoChanges: [modContent({ edges: 1 })] })
    expect(useHistoryStore.getState().undoStack).toHaveLength(2)

    await undo() // undo 2nd edge — path stays
    expect(present()).toBe(true)

    await undo() // undo the bundled dot+edge — whole shape gone, no lone dot
    expect(present()).toBe(false)

    await redo() // restores the 2-node path in one step
    expect(present()).toBe(true)
  })

  it('abandoning the dot before any edge leaves no undo frame', async () => {
    const add: AddObjChange = { type: 'add-obj', id: PATH, obj: pathObj(PATH) as never, frameId: ROOT, parentId: ROOT, index: 0, pageId: PAGE_ID }
    const del: DelObjChange = { type: 'del-obj', id: PATH, pageId: PAGE_ID }

    useHistoryStore.getState().beginTransaction(PEN_CREATE_TX)
    await applyChanges([add], { undoChanges: [del] })
    expect(present()).toBe(true)

    // deleteSelfShape's path: discard the transaction, then remove the shape.
    useHistoryStore.getState().discardTransactions()
    await applyChanges([del])
    expect(present()).toBe(false)
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
  })
})
