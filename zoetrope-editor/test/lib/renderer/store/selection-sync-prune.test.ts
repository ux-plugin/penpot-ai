import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangesAppliedEvent } from '../../../../src/lib/doc/commit'
import { selectedIds, setSelectedIds } from '../../../../src/lib/renderer/store/document-selection'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { selectionSyncHandler } from '../../../../src/lib/renderer/store/selection-sync'
import { wasmSelectionRect } from '../../../../src/lib/renderer/signals/selection'

const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const FINITE_RECT = { width: 100, height: 50, center: { x: 0, y: 0 }, transform: { a: 1, b: 0, c: 0, d: 1 } }

function deleteEvent(deletedId: string): ChangesAppliedEvent {
  const before = { id: deletedId, type: 'rect', page: 'p1', order: 'a0' }
  return {
    applied: [{ change: { op: 'del', kind: 'node', id: deletedId }, before, after: undefined }],
    touched: { node: new Set([deletedId]), page: new Set() },
    docMeta: [],
    fromHistory: true,
    saveUndo: false,
    ignoreRendererSync: false,
  } as unknown as ChangesAppliedEvent
}

describe('selection-sync prunes shapes a commit removed', () => {
  beforeEach(() => {
    setSelectedIds([])
    wasmSelectionRect.value = FINITE_RECT as never
    useWorkspaceStore.setState({ renderer: { getSelectionRect: vi.fn(() => FINITE_RECT) } as never })
  })

  it('clears the selection box when the only selected shape is deleted', () => {
    setSelectedIds([RECT])
    selectionSyncHandler(deleteEvent(RECT))
    expect(selectedIds.value.size).toBe(0)
    expect(wasmSelectionRect.value).toBeNull()
  })

  it('keeps the surviving shape when one of two selected is deleted', () => {
    setSelectedIds([RECT, OTHER])
    selectionSyncHandler(deleteEvent(RECT))
    expect(selectedIds.value.has(RECT)).toBe(false)
    expect(selectedIds.value.has(OTHER)).toBe(true)
  })
})
