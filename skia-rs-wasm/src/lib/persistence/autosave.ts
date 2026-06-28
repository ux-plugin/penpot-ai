/**
 * autosave — debounced whole-document persistence on edit.
 *
 * Subscribes to the commit pipeline (`onChangesApplied`, which also fires on
 * undo/redo) and, after a quiet window, snapshots the document and hands it to the
 * provider. Inert when the provider can't persist. Returns a disposer.
 */

import { onChangesApplied } from '../changes/change-emitter'
import { documentModel } from '../renderer/store/document-model'
import type { DocumentPersistenceProvider } from './document-persistence'

const DEBOUNCE_MS = 500

export function startDocumentAutosave(
  provider: DocumentPersistenceProvider,
  debounceMs: number = DEBOUNCE_MS,
): () => void {
  if (!provider.canPersist) return () => {}

  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    const doc = documentModel.getDocument()
    if (doc) void provider.save(doc)
  }

  const unsubscribe = onChangesApplied(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}
