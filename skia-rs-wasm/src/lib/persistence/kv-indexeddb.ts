/**
 * kv-indexeddb — a KvStore backed by a single IndexedDB object store.
 *
 * Hand-rolled (no `idb` dependency) and intentionally tiny: one store, string
 * values keyed by string. The DB is opened lazily on first use. This is the only
 * module that touches `indexedDB`, so the rest of persistence stays testable with
 * an in-memory KvStore.
 */

import type { KvStore } from './document-persistence'

export function createIndexedDbKvStore(dbName: string, storeName: string): KvStore {
  let dbPromise: Promise<IDBDatabase> | null = null

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbPromise
  }

  const run = <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, mode)
          const req = op(tx.objectStore(storeName))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        }),
    )

  return {
    async get(key) {
      const v = await run<unknown>('readonly', (s) => s.get(key))
      return typeof v === 'string' ? v : null
    },
    async set(key, value) {
      await run('readwrite', (s) => s.put(value, key))
    },
    async delete(key) {
      await run('readwrite', (s) => s.delete(key))
    },
  }
}
