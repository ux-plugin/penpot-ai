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

  /**
   * Undo does not cross a session boundary. The tag still names the subject, so
   * the previous visit's entries are right there under the same tag — the lens
   * is bounded to the current visit on purpose, and earlier states are reached
   * through the subject's version list rather than by pressing Cmd+Z.
   */
  it('re-entering a subject starts with nothing to undo', async () => {
    enterScope('shader:rect')
    await editMaterial('v1')
    exitScope()

    enterScope('shader:rect')
    await undo() // must NOT reach back into the previous visit
    expect(materialA()).toBe('v1')
    await redo()
    expect(materialA()).toBe('v1')
    exitScope()
  })

  it('a second visit undoes only its own edits', async () => {
    enterScope('shader:rect')
    await editMaterial('v1')
    exitScope()

    enterScope('shader:rect')
    await editMaterial('v2')
    await undo()
    expect(materialA()).toBe('v1') // back to where this visit started, no further
    await undo()
    expect(materialA()).toBe('v1')
    exitScope()
  })

  it('a different subject has its own history', async () => {
    enterScope('shader:rect')
    await editMaterial('v1')
    exitScope()

    enterScope('shader:other')
    await undo() // nothing of this subject's, so nothing happens
    expect(materialA()).toBe('v1')
    exitScope()
  })

  /**
   * Exit, canvas-undo, step back in: redo inside the stage does nothing, and
   * the work is not stranded — the collapsed entry is canvas-scoped, so canvas
   * redo restores the whole session as one step.
   */
  it('after a canvas undo, the session is restored from the canvas, not the stage', async () => {
    enterScope('shader:rect')
    await editMaterial('v1')
    exitScope()

    await undo() // canvas undo of the collapsed session
    expect(materialA()).toBe('v0')

    enterScope('shader:rect')
    await redo() // nothing of this visit's, so nothing happens
    expect(materialA()).toBe('v0')
    exitScope()

    await redo() // the canvas can still put it back
    expect(materialA()).toBe('v1')
  })

  /** No lens reaches outside the open scope, so unrelated work is untouchable. */
  it('redo inside a scope does not resurrect unrelated canvas work', async () => {
    await editCanvas('renamed-on-canvas')
    await undo()
    expect(nameB()).not.toBe('renamed-on-canvas')

    enterScope('shader:rect') // this subject has no history at all
    await redo()
    expect(nameB()).not.toBe('renamed-on-canvas')
    expect(materialA()).toBe('v0')
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
