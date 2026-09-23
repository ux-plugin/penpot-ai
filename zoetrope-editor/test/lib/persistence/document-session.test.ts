/**
 * The session keeps the store, the editor and the persister in step: opening
 * loads a document's head and attaches the persister, edits become commits,
 * reopening reads them back.
 *
 * "Which document is open" is recorded before the document is handed to the
 * canvas, so a renderer that fails to load it leaves the store pointing at the
 * document the user asked for and a reload retries it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {
  add,
  beginGroup,
  commitChanges,
  del,
  endGroup,
  getNode,
  meta,
  mod,
  pagesInOrder,
  undo,
  type Node,
} from '../../../src/lib/doc'
import { resetSubscribers } from '../../../src/lib/doc/commit'
import { StoreBackend } from '../../../src/lib/persistence/store-backend'
import { memoryDatabases } from '../../../src/lib/persistence/memory-databases'
import { NoneDocumentStore } from '../../../src/lib/persistence/document-store'
import { setPersistenceProviderForTests } from '../../../src/lib/persistence/provider'
import {
  activeDocumentId,
  checkout,
  closeDocument,
  continueCandidate,
  createDocument,
  deleteDocument,
  documentLog,
  openDocument,
  recordHistory,
  renameDocument,
  resetSessionForTests,
  sessionPersister,
} from '../../../src/lib/persistence/document-session'
import { documentModel } from '../../../src/lib/renderer/store/document-model'
import { resetWorkspace } from '../fixtures'

const sqlite3 = await sqlite3InitModule()

let store: StoreBackend
let clock = 0

beforeEach(() => {
  resetWorkspace()
  resetSubscribers()
  resetSessionForTests()
  clock = 0
  store = new StoreBackend(memoryDatabases(sqlite3), () => ++clock)
  setPersistenceProviderForTests(store)
})

afterEach(() => {
  resetSessionForTests()
  setPersistenceProviderForTests(null)
})

const rect = (id: string, page: string, order = 'a0'): Node => ({ id, page, order, type: 'rect', name: id, x: 0, y: 0, width: 10, height: 10 }) as unknown as Node

async function openNew(): Promise<{ id: string; page: string }> {
  const doc = await createDocument()
  expect(await openDocument(doc.id)).toBe(true)
  return { id: doc.id, page: pagesInOrder()[0].id }
}

describe('open and create', () => {
  it('creates a document without opening it — the route is the only way in', async () => {
    const doc = await createDocument()
    expect(activeDocumentId.value).toBeNull()
    expect((await store.list()).map((d) => d.id)).toEqual([doc.id])
    expect(doc.pages).toHaveLength(1)
  })

  it('records the open document before handing it to the canvas, even when the canvas fails', async () => {
    const doc = await createDocument()
    const spy = vi.spyOn(documentModel, 'loadRecords').mockRejectedValueOnce(new Error('no surface'))
    await expect(openDocument(doc.id)).rejects.toThrow('no surface')
    expect(activeDocumentId.value).toBe(doc.id)
    expect(await store.getActiveId()).toBe(doc.id)
    spy.mockRestore()
  })

  it('leaves the current document alone when the id is gone', async () => {
    const { page } = await openNew()
    expect(await openDocument('missing')).toBe(false)
    expect(pagesInOrder()[0].id).toBe(page)
  })
})

describe('edits become commits', () => {
  it('an edit is written to the store and read back on reopen', async () => {
    const { id, page } = await openNew()
    await commitChanges({ changes: [add('node', rect('r1', page))], label: 'add rect' })
    await commitChanges({ changes: [mod('node', 'r1', { name: 'Box' })] })
    await sessionPersister().flush()
    resetWorkspace()
    expect(await openDocument(id)).toBe(true)
    expect(getNode('r1')?.name).toBe('Box')
    expect((await documentLog()).map((c) => c.label)).toEqual(['add rect', 'create'])
  })

  it('a group is one commit, written when it closes', async () => {
    const { page } = await openNew()
    await commitChanges({ changes: [add('node', rect('r1', page))] })
    await sessionPersister().flush()
    const before = (await documentLog()).length
    beginGroup('drag')
    for (let x = 1; x <= 20; x++) await commitChanges({ changes: [mod('node', 'r1', { x } as Partial<Node>)] })
    endGroup('drag')
    await new Promise((r) => setTimeout(r, 250))
    await sessionPersister().flush()
    const log = await documentLog()
    expect(log.length).toBe(before + 1)
    expect((await recordHistory('node', 'r1')).length).toBe(2)
  })

  it('undo is an edit too: it commits the state it restores', async () => {
    const { id, page } = await openNew()
    await commitChanges({ changes: [add('node', rect('r1', page))] })
    await undo()
    await sessionPersister().flush()
    resetWorkspace()
    await openDocument(id)
    expect(getNode('r1')).toBeUndefined()
  })

  it('a whole-document swap (a seed) writes every record, so the store never mixes two documents', async () => {
    const { id } = await openNew()
    await documentModel.loadDocument({
      name: 'Seeded',
      components: {},
      children: [{ id: 'seed-page', name: 'Seed', children: [{ id: 's1', type: 'rect', name: 's1', x: 0, y: 0, width: 1, height: 1 }] }],
    } as never)
    await sessionPersister().flush()
    resetWorkspace()
    await openDocument(id)
    expect(pagesInOrder().map((p) => p.id)).toEqual(['seed-page'])
    expect(getNode('s1')).toBeDefined()
  })

  it('checkout brings an earlier state back as one undoable edit', async () => {
    const { page } = await openNew()
    await commitChanges({ changes: [add('node', rect('r1', page))], label: 'one' })
    await sessionPersister().flush()
    const [one] = await documentLog()
    await commitChanges({ changes: [mod('node', 'r1', { name: 'changed' }), add('node', rect('r2', page, 'a1'))] })
    await commitChanges({ changes: [del('node', 'r1')] })
    await sessionPersister().flush()
    expect(await checkout(one.id)).toBe(true)
    expect(getNode('r1')?.name).toBe('r1')
    expect(getNode('r2')).toBeUndefined()
    await undo()
    expect(getNode('r1')).toBeUndefined()
    expect(getNode('r2')).toBeDefined()
  })
})

describe('library verbs', () => {
  it('renaming the open document renames the editor copy and later commits keep the name', async () => {
    const { id, page } = await openNew()
    await renameDocument(id, 'Named')
    await commitChanges({ changes: [add('node', rect('r1', page))], docMeta: [{ type: 'set-active-themes', activeThemes: [] } as never] })
    await sessionPersister().flush()
    expect((await store.list())[0].name).toBe('Named')
    resetWorkspace()
    await openDocument(id)
    expect(meta.peek()?.name).toBe('Named')
  })

  it('deleting the open document closes it; deleting another does not', async () => {
    const other = await createDocument()
    const { id } = await openNew()
    await deleteDocument(other.id)
    expect(activeDocumentId.value).toBe(id)
    await deleteDocument(id)
    expect(activeDocumentId.value).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('closing clears the signal and the stored pointer', async () => {
    await openNew()
    await closeDocument()
    expect(activeDocumentId.value).toBeNull()
    expect(await store.getActiveId()).toBeNull()
  })

  it('offers the last-opened document to continue into, else the newest, else nothing', async () => {
    expect(await continueCandidate()).toBeNull()
    const a = await createDocument()
    const b = await createDocument()
    expect((await continueCandidate())?.id).toBe(b.id)
    await openDocument(a.id)
    expect((await continueCandidate())?.id).toBe(a.id)
    setPersistenceProviderForTests(new NoneDocumentStore())
    expect(await continueCandidate()).toBeNull()
  })
})
