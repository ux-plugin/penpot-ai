/**
 * The slice of SQLite the stores use, so they run over the WASM build in a
 * worker (OPFS) and in tests (in memory) alike.
 */

export type SqlValue = string | number | null | Uint8Array

export interface Sql {
  /** Run statements; with `bind`, exactly one. */
  run(sql: string, bind?: readonly SqlValue[]): void
  all<T>(sql: string, bind?: readonly SqlValue[]): T[]
  /** Run `fn` in one transaction, rolled back if it throws. */
  transaction(fn: () => void): void
  close(): void
}

interface Oo1Db {
  exec(opts: { sql: string; bind?: SqlValue[] }): unknown
  selectObjects(sql: string, bind?: SqlValue[]): Record<string, unknown>[]
  transaction(fn: () => void): unknown
  close(): void
}

/** An `Sql` over an sqlite-wasm `oo1.DB`. */
export function oo1Sql(db: Oo1Db): Sql {
  return {
    run: (sql, bind) => void db.exec(bind ? { sql, bind: [...bind] } : { sql }),
    all: <T>(sql: string, bind?: readonly SqlValue[]) => db.selectObjects(sql, bind ? [...bind] : undefined) as T[],
    transaction: (fn) => void db.transaction(fn),
    close: () => db.close(),
  }
}
