/**
 * The focus-mode undo reader: a fine-grained, per-entity lens over the ONE
 * document history. Where the canvas reader (`undo`/`redo` in page-crud) reverts
 * a whole session as one coarse step (by `groupId`), the focus reader steps
 * through a session's individual frames — but only those it owns.
 *
 * Ownership is derived at READ time from what each frame touches (its
 * `(nodeId, attr)` targets), never stamped by the writer — so the same lens also
 * covers frames from a PREVIOUS session on the same shape (reopen-and-undo) and
 * frames written by other paths (token propagation on a bound uniform).
 *
 * ## Append model (no popping, no shared redo stack)
 *
 * A focus op never pops a frame and never pushes to the global redo stack —
 * doing so would corrupt canvas run-redo (which pops a whole run and, because
 * material assigns are full-value, is order-sensitive). Instead every focus op
 * APPENDS a new commit carrying the session `groupId` (so canvas group-undo
 * still sweeps it) and, for a revert, `synthetic: true` (so this reader skips
 * it). The stack is the single source of truth; the undo cursor is *derived*
 * from the frames by a debt walk:
 *
 *  - `focusUndo`: from the top, skip foreign frames; each in-scope `synthetic`
 *    revert is +1 debt; the first in-scope non-synthetic (forward) frame with
 *    zero debt is the target → append its stored inverse (`undoChanges`).
 *  - `focusRedo`: the mirror — each in-scope forward is +1 debt; the first
 *    in-scope revert with zero debt is the target → re-apply the forward it
 *    reverted (the revert's `undoChanges`), appended as a *non-synthetic* frame
 *    so the next `focusUndo` targets it again.
 *
 * A re-applied forward is indistinguishable from a fresh user edit — which is
 * correct: both are "this version is applied". Interleaving (a foreign frame
 * between two of ours) falls out for free: the walk just skips foreign frames,
 * so it reaches an in-scope frame that isn't the stack top without disturbing
 * what sits above it. See [[project_undo_model]].
 */

import type { Change } from 'penpot-exporter/types'
import type { CommitFrame } from '../changes/commit-types'
import type { FocusUndoScope } from '../renderer/signals/focus-stage'
import { useHistoryStore } from './history-store'
import { commitChanges } from '../renderer/store/commit'
import { flushFocusPending } from './focus-pending'

/** A `mod-obj` change with the fields the scope test reads. */
interface AssignOp {
  type: string
  value?: Record<string, unknown>
}
interface ModObjChange {
  type: 'mod-obj'
  id: string
  operations?: AssignOp[]
}

function isModObj(ch: Change): ch is Change & ModObjChange {
  return (ch as { type?: string }).type === 'mod-obj'
}

/**
 * A frame is in scope only when EVERY change it carries is a `mod-obj` on an
 * in-scope node assigning only in-scope attrs — and it has no doc-meta arm. The
 * all-or-nothing rule is the safety property: the focus reader can only revert
 * frames that touch *this* entity's owned attrs, never a frame that also mutated
 * something else (a mixed frame, an `add-obj` for a new shape, a paint-style
 * commit) — those are "foreign" and skipped.
 */
export function frameInScope(frame: CommitFrame, scope: FocusUndoScope): boolean {
  if (frame.redoChanges.length === 0) return false
  if ((frame.docMetaRedoChanges?.length ?? 0) > 0) return false
  const nodeIds = scope.nodeIds
  const attrs = scope.attrs
  return frame.redoChanges.every((ch) => {
    if (!isModObj(ch)) return false
    if (!nodeIds.includes(ch.id)) return false
    const ops: AssignOp[] = ch.operations ?? []
    return ops.every(
      (op) =>
        op.type === 'assign' &&
        Object.keys(op.value ?? {}).every((a) => attrs.includes(a)),
    )
  })
}

/**
 * Index of the frame `focusUndo` would revert, or `-1` if there's nothing in
 * scope to undo. Pure — used both by `focusUndo` and by `hasFocusUndo` (button
 * state). The walk is O(distance-to-target); worst case O(stack) only when
 * nothing in scope exists, and the stack is capped (see history-store).
 */
export function findFocusUndoTarget(stack: readonly CommitFrame[], scope: FocusUndoScope): number {
  let debt = 0
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i]
    if (!frameInScope(f, scope)) continue
    if (f.synthetic) {
      debt++
      continue
    }
    if (debt > 0) {
      debt--
      continue
    }
    return i
  }
  return -1
}

/**
 * Index of the revert `focusRedo` would cancel, or `-1` if nothing in scope is
 * currently reverted. Mirror of {@link findFocusUndoTarget}: forwards are debt,
 * the first zero-debt revert is the target.
 */
export function findFocusRedoTarget(stack: readonly CommitFrame[], scope: FocusUndoScope): number {
  let debt = 0
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i]
    if (!frameInScope(f, scope)) continue
    if (!f.synthetic) {
      debt++
      continue
    }
    if (debt > 0) {
      debt--
      continue
    }
    return i
  }
  return -1
}

/** Is there an in-scope frame the focus reader could undo? (For button state.) */
export function hasFocusUndo(scope: FocusUndoScope): boolean {
  return findFocusUndoTarget(useHistoryStore.getState().undoStack, scope) >= 0
}

/** Is there an in-scope revert the focus reader could redo? */
export function hasFocusRedo(scope: FocusUndoScope): boolean {
  return findFocusRedoTarget(useHistoryStore.getState().undoStack, scope) >= 0
}

/**
 * Serialize focus undo/redo. Each op reads the stack, then `await`s an async
 * commit before its result lands — so overlapping calls (Cmd+Z autorepeat, or a
 * fast-clicked button) would otherwise all read the SAME pre-append stack and
 * revert the same frame, collapsing N presses into one. Chaining makes each op
 * observe the previous one's appended frame, so held Cmd+Z steps reliably.
 */
let opChain: Promise<boolean> = Promise.resolve(false)
function enqueue(op: () => Promise<boolean>): Promise<boolean> {
  const run = opChain.then(op, op)
  // Keep the chain alive even if an op throws, without swallowing the error for
  // the caller who awaited `run`.
  opChain = run.then(
    () => false,
    () => false,
  )
  return run
}

async function doFocusUndo(scope: FocusUndoScope): Promise<boolean> {
  await flushFocusPending()
  const stack = useHistoryStore.getState().undoStack
  const i = findFocusUndoTarget(stack, scope)
  if (i < 0) return false
  const target = stack[i]
  await commitChanges({
    // Apply the target's inverse to revert it; keep its forward as our undo so
    // this synthetic frame is itself redoable.
    redoChanges: target.undoChanges,
    undoChanges: target.redoChanges,
    docMetaRedoChanges: target.docMetaUndoChanges,
    docMetaUndoChanges: target.docMetaRedoChanges,
    groupId: scope.groupId,
    synthetic: true,
  })
  return true
}

async function doFocusRedo(scope: FocusUndoScope): Promise<boolean> {
  await flushFocusPending()
  const stack = useHistoryStore.getState().undoStack
  const i = findFocusRedoTarget(stack, scope)
  if (i < 0) return false
  const revert = stack[i]
  await commitChanges({
    // The revert's `undoChanges` is the original forward's redo — re-apply it.
    redoChanges: revert.undoChanges,
    undoChanges: revert.redoChanges,
    docMetaRedoChanges: revert.docMetaUndoChanges,
    docMetaUndoChanges: revert.docMetaRedoChanges,
    groupId: scope.groupId,
    synthetic: false,
  })
  return true
}

/**
 * Undo the most recent in-scope edit by appending its stored inverse as a new
 * (synthetic, session-tagged) commit. Returns true if it reverted something.
 * Flushes the open stage's pending draft first so a just-typed edit is visible.
 * Serialized against other focus ops (see {@link enqueue}).
 */
export function focusUndo(scope: FocusUndoScope): Promise<boolean> {
  return enqueue(() => doFocusUndo(scope))
}

/**
 * Redo the most recent in-scope revert by re-applying the forward it undid,
 * appended as a NON-synthetic commit (so a following `focusUndo` targets it
 * again). Returns true if it redid something. Serialized (see {@link enqueue}).
 */
export function focusRedo(scope: FocusUndoScope): Promise<boolean> {
  return enqueue(() => doFocusRedo(scope))
}
