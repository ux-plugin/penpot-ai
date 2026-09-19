import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import {
  commitInteractions,
  currentInteractions,
} from '../../../../src/lib/renderer/interactions/document/commit-interactions'
import { undo, redo } from '../../../../src/lib/page-crud'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import type { PageInteractions, Cell } from '../../../../src/lib/renderer/interactions/ir'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: { [ROOT]: { id: ROOT, type: 'frame', name: 'Root', x: 0, y: 0, width: 800, height: 600, shapes: [] } },
  } as unknown as IndexedPage
}

const formula = (id: string, expr: string): Cell => ({ id, owner: { kind: 'page' }, type: 'any', initial: null, formula: expr })

function irA(): PageInteractions {
  return { ...emptyPageInteractions(), cells: [formula('d1', '1 + 1')] }
}
function irB(): PageInteractions {
  return { ...emptyPageInteractions(), cells: [formula('d1', '2 + 2'), formula('d2', '3')] }
}

describe('interaction edits are undoable through the global history', () => {
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

  it('commit records a frame; undo restores prev; redo reapplies', async () => {
    expect(currentInteractions(PAGE_ID)).toBeUndefined()

    const next = irA()
    await commitInteractions(PAGE_ID, next)
    expect(currentInteractions(PAGE_ID)).toEqual(next)
    expect(useJournalStore.getState().txns).toHaveLength(1)

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
