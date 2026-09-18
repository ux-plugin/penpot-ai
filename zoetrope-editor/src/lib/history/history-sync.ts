/**
 * Records a commit into the journal. The single seam every edit enters history
 * through — see `docs/history-redesign-plan.md`.
 *
 * Called SYNCHRONOUSLY from `commitChanges`, before the async
 * `emitChangesApplied` dispatch — not as a subscriber. Recording is pure
 * in-memory work with no dependency on the renderer/worker/selection
 * subscribers, so keeping it on the synchronous side means the entry exists
 * before `commitX()` returns to its caller. That is what lets interaction code
 * group edits with plain begin/commit boundaries (focus/blur, pointer down/up)
 * without racing the async render.
 *
 * Skips on undo/redo replay (`fromHistory: true`), because those already append
 * their own entry carrying an `undoes` back-pointer, and skips when there is
 * nothing to undo.
 */

import { expandBulkChanges, type LocalChange } from '../changes/bulk-changes'
import type { DocMetaChange } from '../changes/doc-meta-change'
import { appendTxn } from './journal/journal-store'
import { toOps } from './journal/codec'

export function recordHistoryFrame(params: {
  /** As written by the caller; bulk changes are expanded before they become ops. */
  redoChanges: LocalChange[]
  undoChanges: LocalChange[]
  docMetaRedoChanges?: readonly DocMetaChange[]
  docMetaUndoChanges?: readonly DocMetaChange[]
  fromHistory: boolean
  saveUndo: boolean
}): void {
  if (params.fromHistory) return
  if (!params.saveUndo) return
  const docUndo = params.docMetaUndoChanges ?? []
  // A doc-meta-only commit (e.g. the user added a paint style with no shapes
  // yet) still needs an entry: they expect Cmd+Z to revert it.
  if (params.undoChanges.length === 0 && docUndo.length === 0) return

  // The journal's ops are per shape, so bulk changes are expanded here — the one
  // place history sees them.
  appendTxn({
    ops: toOps({
      redoChanges: expandBulkChanges(params.redoChanges),
      undoChanges: expandBulkChanges(params.undoChanges),
      docMetaRedoChanges: params.docMetaRedoChanges ?? [],
      docMetaUndoChanges: docUndo,
    }),
  })
}
