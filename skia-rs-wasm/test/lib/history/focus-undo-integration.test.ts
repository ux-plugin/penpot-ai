/**
 * Integration coverage for the focus sub-history buffer over the REAL history
 * store + commit pipeline. The model: while a focus stage is open its commits
 * land in an ephemeral buffer (Cmd+Z steps a cursor); canvas undo/redo are
 * disabled; on exit the buffer's live prefix folds into ONE canvas undo entry
 * and the buffer is discarded (re-entering starts empty). Penpot's path-editor
 * sub-undo shape, not the old append/cancellation model.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { commitNodePartialUpdate } from '../../../src/lib/renderer/properties/commit-node-properties'
import { focusRedo, focusUndo } from '../../../src/lib/history/focus-undo'
import {
  useHistoryStore,
  beginFocusBuffer,
  endFocusBuffer,
  beginHistoryTransaction,
  commitHistoryTransaction,
} from '../../../src/lib/history/history-store'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID, TEXT_ID } from '../fixtures'

beforeEach(() => {
  resetWorkspace()
  setDocument(makeBaseDocument())
  // A defined baseline material, so edits are v0→v1 rather than undefined→v1
  // (assigning undefined is a no-op in the apply layer).
  ;(docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material = 'v0'
})

const materialA = () =>
  (docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material
const nameB = () => (docProxy.pageMap.get(PAGE_ID)!.objects[TEXT_ID] as { name?: string }).name
const buffer = () => useHistoryStore.getState().focusBuffer
const undoDepth = () => useHistoryStore.getState().undoStack.length

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

describe('focus sub-history buffer — real commit pipeline', () => {
  it('steps the cursor inside one session; past-start is a no-op (not an exit)', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    expect(materialA()).toBe('v2')
    expect(buffer()!.frames.length).toBe(2)

    expect(await focusUndo()).toBe(true)
    expect(materialA()).toBe('v1')
    expect(await focusUndo()).toBe(true)
    expect(materialA()).toBe('v0')

    // Past the start: no-op, and the stage stays open (button disabled, no exit).
    expect(await focusUndo()).toBe(false)
    expect(buffer()).not.toBeNull()

    await focusRedo()
    expect(materialA()).toBe('v1')
  })

  it('canvas undo/redo are disabled while the buffer is open', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await undo() // guarded no-op
    expect(materialA()).toBe('v1')
    expect(undoDepth()).toBe(0) // nothing on the global stack yet
    await redo()
    expect(materialA()).toBe('v1')
  })

  it('exit folds the whole session into ONE canvas entry', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    endFocusBuffer()
    expect(buffer()).toBeNull()
    expect(undoDepth()).toBe(1)
    expect(materialA()).toBe('v2')

    await undo() // one press reverts the whole session
    expect(materialA()).toBe('v0')
    await redo()
    expect(materialA()).toBe('v2')
  })

  it('exit after undoing the whole session records nothing', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    await focusUndo()
    await focusUndo()
    expect(materialA()).toBe('v0')
    endFocusBuffer()
    expect(undoDepth()).toBe(0)
    expect(materialA()).toBe('v0')
  })

  // The scenario the user asked about: undo a small portion in focus, then exit.
  it('exit folds only the LIVE prefix after a partial focus-undo', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await editMaterial('v2')
    await editMaterial('v3')
    await focusUndo() // drop v3 → live prefix is [v1, v2]
    expect(materialA()).toBe('v2')
    endFocusBuffer()
    expect(undoDepth()).toBe(1)
    expect(materialA()).toBe('v2')

    await undo() // the live prefix reverts as one step
    expect(materialA()).toBe('v0')
  })

  it('re-entering starts with an empty buffer (no persistent sub-history)', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    endFocusBuffer()
    beginFocusBuffer('s2')
    expect(buffer()!.frames.length).toBe(0)
    expect(await focusUndo()).toBe(false)
    endFocusBuffer()
  })

  it('a transaction inside the stage is ONE focus step', async () => {
    beginFocusBuffer('s1')
    beginHistoryTransaction('drag')
    await editMaterial('v1')
    await editMaterial('v2')
    commitHistoryTransaction('drag')
    expect(buffer()!.frames.length).toBe(1) // gesture merged into one buffer frame

    expect(await focusUndo()).toBe(true)
    expect(materialA()).toBe('v0') // one focus undo reverts the whole gesture
  })

  it('a foreign commit during the session folds into the collapse (deliberate)', async () => {
    beginFocusBuffer('s1')
    await editMaterial('v1')
    await editCanvas('renamed') // lands in the buffer too — swept by the fold
    expect(buffer()!.frames.length).toBe(2)
    endFocusBuffer()
    expect(undoDepth()).toBe(1)

    await undo() // one press reverts BOTH the material and the rename
    expect(materialA()).toBe('v0')
    expect(nameB()).not.toBe('renamed')
  })
})
