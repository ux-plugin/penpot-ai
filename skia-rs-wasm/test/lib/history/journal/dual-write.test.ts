/**
 * Journal dual-write — Phase 1 step A of `docs/history-redesign-plan.md`.
 *
 * Step A writes the journal but never reads it, so it cannot change behaviour.
 * Its entire value is this file: proving the two representations agree when
 * driven by the REAL commit pipeline, before the reader swaps over in step B.
 *
 * So these go through `commitNodePartialUpdate` → `commitChanges` →
 * `recordHistoryFrame` rather than constructing frames by hand. A fixture can
 * only prove the codec is self-consistent; only the real pipeline proves it
 * handles what the application actually emits.
 *
 * The load-bearing assertion is inverse agreement: applying the inverse DERIVED
 * from journal ops must land the document exactly where the frame's hand-built
 * `undoChanges` lands. If that holds on real traffic, swapping the reader in
 * step B cannot change what Cmd+Z does.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { setDocument } from '../../../../src/lib/page-crud'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { commitNodePartialUpdate } from '../../../../src/lib/renderer/properties/commit-node-properties'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import {
  useHistoryStore,
  beginHistoryTransaction,
  commitHistoryTransaction,
} from '../../../../src/lib/history/history-store'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import { toChanges } from '../../../../src/lib/history/journal/codec'
import { invertAll } from '../../../../src/lib/history/journal/op'
import { processChanges } from '../../../../src/lib/worker/process-changes'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID, TEXT_ID } from '../../fixtures'

const frames = () => useHistoryStore.getState().undoStack
const txns = () => useJournalStore.getState().txns
const page = () => docProxy.pageMap.get(PAGE_ID)!

beforeEach(() => {
  resetWorkspace()
  useHistoryStore.getState().clearHistory()
  setDocument(makeBaseDocument())
  ;(page().objects[RECT_ID] as { material?: string }).material = 'v0'
})

async function edit(id: string, partial: Record<string, unknown>): Promise<void> {
  const before = page().objects[id] as PenpotNode
  await commitNodePartialUpdate(id, before, partial as Partial<PenpotNode>, PAGE_ID)
}

describe('dual-write — the journal tracks the stack', () => {
  it('one commit produces one frame and one entry', async () => {
    await edit(RECT_ID, { material: 'v1' })
    expect(frames()).toHaveLength(1)
    expect(txns()).toHaveLength(1)
    expect(txns()[0].ops.some((o) => o.entity === RECT_ID)).toBe(true)
  })

  it('a gesture merges into one frame AND one entry', async () => {
    beginHistoryTransaction('drag', 0)
    await edit(RECT_ID, { material: 'v1' })
    await edit(RECT_ID, { material: 'v2' })
    expect(frames()).toHaveLength(0)
    expect(txns()).toHaveLength(0)
    commitHistoryTransaction('drag')
    expect(frames()).toHaveLength(1)
    expect(txns()).toHaveLength(1)
  })

  it('a replayed commit records in neither', async () => {
    await edit(RECT_ID, { material: 'v1' })
    const before = { frames: frames().length, txns: txns().length }
    await commitChanges({
      redoChanges: [
        { type: 'mod-obj', id: RECT_ID, pageId: PAGE_ID, operations: [{ type: 'assign', value: { material: 'v0' } }] },
      ],
      saveUndo: false,
      fromHistory: true,
    })
    expect(frames()).toHaveLength(before.frames)
    expect(txns()).toHaveLength(before.txns)
  })

  it('loading a document clears both', async () => {
    await edit(RECT_ID, { material: 'v1' })
    useHistoryStore.getState().clearHistory()
    expect(frames()).toHaveLength(0)
    expect(txns()).toHaveLength(0)
  })

  it('stays one-to-one across a mixed run of edits', async () => {
    await edit(RECT_ID, { material: 'v1' })
    await edit(TEXT_ID, { name: 'renamed' })
    beginHistoryTransaction('drag', 0)
    await edit(RECT_ID, { material: 'v2' })
    await edit(RECT_ID, { material: 'v3' })
    commitHistoryTransaction('drag')
    await edit(TEXT_ID, { name: 'again' })
    expect(frames()).toHaveLength(4)
    expect(txns()).toHaveLength(4)
  })
})

describe('dual-write — the derived inverse agrees with the recorded one', () => {
  it('per frame, on real pipeline traffic', async () => {
    await edit(RECT_ID, { material: 'v1' })
    await edit(TEXT_ID, { name: 'renamed' })
    await edit(RECT_ID, { material: 'v2' })

    expect(frames()).toHaveLength(3)
    expect(txns()).toHaveLength(3)

    // Walk newest to oldest, undoing each way from the same starting state and
    // comparing where the page lands.
    for (let i = frames().length - 1; i >= 0; i -= 1) {
      const start = page()
      const byHand = processChanges(start, frames()[i].undoChanges)
      const derived = processChanges(start, toChanges(invertAll(txns()[i].ops)).changes)
      expect(derived).toEqual(byHand)
    }
  })

  it('holds for a merged gesture too', async () => {
    const base = page()
    beginHistoryTransaction('drag', 0)
    await edit(RECT_ID, { material: 'v1' })
    await edit(RECT_ID, { material: 'v2' })
    commitHistoryTransaction('drag')

    const after = page()
    const byHand = processChanges(after, frames()[0].undoChanges)
    const derived = processChanges(after, toChanges(invertAll(txns()[0].ops)).changes)
    expect(derived).toEqual(byHand)
    // Both revert the whole gesture, not just its last step.
    expect((derived.objects[RECT_ID] as { material?: string }).material).toBe(
      (base.objects[RECT_ID] as { material?: string }).material,
    )
  })
})
