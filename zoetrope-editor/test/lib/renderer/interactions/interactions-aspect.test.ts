import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { currentInteractions } from '../../../../src/lib/renderer/interactions/document/commit-interactions'
import { addSubtree, canUndo, del, getNode, mod, redo, undo } from '../../../../src/lib/doc'
import { dropNodes, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { up } from './todo-ir'
import { makeBaseDocument, PAGE_ID, resetWorkspace, seedDocument } from '../../fixtures'

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

const frame = (id: string, children: PenpotNode[] = []): PenpotNode =>
  ({ id, type: 'frame', name: id, x: 0, y: 0, width: 10, height: 10, children }) as unknown as PenpotNode

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
  beforeEach(async () => {
    resetWorkspace()
    seedDocument(makeBaseDocument())
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
    await commitChanges({
      changes: [
        ...addSubtree(frame(CARD, [frame(BTN), frame(LABEL)]), { page: PAGE_ID }),
        ...addSubtree(frame(OTHER), { page: PAGE_ID }),
        mod('page', PAGE_ID, { interactions: ir() }),
      ],
      saveUndo: false,
    })
  })

  it('deleting a subtree drops its behaviour; undo brings both back; redo drops again', async () => {
    await commitChanges({ changes: [del('node', CARD)] })
    expect(getNode(BTN)).toBeUndefined()
    const after = currentInteractions(PAGE_ID)!
    expect(after.interactions.map((i) => i.on.node)).toEqual([OTHER])
    expect(after.refs.map((r) => r.node)).toEqual([OTHER])
    expect(after.cells.map((c) => c.id)).toEqual(['count'])
    expect(canUndo.value).toBe(true)

    await undo()
    expect(getNode(CARD)).toBeDefined()
    expect(getNode(BTN)).toBeDefined()
    expect(currentInteractions(PAGE_ID)).toEqual(ir())

    await redo()
    expect(currentInteractions(PAGE_ID)!.interactions).toHaveLength(1)
  })

  it('deleting a leaf drops only what it owns', async () => {
    await commitChanges({ changes: [del('node', OTHER)] })
    expect(currentInteractions(PAGE_ID)!.interactions.map((i) => i.on.node)).toEqual([BTN])
  })
})
