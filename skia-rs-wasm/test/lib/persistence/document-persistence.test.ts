/**
 * Capability-gated document persistence: envelope encode/decode, the KV-backed
 * provider's round-trip + failure degradation, the None provider, and the
 * environment probe. Storage is an in-memory KvStore (the test env is node, so
 * there's no IndexedDB) — the IndexedDB adapter is the only untested seam and is
 * a thin wrapper over the same KvStore contract.
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
    async set(k, v) {
      map.set(k, v)
    },
    async delete(k) {
      map.delete(k)
    },
  }
}

/** A tiny document whose node carries a scene3d blob, to prove 3D survives. */
function sampleDoc(): PenpotDocument {
  return {
    name: 'Test',
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

  it('KvDocumentProvider saves, loads, and clears', async () => {
    const kv = memKv()
    const provider = new KvDocumentProvider(kv, 'indexeddb', () => 42)
    expect(provider.canPersist).toBe(true)
    expect(await provider.load()).toBeNull()

    await provider.save(sampleDoc())
    expect(await provider.load()).toEqual(sampleDoc())
    // Stored as a versioned, timestamped envelope.
    expect(JSON.parse(kv.map.get('current')!)).toMatchObject({ version: 2, savedAt: 42 })

    await provider.clear()
    expect(await provider.load()).toBeNull()
  })

  it('KvDocumentProvider degrades (no throw) when the KV store fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: KvStore = {
      get: async () => {
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
    await expect(provider.load()).resolves.toBeNull()
    await expect(provider.save(sampleDoc())).resolves.toBeUndefined()
    await expect(provider.clear()).resolves.toBeUndefined()
  })

  it('NonePersistenceProvider never persists', async () => {
    const provider = new NonePersistenceProvider()
    expect(provider.id).toBe('none')
    expect(provider.canPersist).toBe(false)
    expect(await provider.load()).toBeNull()
    await expect(provider.save(sampleDoc())).resolves.toBeUndefined()
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
      expect(makeKv).toHaveBeenCalledWith('skia-rs-wasm', 'documents')
    } finally {
      if (!had) delete g.indexedDB
    }
  })
})
