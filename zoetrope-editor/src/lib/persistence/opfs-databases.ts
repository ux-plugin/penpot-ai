/**
 * `Databases` over OPFS with the `opfs-sahpool` VFS (no cross-origin
 * isolation needed). A pool holds its files open for as long as it is
 * installed, so each document gets its own pool in its own directory, and at
 * most `maxOpenDocuments` document pools are open at once: opening another
 * pauses the least recently used, which releases its file handles. The
 * library pool stays open. Runs in a dedicated worker.
 */
import { oo1Sql, type Sql } from '../doc/commits'
import type { Databases } from './store-backend'

interface Pool {
  OpfsSAHPoolDb: new (filename: string) => Parameters<typeof oo1Sql>[0]
  pauseVfs(): Pool
  unpauseVfs(): Promise<Pool>
  isPaused(): boolean
  removeVfs(): Promise<boolean>
}

interface Sqlite3 {
  installOpfsSAHPoolVfs(opts: { name: string; directory: string; initialCapacity?: number }): Promise<Pool>
}

const ROOT = 'zoetrope'
const DB_FILE = '/db.sqlite3'

/** Two slots for the database and its journal, one spare. */
const POOL_CAPACITY = 3

const vfsName = (id: string) => `zoetrope-doc-${id.replace(/[^A-Za-z0-9]/g, '')}`
const docDir = (id: string) => `/${ROOT}/docs/${id}`

export interface OpfsLimits {
  /** Document pools open at once. The library pool is extra. */
  maxOpenDocuments: number
}

export async function opfsDatabases(sqlite3: Sqlite3, limits: OpfsLimits = { maxOpenDocuments: 1 }): Promise<Databases> {
  const libraryPool = await sqlite3.installOpfsSAHPoolVfs({ name: 'zoetrope-library', directory: `/${ROOT}/library`, initialCapacity: POOL_CAPACITY })
  const library = oo1Sql(new libraryPool.OpfsSAHPoolDb(DB_FILE))

  const pools = new Map<string, Pool>()
  const open = new Map<string, Sql>()

  const close = (id: string): void => {
    const sql = open.get(id)
    if (!sql) return
    sql.close()
    open.delete(id)
    pools.get(id)?.pauseVfs()
  }

  const acquire = async (id: string): Promise<Pool> => {
    const known = pools.get(id)
    if (known) return known.isPaused() ? known.unpauseVfs() : known
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: vfsName(id), directory: docDir(id), initialCapacity: POOL_CAPACITY })
    pools.set(id, pool)
    return pool
  }

  return {
    library,
    async document(id) {
      const hit = open.get(id)
      if (hit) {
        open.delete(id)
        open.set(id, hit)
        return hit
      }
      while (open.size >= limits.maxOpenDocuments) close(open.keys().next().value!)
      const pool = await acquire(id)
      const sql = oo1Sql(new pool.OpfsSAHPoolDb(DB_FILE))
      open.set(id, sql)
      return sql
    },
    async remove(id) {
      open.get(id)?.close()
      open.delete(id)
      const pool = pools.get(id)
      pools.delete(id)
      if (pool) {
        if (pool.isPaused()) await pool.unpauseVfs()
        await pool.removeVfs()
        return
      }
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(ROOT, { create: true }).then((d) => d.getDirectoryHandle('docs', { create: true }))
      await dir.removeEntry(id, { recursive: true }).catch(() => {})
    },
  }
}
