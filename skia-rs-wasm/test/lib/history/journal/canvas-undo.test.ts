/**
 * Canvas undo/redo through the REAL commit pipeline — the behaviours a user
 * touches most, which the focus-scope suite does not cover.
 *
 * The redo-invalidation case here is the one worth keeping honest. With a stack
 * model it came free: every commit cleared `redoStack`. The journal has no
 * stack to clear, so "new work discards the redo branch" is a rule that has to
 * be stated in `pickRedo` — and it was missing when step B first landed, which
 * meant redo reached past fresh edits and resurrected undone work.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../../src/lib/page-crud'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { commitNodePartialUpdate } from '../../../../src/lib/renderer/properties/commit-node-properties'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID } from '../../fixtures'

beforeEach(() => {
  resetWorkspace()
  useJournalStore.getState().clear()
  setDocument(makeBaseDocument())
  ;(docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material = 'v0'
})

const mat = () =>
  (docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material

async function edit(v: string): Promise<void> {
  const before = docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as PenpotNode
  await commitNodePartialUpdate(RECT_ID, before, { material: v } as Partial<PenpotNode>, PAGE_ID)
}

describe('canvas undo/redo', () => {
  it('walks back through edits and forward again in the right order', async () => {
    await edit('v1')
    await edit('v2')

    await undo()
    expect(mat()).toBe('v1')
    await undo()
    expect(mat()).toBe('v0')
    await undo() // nothing left
    expect(mat()).toBe('v0')

    await redo()
    expect(mat()).toBe('v1')
    await redo()
    expect(mat()).toBe('v2')
    await redo() // nothing left
    expect(mat()).toBe('v2')
  })

  it('new work after an undo discards the redo branch', async () => {
    await edit('v1')
    await edit('v2')
    await undo()
    expect(mat()).toBe('v1')

    await edit('branch')
    await redo()
    expect(mat()).toBe('branch') // v2 must not come back

    // And undo still works normally on the new branch.
    await undo()
    expect(mat()).toBe('v1')
  })

  it('a redo does not itself discard the remaining branch', async () => {
    await edit('v1')
    await edit('v2')
    await undo()
    await undo()
    expect(mat()).toBe('v0')

    await redo()
    expect(mat()).toBe('v1')
    await redo() // the second redo must still be reachable
    expect(mat()).toBe('v2')
  })

  it('undoing a redo reverts it', async () => {
    await edit('v1')
    await undo()
    await redo()
    expect(mat()).toBe('v1')
    await undo()
    expect(mat()).toBe('v0')
  })
})
