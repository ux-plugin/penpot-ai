/**
 * `childrenOf(key)`: the ordered child ids of a node, or the top level of a
 * page when `key` is a page id. Derived from `parentId` / `page` / `order`;
 * updated per change, never stored.
 */
import { signal, type Signal } from '@preact/signals-core'
import type { Applied } from '../apply'
import type { NodeId, ParentKey } from '../ids'
import type { Node } from '../schema'
import type { Tables } from '../store'

const EMPTY: readonly NodeId[] = Object.freeze([])

export interface ChildrenIndex {
  lists: Map<ParentKey, Signal<readonly NodeId[]>>
}

export function createChildrenIndex(): ChildrenIndex {
  return { lists: new Map() }
}

export function keyOf(n: Node): ParentKey {
  return n.parentId ?? n.page
}

function listOf(ix: ChildrenIndex, key: ParentKey): Signal<readonly NodeId[]> {
  let s = ix.lists.get(key)
  if (!s) ix.lists.set(key, (s = signal(EMPTY)))
  return s
}

function orderOf(t: Tables, id: NodeId): string {
  return t.node.rows.get(id)?.peek().order ?? ''
}

/** Index of the first sibling whose order is not below `order`. */
function insertionIndex(t: Tables, list: readonly NodeId[], order: string): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (orderOf(t, list[mid]) < order) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insert(ix: ChildrenIndex, t: Tables, key: ParentKey, id: NodeId, order: string): void {
  const s = listOf(ix, key)
  const list = s.peek()
  const i = insertionIndex(t, list, order)
  s.value = [...list.slice(0, i), id, ...list.slice(i)]
}

function remove(ix: ChildrenIndex, key: ParentKey, id: NodeId): void {
  const s = ix.lists.get(key)
  if (!s) return
  const list = s.peek()
  const i = list.indexOf(id)
  if (i < 0) return
  s.value = list.length === 1 ? EMPTY : [...list.slice(0, i), ...list.slice(i + 1)]
}

export function rebuildChildren(ix: ChildrenIndex, t: Tables): void {
  const groups = new Map<ParentKey, Node[]>()
  for (const s of t.node.rows.values()) {
    const n = s.peek()
    const key = keyOf(n)
    const g = groups.get(key)
    if (g) g.push(n)
    else groups.set(key, [n])
  }
  for (const s of ix.lists.values()) s.value = EMPTY
  for (const [key, nodes] of groups) {
    nodes.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    listOf(ix, key).value = nodes.map((n) => n.id)
  }
}

export function updateChildren(ix: ChildrenIndex, t: Tables, applied: readonly Applied[]): void {
  for (const a of applied) {
    if (a.change.kind !== 'node') continue
    const before = a.before as Node | undefined
    const after = a.after as Node | undefined
    if (before && after) {
      if (before.parentId === after.parentId && before.page === after.page && before.order === after.order) continue
      remove(ix, keyOf(before), before.id)
      insert(ix, t, keyOf(after), after.id, after.order)
    } else if (after) {
      insert(ix, t, keyOf(after), after.id, after.order)
    } else if (before) {
      remove(ix, keyOf(before), before.id)
    }
  }
}

export function childrenSignal(ix: ChildrenIndex, key: ParentKey): Signal<readonly NodeId[]> {
  return listOf(ix, key)
}

/** Every descendant of `key`, depth first, parents before children. */
export function descendantsOf(ix: ChildrenIndex, key: ParentKey, out: NodeId[] = []): NodeId[] {
  const stack = [...(ix.lists.get(key)?.peek() ?? EMPTY)].reverse()
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    const kids = ix.lists.get(id)?.peek()
    if (kids?.length) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out
}
