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
import type { PageInteractions } from '../ir'

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
