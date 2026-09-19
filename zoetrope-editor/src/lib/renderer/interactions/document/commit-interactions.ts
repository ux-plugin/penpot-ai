/**
 * Persist a page's interactions IR.
 *
 * Routes the edit through the same `commitChanges` pipeline as shape edits, as a
 * `set-page-interactions` change (see ../../../changes/page-interactions-change).
 * That applies the new IR to `docProxy` (so the PreviewStage re-renders and the
 * runtime weaves the new behavior immediately) AND records an undo frame, so the
 * edit joins the global Cmd+Z / Cmd+Shift+Z history alongside Design edits.
 *
 * The redo carries the new IR; the undo carries the page's previous IR (which may
 * be `undefined` for a first-ever edit), so undo restores the exact prior state.
 */

import { docProxy } from '../../store/doc-proxy'
import { commitChanges } from '../../store/commit'
import { buildSetPageInteractions } from '../../../changes/page-interactions-change'
import type { IndexedPage } from '../../../worker/types'
import type { Change } from 'penpot-exporter/types'
import type { PageInteractions, Store } from '../ir'

export async function commitInteractions(pageId: string, next: PageInteractions): Promise<void> {
  const page = docProxy.pageMap.get(pageId) as IndexedPage | undefined
  if (!page) return
  const { redo, undo } = buildSetPageInteractions(pageId, page.interactions, next)
  await commitChanges({ redoChanges: [redo], undoChanges: [undo], pageId, saveUndo: true })
}

/** Read the page's current interactions, or an empty block if none. */
export function currentInteractions(pageId: string): PageInteractions | undefined {
  const page = docProxy.pageMap.get(pageId) as IndexedPage | undefined
  return page?.interactions
}

// ---- stores (document-wide; see DocumentMeta.stores) ----

/** The document's stores, or none. */
export function currentStores(): Store[] {
  return docProxy.meta?.stores ?? []
}

/**
 * Persist the document's stores. Page edits that belong to the same gesture
 * (detaching a deleted store's cells on every page) ride the same undo frame,
 * so one Cmd+Z reverses the whole thing.
 */
export async function commitStores(
  next: Store[],
  pages: ReadonlyArray<{ pageId: string; next: PageInteractions }> = [],
): Promise<void> {
  const redoChanges: Change[] = []
  const undoChanges: Change[] = []
  for (const edit of pages) {
    const page = docProxy.pageMap.get(edit.pageId) as IndexedPage | undefined
    if (!page) continue
    const { redo, undo } = buildSetPageInteractions(edit.pageId, page.interactions, edit.next)
    redoChanges.push(redo)
    undoChanges.push(undo)
  }
  await commitChanges({
    redoChanges,
    undoChanges,
    docMetaRedoChanges: [{ type: 'set-stores', stores: next }],
    docMetaUndoChanges: [{ type: 'set-stores', stores: currentStores() }],
    saveUndo: true,
  })
}
