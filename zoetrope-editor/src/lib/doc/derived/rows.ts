/**
 * The rows a tree view shows: ids and depths, read from child lists only.
 * A computed over `rowsOf` reruns when the structure or the collapsed set
 * changes, never for a field edit; each row subscribes to its own record.
 * A collapsed subtree is not walked.
 */
import type { NodeId, ParentKey } from '../ids'
import { childrenOf } from './children'

export interface Row {
  id: NodeId
  depth: number
  hasChildren: boolean
}

export function rowsOf(key: ParentKey, isCollapsed: (id: NodeId) => boolean = () => false): Row[] {
  const out: Row[] = []
  const walk = (k: ParentKey, depth: number): void => {
    for (const id of childrenOf(k).value) {
      const kids = childrenOf(id).value
      out.push({ id, depth, hasChildren: kids.length > 0 })
      if (kids.length > 0 && !isCollapsed(id)) walk(id, depth + 1)
    }
  }
  walk(key, 0)
  return out
}

/** How many nodes sit under `key`, at any depth. */
export function countUnder(key: ParentKey): number {
  let n = 0
  const walk = (k: ParentKey): void => {
    for (const id of childrenOf(k).value) {
      n++
      walk(id)
    }
  }
  walk(key)
  return n
}
