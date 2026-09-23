/**
 * document-session — which document is open in the editor, and the verbs that
 * keep the editor, the store and the persister in step.
 *
 * Opening loads the document's head from the store and attaches the persister
 * to it, so every later edit commits there. Leaving a document writes what is
 * pending first. `documentModel.loadRecords` clears undo history, so an undo
 * can never reach back into a document you've left.
 *
 * `activeDocumentId` is a signal rather than React state because it is read
 * from outside React (the persister) and by the documents/canvas view switch.
 */

import { signal } from '@preact/signals-core'
import {
  add,
  commitChanges,
  del,
  importDocument,
  meta,
  type Change,
  type Kind,
} from '../doc'
import type { CommitInfo } from '../doc/commits'
import { encode, splitKey } from '../doc/commits'
import { createNewDocument } from '../page-crud'
import { documentModel } from '../renderer/store/document-model'
import { summarizeImported, type DocumentSummary } from './document-summary'
import { startPersister, type Persister } from './persister'
import { getPersistenceProvider } from './provider'
import { entriesOfImported, importedOfEntries, liveEntries, META_KEY, recordKey } from './records'

/** Id of the document loaded in the editor, or null when none is open. */
export const activeDocumentId = signal<string | null>(null)

let persister: Persister | null = null

/** The persister writing the open document. Started on first use. */
export function sessionPersister(): Persister {
  return (persister ??= startPersister(getPersistenceProvider()))
}

/** Tests: stop the persister so the next session starts a fresh one. */
export function resetSessionForTests(): void {
  persister?.dispose()
  persister = null
  activeDocumentId.value = null
}

/**
 * Load a stored document into the editor. Returns false when the id is gone
 * or unreadable, leaving the current document alone — a dead link on the
 * documents screen shouldn't blank the canvas.
 */
export async function openDocument(id: string): Promise<boolean> {
  const store = getPersistenceProvider()
  const p = sessionPersister()
  await p.detach()
  const entries = await store.open(id)
  if (!entries) return false
  activeDocumentId.value = id
  await store.setActiveId(id)
  await documentModel.loadRecords(importedOfEntries(entries))
  p.attach(id)
  return true
}

/**
 * Add a blank document to the library. It is deliberately *not* opened here —
 * callers navigate to its id and the route effect loads it, so there is
 * exactly one path into a document.
 */
export async function createDocument(): Promise<DocumentSummary> {
  const im = importDocument(createNewDocument())
  return getPersistenceProvider().create(entriesOfImported(im), summarizeImported(im))
}

/** Leave the open document, writing what is pending first. The canvas keeps its last contents. */
export async function closeDocument(): Promise<void> {
  await sessionPersister().detach()
  activeDocumentId.value = null
  await getPersistenceProvider().setActiveId(null)
}

/** Delete a document, and close it first if it's the one on screen. */
export async function deleteDocument(id: string): Promise<void> {
  if (sessionPersister().documentId() === id) await closeDocument()
  await getPersistenceProvider().remove(id)
}

/** Rename a document. The editor's copy follows when it holds that document. */
export async function renameDocument(id: string, name: string): Promise<void> {
  const p = sessionPersister()
  const loaded = p.documentId() === id
  if (loaded) await p.flush()
  await getPersistenceProvider().rename(id, name)
  const m = meta.peek()
  if (loaded && m) meta.value = { ...m, name }
}

/** The open document's commits, newest first. */
export async function documentLog(limit?: number): Promise<CommitInfo[]> {
  const id = activeDocumentId.peek()
  return id ? getPersistenceProvider().log(id, limit) : []
}

/** The open document's commits that changed one record, newest first. */
export async function recordHistory(kind: Kind, recordId: string): Promise<CommitInfo[]> {
  const id = activeDocumentId.peek()
  return id ? getPersistenceProvider().historyOf(id, recordKey(kind, recordId)) : []
}

/**
 * Bring the open document back to its state at `commit`, as one ordinary
 * edit: it gets an undo frame, and a new commit on top of the history.
 * Returns false when the commit is unknown.
 */
export async function checkout(commit: string): Promise<boolean> {
  const id = activeDocumentId.peek()
  if (!id) return false
  await sessionPersister().flush()
  const target = await getPersistenceProvider().stateAt(id, commit)
  if (!target) return false
  const now = new Map(liveEntries().map((e) => [e.key, e.bytes]))
  const wanted = new Map(target.map((e) => [e.key, e.bytes]))
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
  const removes: Change[] = []
  const adds: Change[] = []
  for (const key of now.keys()) {
    if (key === META_KEY || wanted.has(key)) continue
    const [kind, rid] = splitKey(key)
    removes.push(del(kind as Kind, rid) as Change)
  }
  const im = importedOfEntries(target)
  const records = [
    ...im.pages.map((r) => ['page', r] as const),
    ...im.nodes.map((r) => ['node', r] as const),
    ...Object.entries(im.records).flatMap(([kind, rs]) => (rs ?? []).map((r) => [kind as Kind, r] as const)),
  ]
  for (const [kind, r] of records) {
    const key = recordKey(kind, (r as { id: string }).id)
    const before = now.get(key)
    if (!before || !same(before, encode(r))) adds.push(add(kind, r as never) as Change)
  }
  const m = meta.peek()
  const metaChanged = m && wanted.has(META_KEY) && !same(now.get(META_KEY) ?? new Uint8Array(), wanted.get(META_KEY)!)
  await commitChanges({
    changes: [...removes, ...adds],
    docMeta: metaChanged ? [{ type: 'replace-meta', meta: im.meta }] : [],
    docMetaUndo: metaChanged ? [{ type: 'replace-meta', meta: m }] : [],
    label: 'checkout',
  })
  return true
}

/**
 * The document to offer as "Continue" on the documents screen: the one last
 * opened, falling back to the most recently edited. Null when the library is
 * empty or the last-opened document has since been deleted.
 */
export async function continueCandidate(): Promise<DocumentSummary | null> {
  const store = getPersistenceProvider()
  if (!store.canPersist) return null
  const documents = await store.list()
  if (!documents.length) return null
  const lastId = await store.getActiveId()
  return documents.find((d) => d.id === lastId) ?? documents[0]!
}
