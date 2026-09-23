/** `Databases` in memory: nothing survives the process. Tests and hosts without OPFS. */
import { oo1Sql, type Sql } from '../doc/commits'
import type { Databases } from './store-backend'

interface Sqlite3 {
  oo1: { DB: new (filename: string, flags?: string) => Parameters<typeof oo1Sql>[0] }
}

export function memoryDatabases(sqlite3: Sqlite3): Databases {
  const docs = new Map<string, Sql>()
  return {
    library: oo1Sql(new sqlite3.oo1.DB(':memory:', 'c')),
    async document(id) {
      let sql = docs.get(id)
      if (!sql) docs.set(id, (sql = oo1Sql(new sqlite3.oo1.DB(':memory:', 'c'))))
      return sql
    },
    async remove(id) {
      docs.get(id)?.close()
      docs.delete(id)
    },
  }
}
