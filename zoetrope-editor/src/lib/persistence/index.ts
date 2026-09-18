/**
 * persistence — public entry. Owns the singleton provider (selected once per
 * session from environment capability) and the document-lifecycle helpers the
 * app boot + "New document" action use.
 */

import { createNewDocument, setDocument } from '../page-crud'
import {
  selectPersistenceProvider,
  type DocumentPersistenceProvider,
} from './document-persistence'
import { createIndexedDbKvStore } from './kv-indexeddb'

export type { DocumentPersistenceProvider } from './document-persistence'
export { startDocumentAutosave } from './autosave'

let cached: DocumentPersistenceProvider | null = null

/** The capability-selected provider for this session (memoized). */
export function getPersistenceProvider(): DocumentPersistenceProvider {
  return (cached ??= selectPersistenceProvider(createIndexedDbKvStore))
}

/**
 * Load the persisted document if one exists and the environment allows it, else a
 * blank document. The provider's failures degrade to blank rather than trapping
 * the app in a corrupt state.
 */
export async function loadInitialDocument(): Promise<void> {
  const saved = await getPersistenceProvider().load()
  await setDocument(saved ?? createNewDocument())
}

/** Escape hatch: discard the persisted document and start fresh. */
export async function resetToNewDocument(): Promise<void> {
  await getPersistenceProvider().clear()
  await setDocument(createNewDocument())
}
