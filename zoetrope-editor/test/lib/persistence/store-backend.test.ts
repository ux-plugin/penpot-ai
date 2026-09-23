import { beforeEach, describe, expect, it } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { decode, encode, type StoredEntry } from '../../../src/lib/doc/commits'
import { StoreBackend } from '../../../src/lib/persistence/store-backend'
import { memoryDatabases } from '../../../src/lib/persistence/memory-databases'
import type { DerivedSummary } from '../../../src/lib/persistence/document-summary'

const sqlite3 = await sqlite3InitModule()

let clock = 0
let seq = 0
const summary = (name: string, pages = 1): DerivedSummary => ({
  name,
  pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, name: `Page ${i + 1}`, boardCount: i })),
})
const entry = (key: string, value: unknown): StoredEntry => ({ key, bytes: encode(value) })
const docEntries = (name: string): StoredEntry[] => [
  entry('meta/document', { name, components: {} }),
  entry('page/p0', { id: 'p0', order: 'a0', name: 'Page 1' }),
  entry('node/n1', { id: 'n1', page: 'p0', order: 'a0', type: 'rect' }),
]

let store: StoreBackend

beforeEach(() => {
  clock = 1000
  seq = 0
  store = new StoreBackend(memoryDatabases(sqlite3), () => ++clock, () => `id-${++seq}`)
})

const nameOf = async (id: string) =>
  decode<{ name: string }>((await store.open(id))!.find((e) => e.key === 'meta/document')!.bytes).name

describe('library', () => {
  it('creates documents under distinct ids and lists them newest first', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    const b = await store.create(docEntries('B'), summary('B', 2))
    expect(a.id).not.toBe(b.id)
    expect((await store.list()).map((d) => d.name)).toEqual(['B', 'A'])
    expect((await store.list())[0].pages).toEqual(summary('B', 2).pages)
  })

  it('a commit refreshes the entry and moves it to the top; createdAt stays', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    await store.create(docEntries('B'), summary('B'))
    await store.commit(a.id, { puts: [entry('node/n2', { id: 'n2' })], summary: summary('A', 3) })
    const [top] = await store.list()
    expect(top.id).toBe(a.id)
    expect(top.createdAt).toBe(a.createdAt)
    expect(top.updatedAt).toBeGreaterThan(a.updatedAt)
    expect(top.pages).toHaveLength(3)
  })

  it('archive and project survive commits; archiving does not bump updatedAt', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    const p = await store.createProject('Work')
    await store.setArchived(a.id, true)
    await store.setProject(a.id, p.id)
    expect((await store.list())[0]).toMatchObject({ archived: true, projectId: p.id, updatedAt: a.updatedAt })
    await store.commit(a.id, { puts: [entry('node/n2', { id: 'n2' })], summary: summary('A') })
    expect((await store.list())[0]).toMatchObject({ archived: true, projectId: p.id })
    await store.setArchived(a.id, false)
    expect((await store.list())[0].archived).toBeUndefined()
  })

  it('lists projects by name, renames them, and deleting one unfiles its documents', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    const z = await store.createProject('Zeta')
    const b = await store.createProject('Beta')
    await store.setProject(a.id, z.id)
    await store.renameProject(b.id, 'Alpha')
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['Alpha', 'Zeta'])
    await store.deleteProject(z.id)
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['Alpha'])
    expect((await store.list())[0].projectId).toBeUndefined()
  })

  it('rename changes the entry and the stored document', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    await store.rename(a.id, 'Renamed')
    expect((await store.list())[0].name).toBe('Renamed')
    expect(await nameOf(a.id)).toBe('Renamed')
    await store.rename('missing', 'X')
    expect(await store.list()).toHaveLength(1)
  })

  it('duplicate copies content and history under a new id', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    await store.commit(a.id, { puts: [entry('node/n2', { id: 'n2' })], summary: summary('A') })
    const copy = (await store.duplicate(a.id))!
    expect(copy.name).toBe('A copy')
    expect(await nameOf(copy.id)).toBe('A copy')
    expect((await store.open(copy.id))!.map((e) => e.key).sort()).toEqual((await store.open(a.id))!.map((e) => e.key).sort())
    expect((await store.log(copy.id)).length).toBe((await store.log(a.id)).length + 1)
    expect(await nameOf(a.id)).toBe('A')
    expect(await store.duplicate('missing')).toBeNull()
  })

  it('remove drops the document, its entry, and the active pointer if it was active', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    const b = await store.create(docEntries('B'), summary('B'))
    await store.setActiveId(a.id)
    await store.remove(b.id)
    expect(await store.getActiveId()).toBe(a.id)
    await store.remove(a.id)
    expect(await store.list()).toEqual([])
    expect(await store.getActiveId()).toBeNull()
    expect(await store.open(a.id)).toBeNull()
  })

  it('round-trips the active id and clears it on null', async () => {
    await store.setActiveId('x')
    expect(await store.getActiveId()).toBe('x')
    await store.setActiveId(null)
    expect(await store.getActiveId()).toBeNull()
  })
})

describe('history', () => {
  it('commits only what changed, skips a commit that changes nothing, and reads any state back', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    const first = (await store.log(a.id))[0]
    const second = await store.commit(a.id, { puts: [entry('node/n1', { id: 'n1', page: 'p0', order: 'a0', type: 'circle' })], label: 'shape', summary: summary('A') })
    expect(second?.parent).toBe(first.id)
    expect(await store.commit(a.id, { puts: [entry('node/n1', { id: 'n1', page: 'p0', order: 'a0', type: 'circle' })], summary: summary('A') })).toBeNull()
    await store.commit(a.id, { puts: [{ key: 'node/n1', bytes: null }], label: 'delete', summary: summary('A') })
    expect((await store.open(a.id))!.map((e) => e.key).sort()).toEqual(['meta/document', 'page/p0'])
    const past = (await store.stateAt(a.id, second!.id))!
    expect(decode<{ type: string }>(past.find((e) => e.key === 'node/n1')!.bytes).type).toBe('circle')
    expect((await store.log(a.id)).map((c) => c.label)).toEqual(['delete', 'shape', 'create'])
    expect((await store.historyOf(a.id, 'node/n1')).map((c) => c.label)).toEqual(['delete', 'shape', 'create'])
    expect((await store.historyOf(a.id, 'page/p0')).map((c) => c.label)).toEqual(['create'])
  })

  it('a full commit replaces the state: keys it leaves out are removed', async () => {
    const a = await store.create(docEntries('A'), summary('A'))
    await store.commit(a.id, { puts: [entry('meta/document', { name: 'A' }), entry('page/q', { id: 'q' })], full: true, summary: summary('A') })
    expect((await store.open(a.id))!.map((e) => e.key).sort()).toEqual(['meta/document', 'page/q'])
  })
})
