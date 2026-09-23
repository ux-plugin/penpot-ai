/**
 * The reducer. Applies one change to the tables and returns what it did,
 * including the record before, so the inverse is a function of the result.
 * Pure over `Tables`: the main thread and the hit-index worker both run it.
 */
import { signal } from '@preact/signals-core'
import type { Change } from './changes'
import type { AnyRecord, Kind } from './schema'
import type { Table, Tables } from './store'
import { KINDS } from './schema/kinds'

export interface Applied {
  change: Change
  before: AnyRecord | undefined
  after: AnyRecord | undefined
}

function freeze<R extends object>(r: R): R {
  return Object.isFrozen(r) ? r : Object.freeze(r)
}

export function applyChange(t: Tables, c: Change): Applied | null {
  const table = t[c.kind] as Table<AnyRecord>
  switch (c.op) {
    case 'add': {
      const record = freeze(c.record)
      const existing = table.rows.get(record.id)
      if (existing) {
        const before = existing.peek()
        existing.value = record
        return { change: c, before, after: record }
      }
      table.rows.set(record.id, signal(record))
      table.rev.value++
      return { change: c, before: undefined, after: record }
    }
    case 'del': {
      const existing = table.rows.get(c.id)
      if (!existing) return null
      const before = existing.peek()
      table.rows.delete(c.id)
      table.rev.value++
      return { change: c, before, after: undefined }
    }
    case 'mod': {
      const existing = table.rows.get(c.id)
      if (!existing) return null
      const before = existing.peek()
      const next: Record<string, unknown> = { ...before }
      let changed = false
      for (const [k, v] of Object.entries(c.set)) {
        if (v === undefined) {
          if (k in next) {
            delete next[k]
            changed = true
          }
        } else if (next[k] !== v) {
          next[k] = v
          changed = true
        }
      }
      if (!changed) return null
      const after = freeze(next as AnyRecord)
      existing.value = after
      return { change: c, before, after }
    }
  }
}

/** The change that takes `a` back. */
export function inverseOf(a: Applied): Change {
  const c = a.change
  switch (c.op) {
    case 'add':
      return a.before
        ? ({ op: 'add', kind: c.kind, record: a.before } as Change)
        : ({ op: 'del', kind: c.kind, id: c.record.id } as Change)
    case 'del':
      return { op: 'add', kind: c.kind, record: a.before! } as Change
    case 'mod': {
      const set: Record<string, unknown> = {}
      const before = a.before as Record<string, unknown>
      for (const k of Object.keys(c.set)) set[k] = before[k]
      return { op: 'mod', kind: c.kind, id: c.id, set } as Change
    }
  }
}

/** Apply in order; return what happened, in order. */
export function applyAll(t: Tables, changes: readonly Change[]): Applied[] {
  const out: Applied[] = []
  for (const c of changes) {
    const a = applyChange(t, c)
    if (a) out.push(a)
  }
  return out
}

/** Inverses of `applied`, in the order that undoes them (last first). */
export function inversesOf(applied: readonly Applied[]): Change[] {
  const out: Change[] = []
  for (let i = applied.length - 1; i >= 0; i--) out.push(inverseOf(applied[i]))
  return out
}

/** Ids touched, per kind. */
export function touchedOf(applied: readonly Applied[]): Record<Kind, Set<string>> {
  const t = {} as Record<Kind, Set<string>>
  for (const k of KINDS) t[k] = new Set()
  for (const a of applied) t[a.change.kind].add(a.change.op === 'add' ? a.change.record.id : a.change.id)
  return t
}
