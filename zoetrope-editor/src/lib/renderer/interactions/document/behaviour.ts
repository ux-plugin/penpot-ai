/**
 * A page's behaviour, read from the document: the page's cells and the
 * document's, its bindings, its rules in order. Every piece is a record;
 * `behaviourOf` only groups them. Edits are changes (./edit-interactions)
 * committed through `commitChanges`, so they share the undo stack.
 */
import { computed, type ReadonlySignal } from '@preact/signals-core'
import { add, commitChanges, del, get, mod, readersOf, records, type Kind, type LocalChange } from '../../../doc'
import type { Behaviour, Binding, Cell, Rule, Store } from '../ir'
import { cellRef, ownerKind } from '../ir'

const OWNER_RANK = { document: 0, page: 1, node: 2 } as const

function byCell(a: Cell, b: Cell): number {
  return OWNER_RANK[ownerKind(a)] - OWNER_RANK[ownerKind(b)] || cellRef(a).localeCompare(cellRef(b))
}

function readAll<K extends 'binding' | 'rule'>(kind: K, page: string) {
  const out = []
  for (const id of readersOf(kind, 'page', page)) {
    const r = get(kind, id)
    if (r) out.push(r)
  }
  return out
}

function build(page: string): Behaviour {
  const cells: Cell[] = []
  for (const c of records('cell')) if (c.page === page || c.page == null) cells.push(c)
  cells.sort(byCell)
  const bindings = (readAll('binding', page) as Binding[]).sort(
    (a, b) => a.node.localeCompare(b.node) || a.prop.localeCompare(b.prop),
  )
  const rules = (readAll('rule', page) as Rule[]).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id.localeCompare(b.id)))
  return { cells, bindings, rules }
}

const memo = new Map<string, ReadonlySignal<Behaviour>>()

/** The behaviour of `page`, recomputed when one of its records changes. */
export function behaviourOf(page: string): ReadonlySignal<Behaviour> {
  let s = memo.get(page)
  if (!s) memo.set(page, (s = computed(() => build(page))))
  return s
}

/** `behaviourOf(page)` now, without subscribing. */
export function currentBehaviour(page: string): Behaviour {
  return behaviourOf(page).peek()
}

const storesSignal = computed<Store[]>(() => [...records('store')].sort((a, b) => a.id.localeCompare(b.id)))

/** The document's stores, by name. */
export function storesOf(): ReadonlySignal<Store[]> {
  return storesSignal
}

export function currentStores(): Store[] {
  return storesSignal.peek()
}

/** Commit behaviour edits as one undo frame. */
export async function commitBehaviour(changes: readonly LocalChange[], label?: string): Promise<void> {
  if (changes.length === 0) return
  await commitChanges({ changes, label })
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffKind<R extends { id: string }>(kind: Kind, prev: readonly R[], next: readonly R[]): LocalChange[] {
  const out: LocalChange[] = []
  const before = new Map(prev.map((r) => [r.id, r]))
  const after = new Map(next.map((r) => [r.id, r]))
  for (const id of before.keys()) if (!after.has(id)) out.push(del(kind, id) as LocalChange)
  for (const [id, r] of after) {
    const b = before.get(id)
    if (!b) {
      out.push(add(kind, r as never) as LocalChange)
      continue
    }
    const set: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(b), ...Object.keys(r)])) {
      const v = (r as Record<string, unknown>)[k]
      if (!same((b as Record<string, unknown>)[k], v)) set[k] = v
    }
    if (Object.keys(set).length) out.push(mod(kind, id, set as never) as LocalChange)
  }
  return out
}

/** The changes that turn `prev` into `next`, matched by record id. */
export function diffBehaviour(prev: Behaviour, next: Behaviour): LocalChange[] {
  return [...diffKind('cell', prev.cells, next.cells), ...diffKind('binding', prev.bindings, next.bindings), ...diffKind('rule', prev.rules, next.rules)]
}

/** Replace the behaviour of `page` with `next` (an AI answer), as one undo frame. */
export async function replaceBehaviour(page: string, next: Behaviour): Promise<void> {
  await commitBehaviour(diffBehaviour(currentBehaviour(page), next))
}
