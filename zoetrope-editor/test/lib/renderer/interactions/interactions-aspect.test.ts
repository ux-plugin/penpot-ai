import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change } from 'penpot-exporter/types'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { currentInteractions } from '../../../../src/lib/renderer/interactions/document/commit-interactions'
import { undo, redo } from '../../../../src/lib/page-crud'
import { dropNodes, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { up } from './todo-ir'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const CARD = '11111111-1111-4111-8111-111111111111'
const BTN = '22222222-2222-4222-8222-222222222222'
const LABEL = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'

function ir(): PageInteractions {
  return up({
    cells: [
      { id: 'count', owner: { kind: 'page' }, type: 'number', initial: 0 },
      { id: 'state', owner: { kind: 'node', node: CARD }, type: { enum: ['a', 'b'] }, initial: 'a' },
    ],
    refs: [
      { node: LABEL, props: { text: 'count' } },
      { node: OTHER, props: { hidden: 'count == 0' } },
    ],
    interactions: [
      { on: { node: BTN, trigger: { type: 'press' } }, do: [{ type: 'increment', target: 'count' }] },
      { on: { node: OTHER, trigger: { type: 'press' } }, do: [{ type: 'increment', target: 'count' }] },
    ],
  })
}

function makePage(): IndexedPage {
  const node = (id: string, shapes: string[] = [], parentId = ROOT) =>
    ({ id, type: 'frame', name: id, x: 0, y: 0, width: 10, height: 10, shapes, parentId, frameId: ROOT }) as never
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: node(ROOT, [CARD, OTHER]),
      [CARD]: node(CARD, [BTN, LABEL]),
      [BTN]: node(BTN, [], CARD),
      [LABEL]: node(LABEL, [], CARD),
      [OTHER]: node(OTHER),
    },
    interactions: ir(),
  } as unknown as IndexedPage
}

describe('dropNodes', () => {
  it('removes what the nodes own and nothing else', () => {
    const next = dropNodes(ir(), new Set([CARD, BTN, LABEL]))
    expect(next.cells.map((c) => c.id)).toEqual(['count'])
    expect(next.refs.map((r) => r.node)).toEqual([OTHER])
    expect(next.interactions.map((i) => i.on.node)).toEqual([OTHER])
  })

  it('returns the same object when nothing is owned', () => {
    const before = ir()
    expect(dropNodes(before, new Set(['nobody']))).toBe(before)
  })
})

describe('interactions follow node deletion in the same frame', () => {
  beforeEach(() => {
    useJournalStore.getState().clear()
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, makePage())
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    useWorkspaceStore.setState({
      workerClient: { updatePageWithChanges: vi.fn(async () => {}), updatePage: vi.fn(async () => {}) } as never,
      renderer: null,
    })
  })

  const deleteCard = () =>
    commitChanges({
      redoChanges: [{ type: 'del-obj', id: CARD, pageId: PAGE_ID } as Change],
      undoChanges: [
        { type: 'add-obj', id: CARD, obj: makePage().objects[CARD], frameId: ROOT, parentId: ROOT, index: 0, pageId: PAGE_ID } as unknown as Change,
      ],
      saveUndo: true,
    })

  it('deleting a subtree drops its behaviour; undo brings both back; redo drops again', async () => {
    await deleteCard()
    expect(docProxy.pageMap.get(PAGE_ID)?.objects[BTN]).toBeUndefined()
    const after = currentInteractions(PAGE_ID)!
    expect(after.interactions.map((i) => i.on.node)).toEqual([OTHER])
    expect(after.refs.map((r) => r.node)).toEqual([OTHER])
    expect(after.cells.map((c) => c.id)).toEqual(['count'])
    expect(useJournalStore.getState().txns).toHaveLength(1)

    await undo()
    expect(docProxy.pageMap.get(PAGE_ID)?.objects[CARD]).toBeDefined()
    expect(currentInteractions(PAGE_ID)).toEqual(ir())

    await redo()
    expect(currentInteractions(PAGE_ID)!.interactions).toHaveLength(1)
  })

  it('deleting a leaf drops only what it owns', async () => {
    await commitChanges({
      redoChanges: [{ type: 'del-obj', id: OTHER, pageId: PAGE_ID } as Change],
      undoChanges: [],
      saveUndo: true,
    })
    // `other` owns a ref and an interaction; the card subtree keeps its own.
    expect(currentInteractions(PAGE_ID)!.interactions.map((i) => i.on.node)).toEqual([BTN])
  })
})
