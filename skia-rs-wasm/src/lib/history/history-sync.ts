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
import { useHistoryStore } from './history-store'

export function recordHistoryFrame(params: {
  redoChanges: Change[]
  undoChanges: Change[]
  fromHistory: boolean
  saveUndo: boolean
}): void {
  if (params.fromHistory) return
  if (!params.saveUndo) return
  if (params.undoChanges.length === 0) return
  useHistoryStore.getState().pushCommitFrame({
    redoChanges: params.redoChanges,
    undoChanges: params.undoChanges,
  })
}
