/**
 * Synchronous pub/sub for changes applied to the document.
 *
 * `commitChanges` (renderer/store/commit.ts) mutates `docProxy.pageMap` and
 * then emits a single `ChangesAppliedEvent`. Subscribers consume that event
 * sequentially in registration order. Today's registered subscribers (see
 * commit.ts for the canonical ordering):
 *
 *   1. renderer-sync   — pushes per-shape state to WASM (partial-aware setObject)
 *   2. selection-sync  — re-queries `wasmSelectionRect` if the commit touched a
 *                        selected shape (must follow renderer-sync so WASM has
 *                        absorbed the new state before the query fires)
 *   3. worker-sync     — feeds the spatial-index update (fire-and-forget per page)
 *   4. history-sync    — pushes a CommitFrame onto the undo stack when applicable
 *
 * Registration is centralized in commit.ts to keep the order explicit and
 * insensitive to import ordering elsewhere — subscribers export their handler
 * functions and commit.ts calls `onChangesApplied(handler)` for each in
 * sequence at module load.
 *
 * Mirrors CLJS's separation between mutating `app-db` and dispatching effects:
 * `commitChanges` is "apply state + dispatch", subscribers are the effects.
 */

import type { Change } from 'penpot-exporter/types'
import type { IndexedPage } from '../worker/types'
import type { DocMetaChange } from './doc-meta-change'

export interface ChangesAppliedPagePayload {
  pageId: string
  /** Changes that were applied to this specific page. */
  changes: Change[]
  /** Snapshot of the page before this commit applied. `undefined` for new pages. */
  oldPage: IndexedPage | undefined
  /** Page state after `processChanges` ran. Already written to `docProxy.pageMap`. */
  updatedPage: IndexedPage
}

export interface ChangesAppliedEvent {
  /** Full redo set across every affected page (for history). */
  redoChanges: Change[]
  /** Full undo set across every affected page (for history). */
  undoChanges: Change[]
  /**
   * Doc-meta arm of the commit — library CRUD (paint styles, text styles).
   * Renderer-sync / selection-sync / worker-sync ignore these; doc-meta state
   * has already been applied to `docProxy.meta` by the time the event fires.
   * UI panels reading the library re-render via Valtio's reactivity, not this
   * event. Included here only so history-sync can record them on the frame.
   */
  docMetaRedoChanges: readonly DocMetaChange[]
  docMetaUndoChanges: readonly DocMetaChange[]
  /** Per-page payload — one entry per page touched by this commit. */
  pages: readonly ChangesAppliedPagePayload[]
  fromHistory: boolean
  saveUndo: boolean
  /** Pass-through of the legacy commit flag — when true, renderer-sync skips its work. */
  ignoreRendererSync: boolean
}

type Handler = (event: ChangesAppliedEvent) => void | Promise<void>

const handlers: Handler[] = []

/**
 * Register a subscriber. Returns a disposer.
 * Subscribers fire in registration order on each `emitChangesApplied` call.
 */
export function onChangesApplied(handler: Handler): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i >= 0) handlers.splice(i, 1)
  }
}

/**
 * Invoke every registered subscriber sequentially, awaiting each. Resolves
 * once all have completed. Errors thrown by a subscriber propagate.
 */
export async function emitChangesApplied(event: ChangesAppliedEvent): Promise<void> {
  for (const handler of handlers) {
    await handler(event)
  }
}
