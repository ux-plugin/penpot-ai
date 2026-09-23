/**
 * The store worker: SQLite over OPFS, off the main thread. Answers
 * `DocumentStore` calls posted by `WorkerDocumentStore`.
 *
 * The OPFS files may be held by one context at a time, and a failed pool
 * install makes SQLite delete that pool's directory. So the worker takes an
 * exclusive lock before touching any file and holds it for its whole life:
 * after a reload it waits for the old page's worker to go, and in a second
 * tab it gives up without opening anything.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { opfsDatabases } from './opfs-databases'
import { StoreBackend } from './store-backend'
import type { StoreCall, StoreReply } from './worker-store'

const LOCK = 'zoetrope-store'
const LOCK_WAIT_MS = 5000

function holdStoreLock(): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), LOCK_WAIT_MS)
    navigator.locks
      .request(LOCK, { signal: abort.signal }, () => {
        clearTimeout(timer)
        resolve()
        return new Promise<never>(() => {})
      })
      .catch((err: unknown) =>
        reject(err instanceof DOMException && err.name === 'AbortError' ? new Error('Zoetrope is open in another tab') : err),
      )
  })
}

const backend = holdStoreLock()
  .then(() => sqlite3InitModule())
  .then((sqlite3) => opfsDatabases(sqlite3))
  .then((dbs) => new StoreBackend(dbs))

backend.catch((err: unknown) => {
  const reply: StoreReply = { id: -1, error: err instanceof Error ? err.message : String(err) }
  postMessage(reply)
})

self.onmessage = async (e: MessageEvent<StoreCall>) => {
  const { id, method, args } = e.data
  try {
    const store = await backend
    const fn = store[method] as (...a: unknown[]) => Promise<unknown>
    const result = await fn.apply(store, args)
    postMessage({ id, result } satisfies StoreReply)
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies StoreReply)
  }
}
