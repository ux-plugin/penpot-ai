/**
 * A single-slot registry for the *open* focus stage's pending-draft flush.
 *
 * A focus editor keeps a live `draft` and commits it to the document on an idle
 * timer, so an edit made moments before Cmd+Z may not be a history frame yet.
 * `focusUndo`/`focusRedo` read the committed history, so they must flush that
 * pending draft FIRST — otherwise the freshest edit is invisible to the walk.
 *
 * Only one focus stage is open at a time, so one slot suffices. The flush is
 * awaited: the commit records its frame synchronously *inside* `commitChanges`,
 * but `commitChanges` is async, so the frame isn't on the stack until the
 * returned promise settles.
 */

let pendingFlush: (() => void | Promise<void>) | null = null

/**
 * Register the open stage's flush. Returns a disposer that clears the slot only
 * if it still holds this exact function (so a remount that re-registers before
 * the old effect's cleanup runs doesn't wipe the new registration).
 */
export function registerFocusFlush(flush: () => void | Promise<void>): () => void {
  pendingFlush = flush
  return () => {
    if (pendingFlush === flush) pendingFlush = null
  }
}

/** Flush the open stage's pending draft, if any. Awaited by the focus reader. */
export async function flushFocusPending(): Promise<void> {
  await pendingFlush?.()
}
