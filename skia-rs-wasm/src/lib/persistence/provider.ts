/**
 * provider — the capability-selected persistence provider for this session.
 *
 * Its own module rather than part of `index.ts` so `document-session` can reach
 * the singleton without importing the package barrel, which would close an import
 * cycle (barrel → session → barrel).
 */

import {
  selectPersistenceProvider,
  type DocumentPersistenceProvider,
} from './document-persistence'
import { createIndexedDbKvStore } from './kv-indexeddb'

let cached: DocumentPersistenceProvider | null = null

/** The capability-selected provider for this session (memoized). */
export function getPersistenceProvider(): DocumentPersistenceProvider {
  return (cached ??= selectPersistenceProvider(createIndexedDbKvStore))
}

/** Tests only: drop the memoized provider so the next call re-selects. */
export function resetPersistenceProviderForTests(): void {
  cached = null
}
