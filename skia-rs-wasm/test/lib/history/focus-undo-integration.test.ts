/**
 * Integration coverage for focus sub-history over the REAL history store + commit
 * pipeline (the pure focus-undo.test.ts only exercises the walk on hand-built
 * frames). Regression for the reported bug: a focus edit undone by the CANVAS
 * reader (pop model) couldn't be redone from inside the stage, because focus redo
 * is append-only over the undo stack and never looks at the redo stack.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { commitNodePartialUpdate } from '../../../src/lib/renderer/properties/commit-node-properties'
import { focusRedo, focusUndo, canvasRedoInFocusScope } from '../../../src/lib/history/focus-undo'
import type { FocusUndoScope } from '../../../src/lib/renderer/signals/focus-stage'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID, TEXT_ID } from '../fixtures'

beforeEach(() => {
  resetWorkspace()
  setDocument(makeBaseDocument())
  // A defined baseline material (in reality the node already has one when the
  // shader stage opens), so edits are v0→v1 rather than undefined→v1.
  ;(docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as { material?: string }).material = 'v0'
})

const nodeA = () => docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as PenpotNode
const materialA = () => (nodeA() as { material?: string }).material
const nameB = () => (docProxy.pageMap.get(PAGE_ID)!.objects[TEXT_ID] as { name?: string }).name

/** A focus-stage material edit on the rect, tagged with the session groupId. */
async function editMaterial(value: string, groupId: string): Promise<void> {
  await commitNodePartialUpdate(
    RECT_ID,
    nodeA(),
    { material: value } as unknown as Partial<PenpotNode>,
    PAGE_ID,
    groupId,
  )
}

/** A plain canvas edit on a DIFFERENT node (foreign to the shader scope). */
async function editCanvas(name: string): Promise<void> {
  const before = docProxy.pageMap.get(PAGE_ID)!.objects[TEXT_ID] as PenpotNode
  await commitNodePartialUpdate(TEXT_ID, before, { name } as unknown as Partial<PenpotNode>, PAGE_ID)
}

const scope = (groupId: string): FocusUndoScope => ({
  nodeIds: [RECT_ID],
  attrs: ['material'],
  groupId,
})

/** Mirror of App.tsx's Cmd+Shift+Z routing while a focus scope is active. */
async function routedRedo(s: FocusUndoScope): Promise<void> {
  const did = await focusRedo(s)
  if (!did && canvasRedoInFocusScope(s)) await redo()
}

describe('focus sub-history — real commit pipeline', () => {
  it('undo then redo INSIDE one session', async () => {
    await editMaterial('v1', 'g1')
    expect(materialA()).toBe('v1')
    await focusUndo(scope('g1'))
    expect(materialA()).toBe('v0')
    await focusRedo(scope('g1'))
    expect(materialA()).toBe('v1')
  })

  it('append-model redo survives a foreign canvas edit on top', async () => {
    await editMaterial('v1', 'g1')
    await focusUndo(scope('g1'))
    await editCanvas('renamed')
    await focusRedo(scope('g2')) // reopened session (new groupId)
    expect(materialA()).toBe('v1')
  })

  // The reported bug + fix: a focus edit undone by the CANVAS reader lands on the
  // redo stack, which focus redo can't reach — the router bridges to canvas redo.
  it('REGRESSION: focus edit → canvas undo → reopen → redo re-applies it', async () => {
    await editMaterial('v1', 'g1')
    await undo() // canvas undo pops F1 to the redo stack; material → v0
    expect(materialA()).toBe('v0')

    // Bare focus redo can't see the redo stack…
    expect(await focusRedo(scope('g2'))).toBe(false)
    // …but the router's scope-checked bridge does.
    expect(canvasRedoInFocusScope(scope('g2'))).toBe(true)
    await routedRedo(scope('g2'))
    expect(materialA()).toBe('v1')
  })

  it('the bridge is scope-checked: a FOREIGN redo-stack frame is not redone', async () => {
    await editCanvas('renamed') // C1 on TEXT_ID (foreign)
    await undo() // pops C1 to the redo stack; name reverts
    expect(nameB()).not.toBe('renamed')

    // In focus on the rect, redo must NOT resurrect the foreign text edit.
    expect(canvasRedoInFocusScope(scope('g1'))).toBe(false)
    await routedRedo(scope('g1'))
    expect(nameB()).not.toBe('renamed') // untouched
  })
})
