import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangesAppliedEvent } from '../../../../src/lib/changes/change-emitter'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { selectionSyncHandler } from '../../../../src/lib/renderer/store/selection-sync'
import { wasmSelectionRect } from '../../../../src/lib/renderer/signals/selection'

const ROOT = '00000000-0000-0000-0000-000000000000'
const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const FINITE_RECT = { width: 100, height: 50, center: { x: 0, y: 0 }, transform: { a: 1, b: 0, c: 0, d: 1 } }

function obj(id: string) {
  return { id, type: 'rect', parentId: ROOT, frameId: ROOT, x: 0, y: 0, width: 10, height: 10 }
}
function page(ids: string[]): IndexedPage {
  const objects: Record<string, unknown> = { [ROOT]: { id: ROOT, type: 'frame', name: 'Root', shapes: ids } }
  for (const id of ids) objects[id] = obj(id)
  return { id: 'p1', objects } as unknown as IndexedPage
}
function deleteEvent(oldIds: string[], newIds: string[], deletedId: string): ChangesAppliedEvent {
  return {
    redoChanges: [],
    undoChanges: [],
    fromHistory: true,
    saveUndo: false,
    ignoreRendererSync: false,
    pages: [
      {
        pageId: 'p1',
        changes: [{ type: 'del-obj', id: deletedId, pageId: 'p1' }],
        oldPage: page(oldIds),
        updatedPage: page(newIds),
      },
    ],
  } as unknown as ChangesAppliedEvent
}

describe('selection-sync prunes shapes a commit removed', () => {
  beforeEach(() => {
    docProxy.selectedIds.clear()
    wasmSelectionRect.value = FINITE_RECT as never
    useWorkspaceStore.setState({ renderer: { getSelectionRect: vi.fn(() => FINITE_RECT) } as never })
  })

  it('clears the selection box when the only selected shape is deleted', () => {
    docProxy.selectedIds.add(RECT)
    selectionSyncHandler(deleteEvent([RECT], [], RECT))
    expect(docProxy.selectedIds.size).toBe(0)
    expect(wasmSelectionRect.value).toBeNull()
  })

  it('keeps the surviving shape when one of two selected is deleted', () => {
    docProxy.selectedIds.add(RECT)
    docProxy.selectedIds.add(OTHER)
    selectionSyncHandler(deleteEvent([RECT, OTHER], [OTHER], RECT))
    expect(docProxy.selectedIds.has(RECT)).toBe(false)
    expect(docProxy.selectedIds.has(OTHER)).toBe(true)
  })
})
