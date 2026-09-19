/**
 * autosave — debounced whole-document persistence on edit.
 *
 * Subscribes to the commit pipeline (`onChangesApplied`, which also fires on
 * undo/redo) and, after a quiet window, snapshots the document and hands it to the
 * provider under whichever document is open. Inert when the provider can't
 * persist, or when no document is open — an edit with no active id has nowhere to
 * go, and guessing a destination would let one document's edits land in another.
 * Returns a disposer.
 */

import { onChangesApplied } from '../changes/change-emitter'
import { documentModel } from '../renderer/store/document-model'
import type { DocumentPersistenceProvider } from './document-persistence'
import { activeDocumentId } from './document-session'

const DEBOUNCE_MS = 500

export function startDocumentAutosave(
  provider: DocumentPersistenceProvider,
  debounceMs: number = DEBOUNCE_MS,
): () => void {
  if (!provider.canPersist) return () => {}

  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    const id = activeDocumentId.peek()
    if (!id) return
    const doc = documentModel.getDocument()
    if (doc) void provider.save(id, doc)
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
