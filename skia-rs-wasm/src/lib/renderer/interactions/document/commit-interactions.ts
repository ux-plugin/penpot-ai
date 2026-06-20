/**
 * Persist a page's interactions IR.
 *
 * Writes the updated PageInteractions onto the page via `commitPageUpdate` — the
 * same page-replacement path the page-metadata editors use. That updates
 * `docProxy`, so the PreviewStage (which reads the snapshot) re-renders and the
 * runtime weaves the new behavior immediately.
 *
 * Note: like the page-metadata path, this does not enter the Change[]/history
 * pipeline, so it isn't on the global Cmd+Z stack — edits are reversed in the
 * panel. Wiring it to undo needs a page-level Change kind the pipeline lacks.
 */

import { docProxy } from '../../store/doc-proxy'
import { commitPageUpdate } from '../../store/commit'
import type { IndexedPage } from '../../../worker/types'
import type { PageInteractions } from '../ir'

export async function commitInteractions(pageId: string, next: PageInteractions): Promise<void> {
  const page = docProxy.pageMap.get(pageId) as IndexedPage | undefined
  if (!page) return
  const updatedPage: IndexedPage = { ...page, interactions: next }
  await commitPageUpdate({ pageId, updatedPage })
}

/** Read the page's current interactions, or an empty block if none. */
export function currentInteractions(pageId: string): PageInteractions | undefined {
  const page = docProxy.pageMap.get(pageId) as IndexedPage | undefined
  return page?.interactions
}
