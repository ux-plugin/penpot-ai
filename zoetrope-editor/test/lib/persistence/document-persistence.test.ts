/**
 * Capability-gated document persistence: envelope encode/decode, the KV-backed
 * provider's library operations (create / list / save / rename / duplicate /
 * remove / active id), one-way adoption of the pre-library `current` key, failure
 * degradation, the None provider, and the environment probe. Storage is an
 * in-memory KvStore (the test env is node, so there's no IndexedDB) — the
 * IndexedDB adapter is the only untested seam and is a thin wrapper over the same
 * KvStore contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PenpotDocument } from 'penpot-exporter/types'
import type { KvStore } from '../../../src/lib/persistence/document-persistence'
import {
  KvDocumentProvider,
  NonePersistenceProvider,
  decodeDocument,
  encodeDocument,
  selectPersistenceProvider,
} from '../../../src/lib/persistence/document-persistence'

function memKv(): KvStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async get(k) {
      return map.has(k) ? map.get(k)! : null
    },
    async keys() {
      return [...map.keys()]
    },
    async set(k, v) {
      map.set(k, v)
    },
    async delete(k) {
      map.delete(k)
    },
  }
}

/** A tiny document whose node carries a scene3d blob, to prove 3D survives. */
function sampleDoc(name = 'Test'): PenpotDocument {
  return {
    name,
    children: [
      {
        id: 'p1',
        name: 'Page 1',
        children: [
          {
            id: '00000000-0000-0000-0000-000000000000',
            type: 'frame',
            name: 'Root',
            children: [
              {
                id: 'rect-1',
                type: 'rect',
                name: '3D object',
                scene3d: { material: { color: '#8a8de0' }, transform3d: { position: [1, 2, 3] } },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PenpotDocument
}

/** A provider with deterministic ids and a clock the test drives, so recency
 *  ordering and createdAt/updatedAt are assertable. */
function libraryProvider(kv = memKv()) {
  let clock = 1000
  let seq = 0
  const provider = new KvDocumentProvider(
    kv,
    'indexeddb',
    () => clock,
    () => `id-${++seq}`,
  )
  return { provider, kv, tick: (by = 1) => (clock += by) }
}

describe('document persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('encode/decode round-trips the document (incl. node.scene3d)', () => {
    const doc = sampleDoc()
    const decoded = decodeDocument(encodeDocument(doc, 123))
    expect(decoded).toEqual(doc)
  })

  it('decodeDocument returns null for absent / corrupt / wrong-version data', () => {
    expect(decodeDocument(null)).toBeNull()
    expect(decodeDocument('not json {')).toBeNull()
    expect(decodeDocument(JSON.stringify({ version: 999, doc: sampleDoc() }))).toBeNull()
    expect(decodeDocument(JSON.stringify({ version: 1 }))).toBeNull() // no doc
  })

  it('creates documents under distinct ids and lists them newest first', async () => {
    const { provider, kv, tick } = libraryProvider()
    expect(await provider.list()).toEqual([])

    const first = await provider.create(sampleDoc('First'))
    tick()
    const second = await provider.create(sampleDoc('Second'))

    expect(first.id).not.toBe(second.id)
    expect(await provider.list()).toMatchObject([
      { id: second.id, name: 'Second' },
      { id: first.id, name: 'First' },
    ])
    // Each document is its own key; the index is separate from the documents.
    expect(kv.map.has(`doc:${first.id}`)).toBe(true)
    expect(kv.map.has(`doc:${second.id}`)).toBe(true)
    expect(JSON.parse(kv.map.get('doc:id-1')!)).toMatchObject({ version: 2, savedAt: 1000 })
  })

  it('summarizes per-page detail into the index entry', async () => {
    const { provider } = libraryProvider()
    const summary = await provider.create(sampleDoc())
    expect(summary).toMatchObject({
      pages: [{ id: 'p1', name: 'Page 1', boardCount: 0 }],
      createdAt: 1000,
      updatedAt: 1000,
    })
  })

  it('rebuilds a stale-version index from the stored documents', async () => {
    const { provider, kv } = libraryProvider()
    const a = await provider.create(sampleDoc('Alpha'))
    await provider.create(sampleDoc('Beta'))

    // An index written by an older summary shape.
    kv.map.set('index', JSON.stringify({ version: 1, documents: [{ id: a.id, name: 'Stale' }] }))

    const rebuilt = await provider.list()
    expect(rebuilt.map((d) => d.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(rebuilt.every((d) => Array.isArray(d.pages))).toBe(true)
    // Rebuilt once and persisted, not re-derived on every read.
    expect(JSON.parse(kv.map.get('index')!).version).toBe(4)
  })

  it('rebuilds when entries are old-shaped even if the version looks current', async () => {
    const { provider, kv } = libraryProvider()
    const a = await provider.create(sampleDoc('Alpha'))

    // The trap: a version someone forgot to bump, carrying pre-`pages` entries.
    // Filtering these out silently would report an empty library.
    kv.map.set(
      'index',
      JSON.stringify({
        version: 4,
        documents: [{ id: a.id, name: 'Alpha', pageCount: 1, boardCount: 0 }],
      }),
    )

    const listed = await provider.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.pages).toEqual([{ id: 'p1', name: 'Page 1', boardCount: 0 }])
  })

  it('rebuilds rather than reporting an empty library when the index is corrupt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { provider, kv } = libraryProvider()
    await provider.create(sampleDoc('Survivor'))
    kv.map.set('index', 'not json {')

    const listed = await provider.list()
    expect(listed).toMatchObject([{ name: 'Survivor' }])
    expect(listed[0]!.pages).toHaveLength(1)
  })

  it('rebuild skips documents whose envelope cannot be decoded', async () => {
    const { provider, kv } = libraryProvider()
    await provider.create(sampleDoc('Good'))
    kv.map.set('doc:broken', 'not json {')
    kv.map.delete('index')

    expect((await provider.list()).map((d) => d.name)).toEqual(['Good'])
  })

  it('save keeps createdAt, refreshes updatedAt, and re-derives the entry', async () => {
    const { provider, tick } = libraryProvider()
    const { id } = await provider.create(sampleDoc('Before'))
    tick(50)

    await provider.save(id, sampleDoc('After'))

    const [entry] = await provider.list()
    expect(entry).toMatchObject({ id, name: 'After', createdAt: 1000, updatedAt: 1050 })
    expect(await provider.load(id)).toEqual(sampleDoc('After'))
  })

  it('save moves a document to the top of the list', async () => {
    const { provider, tick } = libraryProvider()
    const first = await provider.create(sampleDoc('First'))
    tick()
    await provider.create(sampleDoc('Second'))
    tick()

    await provider.save(first.id, sampleDoc('First'))

    expect((await provider.list())[0]!.id).toBe(first.id)
  })

  it('archives and unarchives without touching the stored document', async () => {
    const { provider } = libraryProvider()
    const { id } = await provider.create(sampleDoc('Filed away'))

    await provider.setArchived(id, true)
    expect((await provider.list())[0]).toMatchObject({ id, archived: true })
    expect(await provider.load(id)).toEqual(sampleDoc('Filed away'))

    await provider.setArchived(id, false)
    expect((await provider.list())[0]!.archived).toBeUndefined()
  })

  it('archiving does not bump updatedAt', async () => {
    const { provider, tick } = libraryProvider()
    const { id } = await provider.create(sampleDoc())
    tick(500)

    await provider.setArchived(id, true)

    // Archiving isn't an edit; bumping recency would shuffle the document to the
    // top of a list on its way out of that list.
    expect((await provider.list())[0]!.updatedAt).toBe(1000)
  })

  it('keeps archive and project across a save — autosave must not undo them', async () => {
    const { provider } = libraryProvider()
    const { id } = await provider.create(sampleDoc('Doc'))
    const project = await provider.createProject('Kestrel')
    await provider.setProject(id, project.id)
    await provider.setArchived(id, true)

    // `summarize` knows nothing about filing or archiving, so a plain save is
    // exactly where those would get dropped.
    await provider.save(id, sampleDoc('Doc edited'))

    expect((await provider.list())[0]).toMatchObject({
      name: 'Doc edited',
      archived: true,
      projectId: project.id,
    })
  })

  it('files and unfiles documents into projects', async () => {
    const { provider } = libraryProvider()
    const { id } = await provider.create(sampleDoc())
    const project = await provider.createProject('Marketing')

    await provider.setProject(id, project.id)
    expect((await provider.list())[0]!.projectId).toBe(project.id)

    await provider.setProject(id, null)
    expect((await provider.list())[0]!.projectId).toBeUndefined()
  })

  it('lists projects by name and renames them', async () => {
    const { provider } = libraryProvider()
    const zed = await provider.createProject('Zed')
    await provider.createProject('Alpha')

    expect((await provider.listProjects()).map((p) => p.name)).toEqual(['Alpha', 'Zed'])

    await provider.renameProject(zed.id, 'Aardvark')
    expect((await provider.listProjects()).map((p) => p.name)).toEqual(['Aardvark', 'Alpha'])
  })

  it('deleting a project keeps its documents, unfiled', async () => {
    const { provider } = libraryProvider()
    const kept = await provider.create(sampleDoc('Kept'))
    const project = await provider.createProject('Doomed')
    await provider.setProject(kept.id, project.id)

    await provider.deleteProject(project.id)

    expect(await provider.listProjects()).toEqual([])
    const [doc] = await provider.list()
    expect(doc).toMatchObject({ id: kept.id, name: 'Kept' })
    expect(doc!.projectId).toBeUndefined()
  })

  it('rename patches the index entry and the stored document', async () => {
    const { provider } = libraryProvider()
    const { id } = await provider.create(sampleDoc('Old name'))

    await provider.rename(id, 'New name')

    expect((await provider.list())[0]).toMatchObject({ id, name: 'New name' })
    expect((await provider.load(id))!.name).toBe('New name')
  })

  it('rename of an unknown id is a no-op', async () => {
    const { provider } = libraryProvider()
    await provider.create(sampleDoc('Kept'))
    await provider.rename('nope', 'Changed')
    expect((await provider.list())[0]).toMatchObject({ name: 'Kept' })
  })

  it('duplicate copies content under a new id and leaves the source alone', async () => {
    const { provider } = libraryProvider()
    const source = await provider.create(sampleDoc('Original'))

    const copy = await provider.duplicate(source.id)

    expect(copy!.id).not.toBe(source.id)
    expect(copy!.name).toBe('Original copy')
    expect(await provider.load(copy!.id)).toEqual({ ...sampleDoc('Original copy') })
    expect(await provider.load(source.id)).toEqual(sampleDoc('Original'))
    expect(await provider.list()).toHaveLength(2)
  })

  it('duplicate of a missing document returns null', async () => {
    const { provider } = libraryProvider()
    expect(await provider.duplicate('nope')).toBeNull()
  })

  it('remove drops the document, its index entry, and the active pointer', async () => {
    const { provider, kv } = libraryProvider()
    const { id } = await provider.create(sampleDoc())
    await provider.setActiveId(id)

    await provider.remove(id)

    expect(await provider.list()).toEqual([])
    expect(await provider.load(id)).toBeNull()
    expect(kv.map.has(`doc:${id}`)).toBe(false)
    expect(await provider.getActiveId()).toBeNull()
  })

  it('remove leaves an unrelated active pointer intact', async () => {
    const { provider } = libraryProvider()
    const keep = await provider.create(sampleDoc('Keep'))
    const drop = await provider.create(sampleDoc('Drop'))
    await provider.setActiveId(keep.id)

    await provider.remove(drop.id)

    expect(await provider.getActiveId()).toBe(keep.id)
  })

  it('round-trips the active id and clears it on null', async () => {
    const { provider } = libraryProvider()
    expect(await provider.getActiveId()).toBeNull()
    await provider.setActiveId('id-7')
    expect(await provider.getActiveId()).toBe('id-7')
    await provider.setActiveId(null)
    expect(await provider.getActiveId()).toBeNull()
  })

  it('concurrent saves both land in the index', async () => {
    const { provider } = libraryProvider()
    const a = await provider.create(sampleDoc('A'))
    const b = await provider.create(sampleDoc('B'))

    // Read-modify-write of the shared index, interleaved.
    await Promise.all([
      provider.save(a.id, sampleDoc('A2')),
      provider.save(b.id, sampleDoc('B2')),
    ])

    const names = (await provider.list()).map((d) => d.name).sort()
    expect(names).toEqual(['A2', 'B2'])
  })

  it('adopts a pre-library `current` document exactly once', async () => {
    const kv = memKv()
    kv.map.set('current', encodeDocument(sampleDoc('Legacy work'), 5))
    const { provider } = libraryProvider(kv)

    const listed = await provider.list()
    expect(listed).toMatchObject([{ name: 'Legacy work' }])
    expect(await provider.load(listed[0]!.id)).toEqual(sampleDoc('Legacy work'))
    // The legacy key is gone, which is what makes adoption idempotent.
    expect(kv.map.has('current')).toBe(false)
    expect(await provider.list()).toHaveLength(1)
  })

  it('does not adopt `current` when a library already exists', async () => {
    const { provider, kv } = libraryProvider()
    await provider.create(sampleDoc('Real'))
    kv.map.set('current', encodeDocument(sampleDoc('Stale'), 5))

    expect(await provider.list()).toHaveLength(1)
    expect(kv.map.get('current')).toBeTruthy()
  })

  it('degrades (no throw) when the KV store fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: KvStore = {
      get: async () => {
        throw new Error('boom')
      },
      keys: async () => {
        throw new Error('boom')
      },
      set: async () => {
        throw new Error('boom')
      },
      delete: async () => {
        throw new Error('boom')
      },
    }
    const provider = new KvDocumentProvider(failing)
    await expect(provider.list()).resolves.toEqual([])
    await expect(provider.load('x')).resolves.toBeNull()
    await expect(provider.save('x', sampleDoc())).resolves.toBeUndefined()
    await expect(provider.rename('x', 'y')).resolves.toBeUndefined()
    await expect(provider.remove('x')).resolves.toBeUndefined()
    await expect(provider.getActiveId()).resolves.toBeNull()
    await expect(provider.setActiveId('x')).resolves.toBeUndefined()
    // create still hands back a usable id so the session can open in memory.
    await expect(provider.create(sampleDoc())).resolves.toMatchObject({ name: 'Test' })
  })

  it('NonePersistenceProvider never persists', async () => {
    const provider = new NonePersistenceProvider()
    expect(provider.id).toBe('none')
    expect(provider.canPersist).toBe(false)
    expect(await provider.list()).toEqual([])
    expect(await provider.load('x')).toBeNull()
    await expect(provider.save('x', sampleDoc())).resolves.toBeUndefined()
    expect(await provider.getActiveId()).toBeNull()
    // create answers so the app can still run one unsaved document.
    expect(await provider.create(sampleDoc())).toMatchObject({ name: 'Test' })
  })

  it('selectPersistenceProvider picks None without IndexedDB and IndexedDB-backed with it', () => {
    const makeKv = vi.fn(() => memKv())

    // Node test env: no indexedDB → None.
    expect(selectPersistenceProvider(makeKv).id).toBe('none')
    expect(makeKv).not.toHaveBeenCalled()

    // Simulate a browser with IndexedDB present.
    const g = globalThis as { indexedDB?: unknown }
    const had = 'indexedDB' in g
    g.indexedDB = {}
    try {
      const provider = selectPersistenceProvider(makeKv)
      expect(provider.id).toBe('indexeddb')
      expect(provider.canPersist).toBe(true)
      expect(makeKv).toHaveBeenCalledWith('zoetrope-editor', 'documents')
    } finally {
      if (!had) delete g.indexedDB
    }
  })
})
