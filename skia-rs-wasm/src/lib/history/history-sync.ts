/**
 * Subscriber that pushes a CommitFrame onto the history stack after a commit.
 *
 * Was inlined inside `commitChanges` as a final `if (!fromHistory && saveUndo)`
 * block; relocated here so the commit step doesn't own history concerns.
 *
 * Skips on undo/redo replay (`fromHistory: true`) and when there's nothing to
 * undo. Otherwise pushes a single frame containing the full redoChanges +
 * undoChanges from the original commit (history is global, not per-page).
 */

import type { ChangesAppliedEvent } from '../changes/change-emitter'
import { useHistoryStore } from './history-store'

export function historySyncHandler(event: ChangesAppliedEvent): void {
  if (event.fromHistory) return
  if (!event.saveUndo) return
  if (event.undoChanges.length === 0) return
  useHistoryStore.getState().pushCommitFrame({
    redoChanges: event.redoChanges,
    undoChanges: event.undoChanges,
  })
}
