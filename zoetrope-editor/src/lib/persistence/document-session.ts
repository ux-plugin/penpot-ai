/**
 * document-session — which document is currently open in the editor.
 *
 * The store holds a library; exactly one of its documents is loaded into the
 * canvas at a time, and this module is the seam between the two. It owns the
 * open/create/close verbs so no other module has to remember to keep the store's
 * `active` key, the editor's loaded document, and the id signal in step.
 *
 * `activeDocumentId` is a signal rather than React state for the same reason
 * `editorMode` is: it's read from outside React (autosave is a plain module), and
 * the documents/canvas view switch will read it too.
 *
 * Switching documents does not need to clear undo history here —
 * `documentModel.loadDocument` already calls `clearHistory()`, so an undo can
 * never reach back into a document you've left.
 */

import { signal } from '@preact/signals-core'
import { createNewDocument, setDocument } from '../page-crud'
import { getPersistenceProvider } from './provider'
import type { DocumentSummary } from './document-summary'

/** Id of the document loaded in the editor, or null when none is open.
 *  Written only by this module; read by autosave and (later) the view switch. */
export const activeDocumentId = signal<string | null>(null)

/** Load a stored document into the editor. Returns false when the id is gone or
 *  unreadable, leaving the current document alone — a dead link on the documents
 *  screen shouldn't blank the canvas. */
export async function openDocument(id: string): Promise<boolean> {
  const provider = getPersistenceProvider()
  const doc = await provider.load(id)
  if (!doc) return false
  await markOpen(id)
  await setDocument(doc)
  return true
}

/**
 * Add a blank document to the library. It is deliberately *not* opened here —
 * callers navigate to its id and the route effect loads it, so there is exactly
 * one path into a document. Opening here too would load it twice.
 */
export async function createDocument(): Promise<DocumentSummary> {
  return getPersistenceProvider().create(createNewDocument())
}

/**
 * Record which document is open *before* handing it to the canvas.
 *
 * Ordering is deliberate: "what's open" is a session fact, not a rendering
 * outcome. If `setDocument` fails — a renderer that can't create a surface, a
 * WASM abort — the store still points at the document the user asked for, so a
 * reload retries the same one instead of silently landing somewhere else.
 */
async function markOpen(id: string): Promise<void> {
  activeDocumentId.value = id
  await getPersistenceProvider().setActiveId(id)
}

/** Leave the open document. The canvas keeps its last contents until something
 *  else is loaded; the documents screen is what renders in its place. */
export async function closeDocument(): Promise<void> {
  activeDocumentId.value = null
  await getPersistenceProvider().setActiveId(null)
}

/** Delete a document, and close it first if it's the one on screen. */
export async function deleteDocument(id: string): Promise<void> {
  if (activeDocumentId.peek() === id) activeDocumentId.value = null
  await getPersistenceProvider().remove(id)
}

/**
 * The document to offer as "Continue" on the documents screen: the one last
 * opened, falling back to the most recently edited. Null when the library is
 * empty or the last-opened document has since been deleted.
 *
 * This is all that remains of the old boot heuristic. Deciding *what is open* is
 * the URL's job now (see ../routing/route.ts); this only decides what to suggest.
 */
export async function continueCandidate(): Promise<DocumentSummary | null> {
  const provider = getPersistenceProvider()
  if (!provider.canPersist) return null
  const documents = await provider.list()
  if (!documents.length) return null
  const lastId = await provider.getActiveId()
  return documents.find((d) => d.id === lastId) ?? documents[0]!
}
