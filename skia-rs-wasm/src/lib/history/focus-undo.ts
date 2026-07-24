/**
 * Focus sub-history: an ephemeral, in-session undo cursor over the buffer the
 * history store fills while a focus stage is open (`beginFocusBuffer` /
 * `endFocusBuffer` in history-store).
 *
 * While the buffer is open the canvas reader (`undo`/`redo` in page-crud) is
 * disabled and Cmd+Z steps THIS cursor one frame at a time; on stage close the
 * buffer's live prefix folds into a single entry on the one document history,
 * and the buffer is discarded — there is no persistent per-session history
 * (re-entering starts empty). This is Penpot's path-editor sub-undo shape
 * (`path/undo.cljs`), not the old append/cancellation model.
 *
 * Nothing here pops or appends a history frame. Applying a frame's inverse is a
 * `fromHistory` commit — it mutates the document but records no new frame — and
 * the cursor is moved explicitly via `moveFocusCursor`. See
 * [[project_undo_model]].
 */

import { useHistoryStore } from './history-store'
import { commitChanges } from '../renderer/store/commit'
import { flushFocusPending } from './focus-pending'

/** Is there a buffered frame the focus cursor could step back over? (Button state.) */
export function hasFocusUndo(): boolean {
  const b = useHistoryStore.getState().focusBuffer
  return b != null && b.index > 0
}

/** Is there a buffered frame the focus cursor could step forward onto? */
export function hasFocusRedo(): boolean {
  const b = useHistoryStore.getState().focusBuffer
  return b != null && b.index < b.frames.length
}

/**
 * Serialize focus undo/redo. Each op flushes the pending draft (an async commit)
 * before reading the cursor, so overlapping calls (Cmd+Z autorepeat, or a
 * fast-clicked button) would otherwise read the SAME cursor and step the same
 * frame. Chaining makes each op observe the previous one's moved cursor.
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

async function doFocusUndo(): Promise<boolean> {
  await flushFocusPending()
  const buf = useHistoryStore.getState().focusBuffer
  if (!buf || buf.index === 0) return false
  const frame = buf.frames[buf.index - 1]
  // fromHistory: apply the inverse without recording a new buffer frame; the
  // cursor move below is the only bookkeeping.
  await commitChanges({
    redoChanges: frame.undoChanges,
    docMetaRedoChanges: frame.docMetaUndoChanges,
    saveUndo: false,
    fromHistory: true,
  })
  useHistoryStore.getState().moveFocusCursor(-1)
  return true
}

async function doFocusRedo(): Promise<boolean> {
  await flushFocusPending()
  const buf = useHistoryStore.getState().focusBuffer
  if (!buf || buf.index >= buf.frames.length) return false
  const frame = buf.frames[buf.index]
  await commitChanges({
    redoChanges: frame.redoChanges,
    docMetaRedoChanges: frame.docMetaRedoChanges,
    saveUndo: false,
    fromHistory: true,
  })
  useHistoryStore.getState().moveFocusCursor(1)
  return true
}

/**
 * Step the focus cursor back one frame (applying that frame's inverse). Returns
 * true if it reverted something. Flushes the open stage's pending draft first so
 * a just-typed edit is on the cursor. Serialized (see {@link enqueue}).
 */
export function focusUndo(): Promise<boolean> {
  return enqueue(doFocusUndo)
}

/**
 * Step the focus cursor forward one frame (re-applying it). Returns true if it
 * redid something. Serialized (see {@link enqueue}).
 */
export function focusRedo(): Promise<boolean> {
  return enqueue(doFocusRedo)
}
