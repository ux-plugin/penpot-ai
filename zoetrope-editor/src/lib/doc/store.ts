/**
 * The document in memory: one frozen record per row, one signal per record,
 * a map per kind. Only the reducer (`apply.ts`) writes here.
 *
 * `field` hands out a computed per (record, key), so a view of the name never
 * wakes for a fill edit.
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals-core'
import type { Kind, RecordOf } from './schema'
import type { PageId } from './ids'

export interface Table<R> {
  rows: Map<string, Signal<R>>
  /** Bumped on add and delete, so enumerations can subscribe to membership. */
  rev: Signal<number>
}

export interface Tables {
  page: Table<RecordOf<'page'>>
  node: Table<RecordOf<'node'>>
}

function table<R>(): Table<R> {
  return { rows: new Map(), rev: signal(0) }
}

export function createTables(): Tables {
  return { page: table(), node: table() }
}

/** The live document. */
export const tables: Tables = createTables()

/** The page the editor shows. Ephemeral. */
export const currentPageId = signal<PageId | null>(null)

export function sig<K extends Kind>(kind: K, id: string): Signal<RecordOf<K>> | undefined {
  return (tables[kind] as Table<RecordOf<K>>).rows.get(id)
}

/** The record, subscribing when read inside a computed or effect. */
export function get<K extends Kind>(kind: K, id: string): RecordOf<K> | undefined {
  return sig(kind, id)?.value
}

export function has(kind: Kind, id: string): boolean {
  return tables[kind].rows.has(id)
}

/** Every id of a kind. Reads `rev`, so a computed over it follows adds and deletes. */
export function ids(kind: Kind): IterableIterator<string> {
  void tables[kind].rev.value
  return tables[kind].rows.keys()
}

export function count(kind: Kind): number {
  void tables[kind].rev.value
  return tables[kind].rows.size
}

/** Every record of a kind, subscribing to membership and to each record read. */
export function* records<K extends Kind>(kind: K): IterableIterator<RecordOf<K>> {
  void tables[kind].rev.value
  for (const s of (tables[kind] as Table<RecordOf<K>>).rows.values()) yield s.value
}

const fieldMemo = new WeakMap<Signal<unknown>, Map<string, ReadonlySignal<unknown>>>()

/** A computed over one field of one record. Memoised per record signal. */
export function field<K extends Kind, F extends keyof RecordOf<K>>(
  kind: K,
  id: string,
  key: F,
): ReadonlySignal<RecordOf<K>[F] | undefined> {
  const s = sig(kind, id) as Signal<unknown> | undefined
  if (!s) return MISSING as ReadonlySignal<RecordOf<K>[F] | undefined>
  let byKey = fieldMemo.get(s)
  if (!byKey) fieldMemo.set(s, (byKey = new Map()))
  let c = byKey.get(key as string)
  if (!c) {
    c = computed(() => (s.value as Record<string, unknown> | undefined)?.[key as string])
    byKey.set(key as string, c)
  }
  return c as ReadonlySignal<RecordOf<K>[F] | undefined>
}

const MISSING: ReadonlySignal<undefined> = computed(() => undefined)

/** Drop every record. Load and tests. */
export function clearTables(t: Tables = tables): void {
  for (const k of Object.keys(t) as Kind[]) {
    t[k].rows.clear()
    t[k].rev.value++
  }
}
