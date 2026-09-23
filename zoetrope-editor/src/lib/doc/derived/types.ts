/**
 * `ofType(pageId, type)`: the nodes of one type on one page. One index per
 * type, built the first time it is asked for. Hit tests that only care about
 * slots or containers scan those, not the page.
 */
import { signal, type Signal } from '@preact/signals-core'
import type { NodeId, PageId } from '../ids'
import type { Node } from '../schema'
import { tables, type Tables } from '../store'
import { derived } from './define'

type ByPage = Map<PageId, Signal<ReadonlySet<NodeId>>>

const EMPTY: ReadonlySet<NodeId> = new Set()
const built = new Map<string, ByPage>()

function slot(ix: ByPage, page: PageId): Signal<ReadonlySet<NodeId>> {
  let s = ix.get(page)
  if (!s) ix.set(page, (s = signal(EMPTY)))
  return s
}

function edit(ix: ByPage, page: PageId, id: NodeId, add: boolean): void {
  const s = slot(ix, page)
  const set = s.peek()
  if (set.has(id) === add) return
  const next = new Set(set)
  if (add) next.add(id)
  else next.delete(id)
  s.value = next.size ? next : EMPTY
}

function build(t: Tables, type: string): ByPage {
  const ix: ByPage = new Map()
  const groups = new Map<PageId, Set<NodeId>>()
  for (const s of t.node.rows.values()) {
    const n = s.peek()
    if (n.type !== type) continue
    let g = groups.get(n.page)
    if (!g) groups.set(n.page, (g = new Set()))
    g.add(n.id)
  }
  for (const [page, ids] of groups) ix.set(page, signal(ids))
  return ix
}

derived({
  rebuild() {
    built.clear()
  },
  update(_t, applied) {
    if (built.size === 0) return
    for (const a of applied) {
      if (a.change.kind !== 'node') continue
      const before = a.before as Node | undefined
      const after = a.after as Node | undefined
      if (before && after && before.type === after.type && before.page === after.page) continue
      const out = before && built.get(before.type)
      if (out) edit(out, before.page, before.id, false)
      const into = after && built.get(after.type)
      if (into) edit(into, after.page, after.id, true)
    }
  },
})

/** Ids of the `type` nodes on `pageId`. Subscribes when read reactively. */
export function ofType(pageId: PageId, type: string): ReadonlySet<NodeId> {
  let ix = built.get(type)
  if (!ix) built.set(type, (ix = build(tables, type)))
  return slot(ix, pageId).value
}
