import { describe, expect, it } from 'vitest'
import { opfsDatabases } from '../../../src/lib/persistence/opfs-databases'

class FakePool {
  paused = false
  removed = false
  openDbs = 0
  constructor(readonly name: string) {}
  get holdsHandles() {
    return !this.paused && !this.removed
  }
  OpfsSAHPoolDb = class {
    constructor(private readonly pool: FakePool) {
      pool.openDbs++
    }
    exec() {}
    selectObjects() {
      return []
    }
    transaction(fn: () => void) {
      fn()
    }
    close() {
      this.pool.openDbs--
    }
  } as unknown as new (filename: string) => never
  pauseVfs() {
    if (this.openDbs) throw new Error('database still open')
    this.paused = true
    return this
  }
  async unpauseVfs() {
    this.paused = false
    return this
  }
  isPaused() {
    return this.paused
  }
  async removeVfs() {
    this.removed = true
    return true
  }
}

function fakeSqlite() {
  const pools: FakePool[] = []
  return {
    pools,
    installOpfsSAHPoolVfs: async (opts: { name: string }) => {
      const pool = new FakePool(opts.name)
      const Db = pool.OpfsSAHPoolDb as unknown as new (p: FakePool) => unknown
      pool.OpfsSAHPoolDb = class {
        constructor() {
          return new Db(pool)
        }
      } as never
      pools.push(pool)
      return pool
    },
  }
}

describe('OPFS databases', () => {
  it('keeps at most one document pool holding file handles, plus the library', async () => {
    const sqlite = fakeSqlite()
    const dbs = await opfsDatabases(sqlite as never)
    await dbs.document('a')
    await dbs.document('b')
    await dbs.document('c')
    const holding = () => sqlite.pools.filter((p) => p.holdsHandles).map((p) => p.name)
    expect(holding()).toEqual(['zoetrope-library', 'zoetrope-doc-c'])
    await dbs.document('a')
    expect(holding()).toEqual(['zoetrope-library', 'zoetrope-doc-a'])
    expect(sqlite.pools.filter((p) => p.name === 'zoetrope-doc-a')).toHaveLength(1)
  })

  it('a higher limit keeps the most recently used documents open', async () => {
    const sqlite = fakeSqlite()
    const dbs = await opfsDatabases(sqlite as never, { maxOpenDocuments: 2 })
    await dbs.document('a')
    await dbs.document('b')
    await dbs.document('a')
    await dbs.document('c')
    expect(sqlite.pools.filter((p) => p.holdsHandles).map((p) => p.name).sort()).toEqual([
      'zoetrope-doc-a',
      'zoetrope-doc-c',
      'zoetrope-library',
    ])
  })

  it('removing a paused document removes its pool', async () => {
    const sqlite = fakeSqlite()
    const dbs = await opfsDatabases(sqlite as never)
    await dbs.document('a')
    await dbs.document('b')
    await dbs.remove('a')
    expect(sqlite.pools.find((p) => p.name === 'zoetrope-doc-a')?.removed).toBe(true)
  })
})
