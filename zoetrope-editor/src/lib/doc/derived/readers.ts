/**
 * `readersOf(kind, field, id)`: the records of `kind` whose `field` points at
 * `id`. One reverse index per declared reference field, built the first time
 * it is asked for and kept current after that. A field another index already
 * answers (`parentId` by `childrenOf`) registers a provider instead.
 *
 * `ownedBy` walks the `cascade` fields: what a delete takes with it.
 */
import { signal, type Signal } from '@preact/signals-core'
import { cascadeFields, idsIn, kinds, refFields } from '../registry'
import type { AnyRecord, Kind } from '../schema'
import { tables, type Table, type Tables } from '../store'
import { derived } from './define'

type Provider = (id: string) => readonly string[]

interface FieldIndex {
  kind: Kind
  field: string
  byTarget: Map<string, Signal<ReadonlySet<string>>>
}

const EMPTY: ReadonlySet<string> = new Set()
const providers = new Map<string, Provider>()
const built = new Map<string, FieldIndex>()

const keyOf = (kind: Kind, field: string): string => `${kind}.${field}`

/** Answer `readersOf(kind, field, ·)` from another index. */
export function provideReaders(kind: Kind, field: string, provider: Provider): void {
  providers.set(keyOf(kind, field), provider)
}

function slot(ix: FieldIndex, target: string): Signal<ReadonlySet<string>> {
  let s = ix.byTarget.get(target)
  if (!s) ix.byTarget.set(target, (s = signal(EMPTY)))
  return s
}

function link(ix: FieldIndex, target: string, id: string): void {
  const s = slot(ix, target)
  const set = s.peek()
  if (set.has(id)) return
  const next = new Set(set)
  next.add(id)
  s.value = next
}

function unlink(ix: FieldIndex, target: string, id: string): void {
  const s = ix.byTarget.get(target)
  const set = s?.peek()
  if (!s || !set?.has(id)) return
  const next = new Set(set)
  next.delete(id)
  s.value = next.size ? next : EMPTY
}

function build(t: Tables, kind: Kind, field: string): FieldIndex {
  const ix: FieldIndex = { kind, field, byTarget: new Map() }
  const groups = new Map<string, Set<string>>()
  for (const s of (t[kind] as Table<AnyRecord>).rows.values()) {
    const r = s.peek()
    for (const target of idsIn(r, field)) {
      let g = groups.get(target)
      if (!g) groups.set(target, (g = new Set()))
      g.add(r.id)
    }
  }
  for (const [target, ids] of groups) ix.byTarget.set(target, signal(ids))
  return ix
}

function indexOf(kind: Kind, field: string): FieldIndex {
  const key = keyOf(kind, field)
  let ix = built.get(key)
  if (!ix) built.set(key, (ix = build(tables, kind, field)))
  return ix
}

derived({
  rebuild() {
    built.clear()
  },
  update(_t, applied) {
    if (built.size === 0) return
    for (const a of applied) {
      for (const ix of built.values()) {
        if (ix.kind !== a.change.kind) continue
        const before = idsIn(a.before, ix.field)
        const after = idsIn(a.after, ix.field)
        if (before.length === 0 && after.length === 0) continue
        const id = (a.after ?? a.before)!.id
        for (const target of before) if (!after.includes(target)) unlink(ix, target, id)
        for (const target of after) if (!before.includes(target)) link(ix, target, id)
      }
    }
  },
})

/** Ids of the `kind` records whose `field` points at `id`. Subscribes when read reactively. */
export function readersOf(kind: Kind, field: string, id: string): readonly string[] {
  const provider = providers.get(keyOf(kind, field))
  if (provider) return provider(id)
  return [...slot(indexOf(kind, field), id).value]
}

export interface Owned {
  kind: Kind
  id: string
}

/** Every record a delete of `(kind, id)` takes with it through `cascade` fields, deepest first. */
export function ownedBy(kind: Kind, id: string): Owned[] {
  const out: Owned[] = []
  const seen = new Set<string>([`${kind}:${id}`])
  const visit = (k: Kind, target: string): void => {
    for (const source of kinds) {
      for (const f of cascadeFields(source)) {
        if (f.kind !== k) continue
        for (const reader of readersOf(source, f.field, target)) {
          const key = `${source}:${reader}`
          if (seen.has(key)) continue
          seen.add(key)
          visit(source, reader)
          out.push({ kind: source, id: reader })
        }
      }
    }
  }
  visit(kind, id)
  return out
}

export interface Dangling {
  kind: Kind
  id: string
  field: string
  target: string
}

/** References that point at nothing. They are allowed; this lists them. */
export function dangling(t: Tables = tables): Dangling[] {
  const out: Dangling[] = []
  for (const kind of kinds) {
    for (const s of (t[kind] as Table<AnyRecord>).rows.values()) {
      const r = s.peek()
      for (const f of refFields(kind)) {
        for (const target of idsIn(r, f.field)) {
          if (!t[f.kind].rows.has(target)) out.push({ kind, id: r.id, field: f.field, target })
        }
      }
    }
  }
  return out
}
