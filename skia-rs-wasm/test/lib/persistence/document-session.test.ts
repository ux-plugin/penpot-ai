/**
 * The session verbs keep three things in step: the store's `active` key, the
 * `activeDocumentId` signal, and the document loaded into the canvas.
 *
 * The load-order assertion is the point of this file. "Which document is open" is
 * a session fact, not a rendering outcome, so it must be recorded *before* the
 * document is handed to the canvas — otherwise a renderer that fails to create a
 * surface leaves the store pointing at the wrong document (or none), and the next
 * reload silently lands somewhere else. This was a real failure, not a
 * hypothetical: it showed up the moment the app ran in a browser without WebGL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotDocument } from 'penpot-exporter/types'
import type { DocumentPersistenceProvider } from '../../../src/lib/persistence/document-persistence'

const setDocument = vi.fn(async () => {})
const createNewDocument = vi.fn(() => ({ name: 'Untitled', children: [] }) as unknown as PenpotDocument)

vi.mock('../../../src/lib/page-crud', () => ({
  setDocument: (doc: PenpotDocument) => setDocument(doc),
  createNewDocument: () => createNewDocument(),
}))

const provider = {
  id: 'indexeddb' as const,
  canPersist: true,
  list: vi.fn(async () => [] as Awaited<ReturnType<DocumentPersistenceProvider['list']>>),
  load: vi.fn(async (_id: string) => null as PenpotDocument | null),
  save: vi.fn(async () => {}),
  create: vi.fn(async () => ({
    id: 'new-1',
    name: 'Untitled',
    pages: [{ id: 'p1', name: 'Page 1', boardCount: 0 }],
    createdAt: 0,
    updatedAt: 0,
  })),
  duplicate: vi.fn(async () => null),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  getActiveId: vi.fn(async () => null as string | null),
  setActiveId: vi.fn(async (_id: string | null) => {}),
}

vi.mock('../../../src/lib/persistence/provider', () => ({
  getPersistenceProvider: () => provider,
}))

const {
  activeDocumentId,
  closeDocument,
  continueCandidate,
  createDocument,
  deleteDocument,
  openDocument,
} = await import('../../../src/lib/persistence/document-session')

const summary = (id: string, updatedAt: number) => ({
  id,
  name: id,
  pages: [{ id: 'p1', name: 'Page 1', boardCount: 0 }],
  createdAt: 0,
  updatedAt,
})

const someDoc = () => ({ name: 'Stored', children: [] }) as unknown as PenpotDocument

describe('document session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeDocumentId.value = null
    provider.load.mockResolvedValue(null)
    provider.list.mockResolvedValue([])
    provider.getActiveId.mockResolvedValue(null)
  })

  it('records the open document before handing it to the canvas', async () => {
    const order: string[] = []
    provider.load.mockResolvedValue(someDoc())
    provider.setActiveId.mockImplementation(async () => void order.push('setActiveId'))
    setDocument.mockImplementation(async () => void order.push('setDocument'))

    await openDocument('doc-a')

    expect(order).toEqual(['setActiveId', 'setDocument'])
  })

  it('still points at the document when the canvas fails to load it', async () => {
    provider.load.mockResolvedValue(someDoc())
    setDocument.mockRejectedValueOnce(new Error('Failed to create surface'))

    await expect(openDocument('doc-a')).rejects.toThrow('Failed to create surface')

    expect(activeDocumentId.value).toBe('doc-a')
    expect(provider.setActiveId).toHaveBeenCalledWith('doc-a')
  })

  it('leaves the current document alone when the id is gone', async () => {
    activeDocumentId.value = 'doc-existing'
    provider.load.mockResolvedValue(null)

    expect(await openDocument('doc-missing')).toBe(false)
    expect(activeDocumentId.value).toBe('doc-existing')
    expect(setDocument).not.toHaveBeenCalled()
  })

  it('creates a document without opening it — the route is the only way in', async () => {
    const created = await createDocument()

    expect(created.id).toBe('new-1')
    // Opening here as well would load the document twice: once now, and again
    // when the caller navigates to its id and the route effect picks it up.
    expect(setDocument).not.toHaveBeenCalled()
    expect(activeDocumentId.value).toBeNull()
  })

  it('offers the last-opened document to continue into', async () => {
    provider.list.mockResolvedValue([summary('doc-new', 200), summary('doc-old', 100)])
    provider.getActiveId.mockResolvedValue('doc-old')

    expect((await continueCandidate())!.id).toBe('doc-old')
  })

  it('falls back to the most recently edited when nothing was opened', async () => {
    provider.list.mockResolvedValue([summary('doc-new', 200), summary('doc-old', 100)])

    expect((await continueCandidate())!.id).toBe('doc-new')
  })

  it('falls back past an active id whose document is gone', async () => {
    provider.list.mockResolvedValue([summary('doc-real', 100)])
    provider.getActiveId.mockResolvedValue('doc-deleted')

    expect((await continueCandidate())!.id).toBe('doc-real')
  })

  it('offers nothing when the library is empty or persistence is off', async () => {
    expect(await continueCandidate()).toBeNull()

    provider.list.mockResolvedValue([summary('doc-a', 1)])
    Object.defineProperty(provider, 'canPersist', { value: false, configurable: true })
    try {
      expect(await continueCandidate()).toBeNull()
    } finally {
      Object.defineProperty(provider, 'canPersist', { value: true, configurable: true })
    }
  })

  it('closing clears both the signal and the stored pointer', async () => {
    activeDocumentId.value = 'doc-a'
    await closeDocument()
    expect(activeDocumentId.value).toBeNull()
    expect(provider.setActiveId).toHaveBeenCalledWith(null)
  })

  it('deleting the open document closes it; deleting another does not', async () => {
    activeDocumentId.value = 'doc-a'
    await deleteDocument('doc-a')
    expect(activeDocumentId.value).toBeNull()
    expect(provider.remove).toHaveBeenCalledWith('doc-a')

    activeDocumentId.value = 'doc-b'
    await deleteDocument('doc-other')
    expect(activeDocumentId.value).toBe('doc-b')
  })
})
