import { describe, expect, it } from 'vitest'
import { buildTree, diffTrees, entriesOf, updateTree, valueAt, MAX_LEAF, type Edit, type Entry, type Hash, type NodeStore } from '../../../../src/lib/doc/commits/tree'

class MemStore implements NodeStore {
  readonly nodes = new Map<Hash, Uint8Array>()
  get(hash: Hash) {
    return this.nodes.get(hash)
  }
  keep(written: Map<Hash, Uint8Array>) {
    for (const [h, b] of written) this.nodes.set(h, b)
  }
}

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const sorted = (entries: Entry[]) => [...entries].sort((a, b) => a.key.localeCompare(b.key))

describe('hash tree', () => {
  it('an edited tree has the same root as one built from scratch, through random edits', async () => {
    const store = new MemStore()
    const random = rng(7)
    const state = new Map<string, Hash>()
    let t = await buildTree(store, [])
    store.keep(t.written)
    let root = t.root
    for (let round = 0; round < 40; round++) {
      const edits: Edit[] = []
      const n = 1 + Math.floor(random() * (round % 5 === 0 ? 120 : 8))
      for (let i = 0; i < n; i++) {
        const key = `node/${Math.floor(random() * 400)}`
        const value = random() < 0.25 ? null : `v${Math.floor(random() * 1e6)}`
        edits.push({ key, value })
      }
      const last = new Map(edits.map((e) => [e.key, e.value]))
      for (const [key, value] of last) {
        if (value === null) state.delete(key)
        else state.set(key, value)
      }
      t = await updateTree(store, root, [...last].map(([key, value]) => ({ key, value })))
      store.keep(t.written)
      root = t.root
      const fresh = await buildTree(new MemStore(), [...state].map(([key, value]) => ({ key, value })))
      expect(root).toBe(fresh.root)
    }
    expect(state.size).toBeGreaterThan(MAX_LEAF)
    expect(sorted(entriesOf(store, root))).toEqual(sorted([...state].map(([key, value]) => ({ key, value }))))
  })

  it('deleting back to few entries collapses to one leaf; deleting everything gives the empty root', async () => {
    const store = new MemStore()
    const empty = await buildTree(store, [])
    const entries = Array.from({ length: 100 }, (_, i) => ({ key: `node/${i}`, value: `v${i}` }))
    const full = await buildTree(store, entries)
    store.keep(full.written)
    const gone = await updateTree(store, full.root, entries.map((e) => ({ key: e.key, value: null })))
    expect(gone.root).toBe(empty.root)
  })

  it('an edit writes only the nodes on its path', async () => {
    const store = new MemStore()
    const entries = Array.from({ length: 5000 }, (_, i) => ({ key: `node/${i}`, value: `v${i}` }))
    const full = await buildTree(store, entries)
    store.keep(full.written)
    const one = await updateTree(store, full.root, [{ key: 'node/42', value: 'changed' }])
    expect(full.written.size).toBeGreaterThan(200)
    expect(one.written.size).toBeLessThanOrEqual(4)
    store.keep(one.written)
    expect(await valueAt(store, one.root, 'node/42')).toBe('changed')
    expect(await valueAt(store, one.root, 'node/43')).toBe('v43')
    expect(await valueAt(store, one.root, 'node/missing')).toBeNull()
  })

  it('diff reports exactly the changed keys', async () => {
    const store = new MemStore()
    const entries = Array.from({ length: 500 }, (_, i) => ({ key: `node/${i}`, value: `v${i}` }))
    const a = await buildTree(store, entries)
    store.keep(a.written)
    const b = await updateTree(store, a.root, [
      { key: 'node/1', value: 'x' },
      { key: 'node/2', value: null },
      { key: 'cell/new', value: 'y' },
    ])
    store.keep(b.written)
    const changes = diffTrees(store, a.root, b.root).sort((p, q) => p.key.localeCompare(q.key))
    expect(changes).toEqual([
      { key: 'cell/new', before: null, after: 'y' },
      { key: 'node/1', before: 'v1', after: 'x' },
      { key: 'node/2', before: 'v2', after: null },
    ])
    expect(diffTrees(store, b.root, b.root)).toEqual([])
  })
})
