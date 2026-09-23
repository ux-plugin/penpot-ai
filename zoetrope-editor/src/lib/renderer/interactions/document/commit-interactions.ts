/**
 * Persist a page's interactions IR: a `mod` of the page record through
 * `commitChanges`, so the edit joins the global undo history.
 */
import { get, meta, mod, type LocalChange } from '../../../doc'
import { commitChanges } from '../../store/commit'
import type { PageInteractions, Store } from '../ir'

export async function commitInteractions(pageId: string, next: PageInteractions): Promise<void> {
  if (!get('page', pageId)) return
  await commitChanges({ changes: [mod('page', pageId, { interactions: next })] })
}

/** Read the page's current interactions, or none. */
export function currentInteractions(pageId: string): PageInteractions | undefined {
  return get('page', pageId)?.interactions
}

// ---- stores (document-wide; see DocumentMeta.stores) ----

export function currentStores(): Store[] {
  return meta.peek()?.stores ?? []
}

/**
 * Persist the document's stores. Page edits that belong to the same gesture
 * (detaching a deleted store's cells on every page) ride the same undo frame.
 */
export async function commitStores(
  next: Store[],
  pages: ReadonlyArray<{ pageId: string; next: PageInteractions }> = [],
): Promise<void> {
  const changes: LocalChange[] = []
  for (const edit of pages) {
    if (!get('page', edit.pageId)) continue
    changes.push(mod('page', edit.pageId, { interactions: edit.next }))
  }
  await commitChanges({
    changes,
    docMeta: [{ type: 'set-stores', stores: next }],
    docMetaUndo: [{ type: 'set-stores', stores: currentStores() }],
  })
}
