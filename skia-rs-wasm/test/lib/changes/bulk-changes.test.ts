import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../../src/lib/worker/types'
import {
  bulkAssign,
  bulkAssignByValue,
  countShapeEdits,
  expandBulkChanges,
  isBulkChange,
  type LocalChange,
} from '../../../src/lib/changes/bulk-changes'
import { useWorkspaceStore } from '../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../src/lib/history/history-store'
import { commitChanges } from '../../../src/lib/renderer/store/commit'
import { undo } from '../../../src/lib/page-crud'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

describe('bulk changes (pure)', () => {
  it('passes an ordinary vector through untouched, without copying it', () => {
    const changes: Change[] = [
      { type: 'mod-obj', id: 'a', pageId: PAGE_ID, operations: [{ type: 'assign', value: { x: 1 } }] },
    ]
    expect(expandBulkChanges(changes)).toBe(changes)
  })

  it('expands one bulk change into a mod-obj per id, preserving page and operations', () => {
    const bulk = bulkAssign(PAGE_ID, ['a', 'b', 'c'], { fills: [{ fillColor: '#FF0000' }] })
    expect(isBulkChange(bulk)).toBe(true)

    const expanded = expandBulkChanges([bulk])
    expect(expanded).toHaveLength(3)
    expect(expanded.map((c) => (c as { id: string }).id)).toEqual(['a', 'b', 'c'])
    for (const change of expanded) {
      expect(change.type).toBe('mod-obj')
      expect((change as { pageId?: string }).pageId).toBe(PAGE_ID)
      expect((change as { operations: unknown }).operations).toEqual(bulk.operations)
    }
  })

  it('keeps ordinary changes in place around an expanded one', () => {
    const changes: LocalChange[] = [
      { type: 'mod-obj', id: 'first', pageId: PAGE_ID, operations: [] },
      bulkAssign(PAGE_ID, ['a', 'b'], { hidden: true }),
      { type: 'del-obj', id: 'last', pageId: PAGE_ID },
    ]
    expect(expandBulkChanges(changes).map((c) => (c as { id: string }).id)).toEqual([
      'first',
      'a',
      'b',
      'last',
    ])
  })

  it('counts a bulk change as one edit per id', () => {
    expect(countShapeEdits([bulkAssign(PAGE_ID, ['a', 'b', 'c'], {})])).toBe(3)
    expect(countShapeEdits([{ type: 'del-obj', id: 'x', pageId: PAGE_ID }])).toBe(1)
  })

  it('groups by value so an out-of-sync shape keeps its own previous value', () => {
    const grouped = bulkAssignByValue(PAGE_ID, [
      { id: 'a', assign: { fills: ['red'] } },
      { id: 'b', assign: { fills: ['red'] } },
      { id: 'odd', assign: { fills: ['blue'] } },
    ])
    expect(grouped).toHaveLength(2)
    expect(grouped[0].ids).toEqual(['a', 'b'])
    expect(grouped[1].ids).toEqual(['odd'])
    expect(grouped[1].operations[0]).toEqual({ type: 'assign', value: { fills: ['blue'] } })
  })
})

function makePage(): IndexedPage {
  const box = { x: 0, y: 0, width: 10, height: 10 }
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: { id: ROOT, type: 'frame', name: 'Root', ...box, shapes: ['a', 'b', 'c'] },
      a: { id: 'a', type: 'rect', name: 'A', ...box, parentId: ROOT, hidden: false },
      b: { id: 'b', type: 'rect', name: 'B', ...box, parentId: ROOT, hidden: false },
      c: { id: 'c', type: 'rect', name: 'C', ...box, parentId: ROOT, hidden: false },
    },
  } as unknown as IndexedPage
}

function node(id: string): Record<string, unknown> {
  const objects = docProxy.pageMap.get(PAGE_ID)?.objects as Record<string, IndexedShape>
  return objects[id] as unknown as Record<string, unknown>
}

describe('bulk changes (through the commit pipeline)', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [], transaction: null })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, makePage())
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    useWorkspaceStore.setState({
      workerClient: {
        updatePageWithChanges: vi.fn(async () => {}),
        updatePage: vi.fn(async () => {}),
      } as never,
      renderer: null,
    })
  })

  it('applies to every listed shape and reverts them all in one undo', async () => {
    await commitChanges({
      pageId: PAGE_ID,
      redoChanges: [bulkAssign(PAGE_ID, ['a', 'b', 'c'], { hidden: true })],
      undoChanges: [bulkAssign(PAGE_ID, ['a', 'b', 'c'], { hidden: false })],
    })

    expect(node('a').hidden).toBe(true)
    expect(node('b').hidden).toBe(true)
    expect(node('c').hidden).toBe(true)

    await undo()
    expect(node('a').hidden).toBe(false)
    expect(node('b').hidden).toBe(false)
    expect(node('c').hidden).toBe(false)
  })

  it('keeps the history frame compressed — one change, not one per shape', async () => {
    await commitChanges({
      pageId: PAGE_ID,
      redoChanges: [bulkAssign(PAGE_ID, ['a', 'b', 'c'], { hidden: true })],
      undoChanges: [bulkAssign(PAGE_ID, ['a', 'b', 'c'], { hidden: false })],
    })

    const frame = useHistoryStore.getState().undoStack.at(-1)!
    // This is the whole point of the representation: what the session retains.
    expect(frame.redoChanges).toHaveLength(1)
    expect(frame.undoChanges).toHaveLength(1)
    expect(frame.redoChanges[0].type).toBe('mod-objs')
    expect(countShapeEdits(frame.redoChanges)).toBe(3)
  })

  it('reaches subscribers as ordinary per-shape changes', async () => {
    const seen: string[] = []
    const workerClient = {
      updatePageWithChanges: vi.fn(async (_pageId: string, changes: Change[]) => {
        for (const c of changes) seen.push(c.type)
      }),
      updatePage: vi.fn(async () => {}),
    }
    useWorkspaceStore.setState({ workerClient: workerClient as never, renderer: null })

    await commitChanges({
      pageId: PAGE_ID,
      redoChanges: [bulkAssign(PAGE_ID, ['a', 'b'], { hidden: true })],
      undoChanges: [bulkAssign(PAGE_ID, ['a', 'b'], { hidden: false })],
    })

    // No subscriber should ever have to know 'mod-objs' exists.
    expect(seen).toEqual(['mod-obj', 'mod-obj'])
  })
})
