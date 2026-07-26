/**
 * Records a CommitFrame onto the history stack for a commit.
 *
 * Called SYNCHRONOUSLY from `commitChanges`, before the async `emitChangesApplied`
 * dispatch — not as a subscriber. Recording is pure in-memory work and has no
 * dependency on the renderer/worker/selection subscribers, so keeping it on the
 * synchronous side means the undo frame exists before `commitX()` returns to the
 * caller. That's what lets interaction code group edits with plain begin/commit
 * boundaries (focus/blur, pointer down/up) without racing the async render.
 *
 * Skips on undo/redo replay (`fromHistory: true`) and when there's nothing to
 * undo. Otherwise records a single frame with the full redo + undo vectors
 * (history is global, not per-page).
 */

import type { Change } from 'penpot-exporter/types'
import type { DocMetaChange } from '../changes/doc-meta-change'
import { useHistoryStore } from './history-store'
import { appendTxn } from './journal/journal-store'
import { toOps } from './journal/codec'

export function recordHistoryFrame(params: {
  redoChanges: Change[]
  undoChanges: Change[]
  docMetaRedoChanges?: readonly DocMetaChange[]
  docMetaUndoChanges?: readonly DocMetaChange[]
  fromHistory: boolean
  saveUndo: boolean
  groupId?: string
}): void {
  if (params.fromHistory) return
  if (!params.saveUndo) return
  const docUndo = params.docMetaUndoChanges ?? []
  // A doc-meta-only commit (e.g. user added a paint style with no shapes yet)
  // still needs an undo frame: the user expects Cmd+Z to revert it.
  if (params.undoChanges.length === 0 && docUndo.length === 0) return
  const docRedo = params.docMetaRedoChanges ?? []
  useHistoryStore.getState().pushCommitFrame({
    redoChanges: params.redoChanges,
    undoChanges: params.undoChanges,
    docMetaRedoChanges: docRedo.length > 0 ? [...docRedo] : undefined,
    docMetaUndoChanges: docUndo.length > 0 ? [...docUndo] : undefined,
    groupId: params.groupId,
  })

  // ── Journal dual-write (Phase 1 step A; see docs/history-redesign-plan.md) ──
  // Temporary. The journal is written but NOT read: undo/redo still pop the
  // stacks above, so this cannot change behaviour. Its purpose is to populate
  // the log from real application traffic, so the two representations can be
  // compared on genuine flows rather than fixtures, before the reader swaps in
  // step B. Guarded identically to the push above, so the log holds exactly the
  // frames the stack holds.
  appendTxn({
    ops: toOps({
      redoChanges: params.redoChanges,
      undoChanges: params.undoChanges,
      docMetaRedoChanges: docRedo,
      docMetaUndoChanges: docUndo,
    }),
    groupId: params.groupId,
  })
}
