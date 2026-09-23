/**
 * The three things that can happen to a record. Everything the editor writes
 * is one of these; the reducer returns the inverse of each.
 */
import type { Kind, RecordOf } from './schema'

export interface AddChange<K extends Kind = Kind> {
  op: 'add'
  kind: K
  record: RecordOf<K>
}

export interface DelChange<K extends Kind = Kind> {
  op: 'del'
  kind: K
  id: string
}

export interface ModChange<K extends Kind = Kind> {
  op: 'mod'
  kind: K
  id: string
  /** Fields to replace. An `undefined` value removes the field. */
  set: Partial<RecordOf<K>>
  /** Written by the system (sync, propagation), not the user: never an override. */
  system?: boolean
}

/** One `set` for many records. Expanded before apply; the undo frame keeps the compact form. */
export interface ModsChange<K extends Kind = Kind> {
  op: 'mods'
  kind: K
  ids: string[]
  set: Partial<RecordOf<K>>
  system?: boolean
}

export type Change<K extends Kind = Kind> = K extends Kind
  ? AddChange<K> | DelChange<K> | ModChange<K>
  : never

export type LocalChange<K extends Kind = Kind> = Change<K> | (K extends Kind ? ModsChange<K> : never)

export function add<K extends Kind>(kind: K, record: RecordOf<K>): AddChange<K> {
  return { op: 'add', kind, record }
}

export function del<K extends Kind>(kind: K, id: string): DelChange<K> {
  return { op: 'del', kind, id }
}

export function mod<K extends Kind>(kind: K, id: string, set: Partial<RecordOf<K>>): ModChange<K> {
  return { op: 'mod', kind, id, set }
}

export function mods<K extends Kind>(
  kind: K,
  ids: readonly string[],
  set: Partial<RecordOf<K>>,
  system?: boolean,
): ModsChange<K> {
  return system ? { op: 'mods', kind, ids: [...ids], set, system } : { op: 'mods', kind, ids: [...ids], set }
}

export function isBulk(c: LocalChange): c is ModsChange {
  return c.op === 'mods'
}

/** One `mod` per id, in list order. Plain changes pass through. */
export function expand(changes: readonly LocalChange[]): Change[] {
  if (!changes.some(isBulk)) return changes as Change[]
  const out: Change[] = []
  for (const c of changes) {
    if (!isBulk(c)) out.push(c)
    else
      for (const id of c.ids)
        out.push((c.system ? { op: 'mod', kind: c.kind, id, set: c.set, system: true } : { op: 'mod', kind: c.kind, id, set: c.set }) as Change)
  }
  return out
}

/** Group by the value they set, one bulk change per distinct value. */
export function modsByValue<K extends Kind>(
  kind: K,
  entries: ReadonlyArray<{ id: string; set: Partial<RecordOf<K>> }>,
  system?: boolean,
): ModsChange<K>[] {
  const groups = new Map<string, { set: Partial<RecordOf<K>>; ids: string[] }>()
  for (const e of entries) {
    const key = JSON.stringify(e.set)
    const g = groups.get(key)
    if (g) g.ids.push(e.id)
    else groups.set(key, { set: e.set, ids: [e.id] })
  }
  return Array.from(groups.values(), (g) => mods(kind, g.ids, g.set, system))
}

/** The id a change addresses. */
export function idOf(c: Change): string {
  return c.op === 'add' ? c.record.id : c.id
}
