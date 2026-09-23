/**
 * The document store for this session, chosen by what the environment offers:
 * SQLite over OPFS in a worker when both exist, nothing otherwise.
 */
import { NoneDocumentStore, type DocumentStore } from './document-store'
import { WorkerDocumentStore } from './worker-store'

let cached: DocumentStore | null = null

function canUseOpfs(): boolean {
  return typeof Worker !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

export function getPersistenceProvider(): DocumentStore {
  return (cached ??= canUseOpfs() ? new WorkerDocumentStore() : new NoneDocumentStore())
}

/** Tests: use `store` for the rest of the session (`null` re-selects). */
export function setPersistenceProviderForTests(store: DocumentStore | null): void {
  cached = store
}
