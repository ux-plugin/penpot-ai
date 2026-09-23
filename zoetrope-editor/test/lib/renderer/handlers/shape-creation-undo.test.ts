import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { addNode, children, getNode, redo, undo } from '../../../../src/lib/doc'
import { framesOf } from '../../../../src/lib/doc/undo'
import { applyChanges } from '../../../../src/lib/page-crud'
import { makeBaseDocument, PAGE_ID, resetWorkspace, seedDocument } from '../../fixtures'

const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

describe('shape creation is undoable', () => {
  beforeEach(() => {
    resetWorkspace()
    seedDocument(makeBaseDocument())
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('undo removes a created shape from the page tree; redo restores it', async () => {
    const rect = { id: RECT, type: 'rect', x: 0, y: 0, width: 100, height: 50 } as unknown as PenpotNode

    // The commit computes the inverse of the add itself.
    await applyChanges([addNode(rect, { page: PAGE_ID })])
    expect(getNode(RECT)).toBeDefined()
    expect(children(PAGE_ID)).toContain(RECT)
    expect(framesOf()).toHaveLength(1)

    await undo()
    expect(getNode(RECT)).toBeUndefined()
    expect(children(PAGE_ID)).not.toContain(RECT)

    await redo()
    expect(getNode(RECT)).toBeDefined()
    expect(children(PAGE_ID)).toContain(RECT)
  })
})
