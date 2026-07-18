import { describe, expect, it } from 'vitest'
import {
  frameInScope,
  findFocusUndoTarget,
  findFocusRedoTarget,
} from '@/lib/history/focus-undo'
import type { CommitFrame } from '@/lib/changes/commit-types'
import type { FocusUndoScope } from '@/lib/renderer/signals/focus-stage'
import type { Change } from 'penpot-exporter/types'

// --- Frame builders -------------------------------------------------------
// A material edit on `node` from `from`→`to`: a `mod-obj` assigning `material`,
// exactly what `commitNodePartialUpdate` records. `from`/`to` are opaque tags.
const modObj = (node: string, val: string, attr = 'material'): Change =>
  ({ type: 'mod-obj', id: node, operations: [{ type: 'assign', value: { [attr]: val } }] }) as unknown as Change

const fwd = (node: string, from: string, to: string): CommitFrame => ({
  redoChanges: [modObj(node, to)],
  undoChanges: [modObj(node, from)],
})

// A canvas create-shape frame — the interleaving "foreign" case: an `add-obj`
// paired with its `del-obj` inverse. Not a `mod-obj`, so never in a shader scope.
const createShape = (id: string): CommitFrame => ({
  redoChanges: [{ type: 'add-obj', id } as unknown as Change],
  undoChanges: [{ type: 'del-obj', id } as unknown as Change],
})

const scopeA: FocusUndoScope = { nodeIds: ['A'], attrs: ['material'], groupId: 'gA' }

// Mimic exactly what focusUndo/focusRedo append, so sequence tests read like the
// real flow: undo appends the target's inverse (synthetic); redo re-applies the
// forward a revert undid (non-synthetic).
const appendUndo = (stack: CommitFrame[], scope: FocusUndoScope): CommitFrame[] => {
  const i = findFocusUndoTarget(stack, scope)
  if (i < 0) return stack
  const t = stack[i]
  return [...stack, { redoChanges: t.undoChanges, undoChanges: t.redoChanges, groupId: scope.groupId, synthetic: true }]
}
const appendRedo = (stack: CommitFrame[], scope: FocusUndoScope): CommitFrame[] => {
  const i = findFocusRedoTarget(stack, scope)
  if (i < 0) return stack
  const r = stack[i]
  return [...stack, { redoChanges: r.undoChanges, undoChanges: r.redoChanges, groupId: scope.groupId, synthetic: false }]
}

// The material value a focus undo would APPLY next — the target forward's
// `undoChanges` (its "before" tag). Lets us assert "undo lands on version vN"
// without reaching into the commit pipeline.
const nextUndoValue = (stack: CommitFrame[], scope: FocusUndoScope): string | null => {
  const i = findFocusUndoTarget(stack, scope)
  if (i < 0) return null
  const ch = stack[i].undoChanges[0] as unknown as { operations: { value: Record<string, string> }[] }
  return ch.operations[0].value.material
}

describe('frameInScope', () => {
  it('matches a material mod-obj on an in-scope node', () => {
    expect(frameInScope(fwd('A', 'v0', 'v1'), scopeA)).toBe(true)
  })
  it('rejects a different node', () => {
    expect(frameInScope(fwd('B', 'v0', 'v1'), scopeA)).toBe(false)
  })
  it('rejects a create-shape (not a mod-obj)', () => {
    expect(frameInScope(createShape('R'), scopeA)).toBe(false)
  })
  it('rejects a frame that also assigns an out-of-scope attr', () => {
    const mixed: CommitFrame = {
      redoChanges: [{ type: 'mod-obj', id: 'A', operations: [{ type: 'assign', value: { material: 'x', opacity: 0.5 } }] } as unknown as Change],
      undoChanges: [modObj('A', 'v0')],
    }
    expect(frameInScope(mixed, scopeA)).toBe(false)
  })
  it('rejects a frame carrying a doc-meta arm', () => {
    const f = { ...fwd('A', 'v0', 'v1'), docMetaRedoChanges: [{} as unknown as never] }
    expect(frameInScope(f, scopeA)).toBe(false)
  })
  it('rejects an empty frame', () => {
    expect(frameInScope({ redoChanges: [], undoChanges: [] }, scopeA)).toBe(false)
  })
})

describe('findFocusUndoTarget / findFocusRedoTarget — non-interleaved', () => {
  it('targets the topmost forward, walks back through reverts via debt, then no-op', () => {
    let stack = [fwd('A', 'v0', 'v1'), fwd('A', 'v1', 'v2')]
    expect(findFocusUndoTarget(stack, scopeA)).toBe(1) // A2 (→ v1)
    stack = appendUndo(stack, scopeA) // revert A2
    expect(findFocusUndoTarget(stack, scopeA)).toBe(0) // A1 (→ v0), skipping the revert
    stack = appendUndo(stack, scopeA) // revert A1
    expect(findFocusUndoTarget(stack, scopeA)).toBe(-1) // nothing left to undo
  })

  it('round-trips undo→redo→undo (redo re-applies, next undo targets it)', () => {
    let stack = [fwd('A', 'v0', 'v1'), fwd('A', 'v1', 'v2')]
    stack = appendUndo(stack, scopeA) // at v1
    stack = appendUndo(stack, scopeA) // at v0
    expect(findFocusRedoTarget(stack, scopeA)).toBe(3) // cancel the R(A1) revert
    stack = appendRedo(stack, scopeA) // re-apply A1 → v1
    expect(findFocusRedoTarget(stack, scopeA)).toBe(2) // cancel the R(A2) revert → v2
    stack = appendRedo(stack, scopeA) // at v2
    expect(findFocusRedoTarget(stack, scopeA)).toBe(-1) // fully redone
    // A fresh undo now targets the re-applied top forward.
    expect(findFocusUndoTarget(stack, scopeA)).toBe(stack.length - 1)
  })
})

describe('interleaving — foreign frames are skipped, not reverted', () => {
  it('A → B → A: focus undo steps through A, leaving B untouched', () => {
    let stack = [fwd('A', 'v0', 'v1'), fwd('B', 'w0', 'w1'), fwd('A', 'v1', 'v2')]
    expect(findFocusUndoTarget(stack, scopeA)).toBe(2) // A2 (top, in scope)
    stack = appendUndo(stack, scopeA)
    // Walk past the appended revert (debt) AND the foreign B frame → land on A1.
    expect(findFocusUndoTarget(stack, scopeA)).toBe(0)
    // The B frame is never a target for scope A.
    expect(frameInScope(stack[1], scopeA)).toBe(false)
  })

  it('shader → create-shape → shader: undo skips the add-obj, leaving the shape', () => {
    let stack = [fwd('A', 'v0', 'v1'), createShape('R'), fwd('A', 'v1', 'v2')]
    expect(findFocusUndoTarget(stack, scopeA)).toBe(2)
    stack = appendUndo(stack, scopeA)
    expect(findFocusUndoTarget(stack, scopeA)).toBe(0) // A1, past the revert + the create
    expect(frameInScope(stack[1], scopeA)).toBe(false) // create-shape stays foreign
  })
})

describe('the empty full-walk no-op', () => {
  it('returns -1 on an empty stack', () => {
    expect(findFocusUndoTarget([], scopeA)).toBe(-1)
    expect(findFocusRedoTarget([], scopeA)).toBe(-1)
  })
  it('returns -1 when the whole stack is foreign (walks it all, finds nothing)', () => {
    const stack = [createShape('R'), fwd('B', 'w0', 'w1'), createShape('S')]
    expect(findFocusUndoTarget(stack, scopeA)).toBe(-1)
    expect(findFocusRedoTarget(stack, scopeA)).toBe(-1)
  })
})

describe('applied value tracking (undo lands on the right version)', () => {
  it('reverting A2 applies A2.before (v1), reverting A1 applies A1.before (v0)', () => {
    let stack = [fwd('A', 'v0', 'v1'), fwd('A', 'v1', 'v2')]
    expect(nextUndoValue(stack, scopeA)).toBe('v1') // undo A2 → v1
    stack = appendUndo(stack, scopeA)
    expect(nextUndoValue(stack, scopeA)).toBe('v0') // undo A1 → v0
  })
})
