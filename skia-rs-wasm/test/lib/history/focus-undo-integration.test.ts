/**
 * Focus-scope undo over the REAL journal + commit pipeline.
 *
 * The mechanism changed in Phase 1 step B — a focus stage now pushes a scope
 * tag onto the one journal instead of diverting commits into a parallel
 * `FocusBuffer` — but the observable behaviour did not, and that is what this
 * file pins. Every assertion here predates the swap; only the API driving them
 * moved from `beginFocusBuffer`/`focusUndo` to `enterScope`/`undo`.
 *
 * The four behaviours that must survive:
 *   1. Inside a session, undo steps ONE edit at a time.
 *   2. Work from before the session is out of reach while inside it.
 *   3. Exit collapses the session to ONE canvas step.
 *   4. A session undone from inside leaves nothing behind on exit.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { commitNodePartialUpdate } from '../../../src/lib/renderer/properties/commit-node-properties'
import {
  useJournalStore,
  beginJournalTransaction,
  commitJournalTransaction,
} from '../../../src/lib/history/journal/journal-store'
import { enterScope, exitScope } from '../../../src/lib/history/journal/scope'
import { canvasLens, localCtx, pickUndo } from '../../../src/lib/history/journal/lens'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID, TEXT_ID } from '../fixtures'

beforeEach(() => {
  resetWorkspace()
  useJournalStore.getState().clear()
  setDocument(makeBaseDocument())
  // A defined baseline material, so edits are v0→v1 rather than undefined→v1
  // (assigning undefined is a no-op in the apply layer).
  ;(docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material = 'v0'
})

const materialA = () =>
  (docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material
const nameB = () => (docProxy.pageMap.get(PAGE_ID)!.objects[TEXT_ID] as { name?: string }).name

/** What the canvas would revert next — undefined when it has nothing to undo. */
const canvasTarget = () => pickUndo(useJournalStore.getState().txns, canvasLens, localCtx())

/** A material edit on the rect (fast path — `material` is not a layout attr). */
async function editMaterial(value: string): Promise<void> {
  const before = docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as PenpotNode
  await commitNodePartialUpdate(
    RECT_ID,
    before,
    { material: value } as unknown as Partial<PenpotNode>,
    PAGE_ID,
  )
}

/** A plain edit on a DIFFERENT node (foreign to the shader session). */
async function editCanvas(name: string): Promise<void> {
  const before = docProxy.pageMap.get(PAGE_ID)!.objects[TEXT_ID] as PenpotNode
  await commitNodePartialUpdate(TEXT_ID, before, { name } as unknown as Partial<PenpotNode>, PAGE_ID)
}

describe('focus scope — real commit pipeline', () => {
  it('steps one edit at a time inside a session; past the start is a no-op', async () => {
    enterScope('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    expect(materialA()).toBe('v2')

    await undo()
    expect(materialA()).toBe('v1')
    await undo()
    expect(materialA()).toBe('v0')

    // Past the start: nothing happens, and the session is still open.
    await undo()
    expect(materialA()).toBe('v0')

    await redo()
    expect(materialA()).toBe('v1')
  })

  it('work from before the session is out of reach while inside it', async () => {
    await editCanvas('before-session')
    enterScope('s1')
    await editMaterial('v1')

    await undo() // reverts the in-scope edit
    expect(materialA()).toBe('v0')
    await undo() // nothing in scope left; must NOT reach the canvas edit
    expect(nameB()).toBe('before-session')
  })

  it('exit collapses the whole session into ONE canvas entry', async () => {
    enterScope('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    exitScope()
    expect(materialA()).toBe('v2')

    await undo() // one press reverts the whole session
    expect(materialA()).toBe('v0')
    await redo()
    expect(materialA()).toBe('v2')
  })

  it('exit after undoing the whole session records nothing', async () => {
    enterScope('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    await undo()
    await undo()
    expect(materialA()).toBe('v0')
    exitScope()
    // Nothing survived, so the canvas has nothing to revert.
    expect(canvasTarget()).toBeUndefined()
    expect(materialA()).toBe('v0')
  })

  // The scenario the user asked about: undo part of a session, then leave.
  it('exit collapses only the surviving prefix after a partial undo', async () => {
    enterScope('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    await editMaterial('v3')
    await undo() // drop v3 → what survives is v1, v2
    expect(materialA()).toBe('v2')
    exitScope()
    expect(materialA()).toBe('v2')

    await undo() // the surviving prefix reverts as one step
    expect(materialA()).toBe('v0')
  })

  it('re-entering starts clean — no session carries over', async () => {
    enterScope('s1')
    await editMaterial('v1')
    exitScope()

    enterScope('s2')
    await undo() // the previous session's steps are not in this scope
    expect(materialA()).toBe('v1')
    exitScope()
  })

  it('a gesture inside the stage is ONE step', async () => {
    enterScope('s1')
    beginJournalTransaction('drag', 0)
    await editMaterial('v1')
    await editMaterial('v2')
    commitJournalTransaction('drag')

    await undo() // one press reverts the whole gesture
    expect(materialA()).toBe('v0')
  })

  it('a foreign commit during the session collapses with it (deliberate)', async () => {
    enterScope('s1')
    await editMaterial('v1')
    await editCanvas('renamed') // tagged with the open scope, so it folds in
    exitScope()

    await undo() // one press reverts BOTH the material and the rename
    expect(materialA()).toBe('v0')
    expect(nameB()).not.toBe('renamed')
  })
})
