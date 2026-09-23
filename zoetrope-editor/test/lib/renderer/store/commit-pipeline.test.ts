import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBaseDocument, PAGE_ID, RECT_ID, resetWorkspace, seedDocument } from '../../fixtures'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { canUndo, getNode, mod, registerEffect, addNode, del } from '../../../../src/lib/doc'
import { resetEffects } from '../../../../src/lib/doc/commit'
import type { PenpotNode } from 'penpot-exporter/types'

describe('commitChanges pipeline', () => {
  const applied: Array<{ pageId: string; ops: string[] }> = []

  beforeEach(() => {
    resetWorkspace()
    resetEffects()
    seedDocument(makeBaseDocument())
    applied.length = 0
    useWorkspaceStore.setState({
      workerClient: {
        applyChanges: vi.fn(async (pageId: string, changes: Array<{ op: string }>) => {
          applied.push({ pageId, ops: changes.map((c) => c.op) })
        }),
      } as never,
      renderer: null,
    })
  })

  it('applies to the store, then feeds the worker the node changes of the page', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 5 })], saveUndo: false })
    expect(getNode(RECT_ID)?.x).toBe(5)
    await Promise.resolve()
    expect(applied).toEqual([{ pageId: PAGE_ID, ops: ['mod'] }])
  })

  it('does not push history when fromHistory or saveUndo is false', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 1 })], fromHistory: true })
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 2 })], saveUndo: false })
    expect(canUndo.value).toBe(false)
  })

  it('records a frame by default', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 3 })] })
    expect(canUndo.value).toBe(true)
  })

  it('effects see the pending changes and add to the same frame; skipped on replay', async () => {
    const seen: string[] = []
    registerEffect((changes) => {
      seen.push(...changes.map((c) => c.op))
      return [mod('node', RECT_ID, { name: 'by-effect' })]
    })
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 4 })] })
    expect(seen).toEqual(['mod'])
    expect(getNode(RECT_ID)?.name).toBe('by-effect')
    await commitChanges({ changes: [mod('node', RECT_ID, { name: 'Rect' })], fromHistory: true })
    expect(seen).toEqual(['mod'])
  })

  it('a delete reaches the worker as one del per record, deepest first', async () => {
    const frame = { id: 'f', type: 'frame', x: 0, y: 0, width: 1, height: 1 } as unknown as PenpotNode
    const kid = { id: 'k', type: 'rect', x: 0, y: 0, width: 1, height: 1 } as unknown as PenpotNode
    await commitChanges({ changes: [addNode(frame, { page: PAGE_ID })], saveUndo: false })
    await commitChanges({ changes: [addNode(kid, { page: PAGE_ID, parentId: 'f' })], saveUndo: false })
    applied.length = 0
    await commitChanges({ changes: [del('node', 'f')], saveUndo: false })
    expect(applied).toEqual([{ pageId: PAGE_ID, ops: ['del', 'del'] }])
  })
})
