import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { endGroup, getNode, mod, redo, undo, type Node } from '../../../../src/lib/doc'
import { framesOf } from '../../../../src/lib/doc/undo'
import { applyChanges } from '../../../../src/lib/page-crud'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import { createPenStartPath, PEN_CREATE_TX } from '../../../../src/lib/renderer/handlers/draw-path'

describe('pen create: dot bundles with first edge into one undo entry', () => {
  beforeEach(() => {
    resetWorkspace()
    seedDocument(makeBaseDocument())
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('one undo removes the whole path (no lone dot); a later edge is its own frame', async () => {
    // createPenStartPath opens the group and commits the dot.
    const id = (await createPenStartPath({ x: 0, y: 0 }))!
    expect(getNode(id)).toBeDefined()

    // First edge: commit, then close the group → dot + edge = ONE frame.
    await applyChanges([mod('node', id, { content: { edges: 1 } } as Partial<Node>)])
    endGroup(PEN_CREATE_TX)
    expect(framesOf()).toHaveLength(1)

    // Second edge: its own frame (per-node undo preserved).
    await applyChanges([mod('node', id, { content: { edges: 2 } } as Partial<Node>)])
    expect(framesOf()).toHaveLength(2)

    await undo() // undo 2nd edge — path stays
    expect(getNode(id)).toBeDefined()

    await undo() // undo the bundled dot+edge — whole shape gone, no lone dot
    expect(getNode(id)).toBeUndefined()

    await redo() // restores the dot + first edge in one step
    expect(getNode(id)).toBeDefined()
    expect((getNode(id) as unknown as { content: { edges: number } }).content).toEqual({ edges: 1 })
  })
})
