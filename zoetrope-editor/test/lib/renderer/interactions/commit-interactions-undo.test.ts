import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitInteractions, currentInteractions } from '../../../../src/lib/renderer/interactions/document/commit-interactions'
import { canUndo, redo, undo } from '../../../../src/lib/doc'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import type { PageInteractions, Cell } from '../../../../src/lib/renderer/interactions/ir'
import { rawExpr } from '../../../../src/lib/renderer/interactions/expr'
import { makeBaseDocument, PAGE_ID, resetWorkspace, seedDocument } from '../../fixtures'

const formula = (id: string, expr: string): Cell => ({ uid: id, id, owner: { kind: 'page' }, type: 'any', initial: null, formula: rawExpr(expr) })

function irA(): PageInteractions {
  return { ...emptyPageInteractions(), cells: [formula('d1', '1 + 1')] }
}
function irB(): PageInteractions {
  return { ...emptyPageInteractions(), cells: [formula('d1', '2 + 2'), formula('d2', '3')] }
}

describe('interaction edits are undoable through the global history', () => {
  beforeEach(() => {
    resetWorkspace()
    seedDocument(makeBaseDocument())
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('commit records a frame; undo restores prev; redo reapplies', async () => {
    expect(currentInteractions(PAGE_ID)).toBeUndefined()

    const next = irA()
    await commitInteractions(PAGE_ID, next)
    expect(currentInteractions(PAGE_ID)).toEqual(next)
    expect(canUndo.value).toBe(true)

    await undo()
    expect(currentInteractions(PAGE_ID)).toBeUndefined()

    await redo()
    expect(currentInteractions(PAGE_ID)).toEqual(next)
  })

  it('walks back through multiple edits in order', async () => {
    const a = irA()
    const b = irB()
    await commitInteractions(PAGE_ID, a)
    await commitInteractions(PAGE_ID, b)
    expect(currentInteractions(PAGE_ID)).toEqual(b)

    await undo()
    expect(currentInteractions(PAGE_ID)).toEqual(a)

    await undo()
    expect(currentInteractions(PAGE_ID)).toBeUndefined()
  })
})
