/**
 * Derived state over the live tables: caches the reducer keeps current.
 * Callers read; nothing outside this directory builds an index.
 */
import type { Signal } from '@preact/signals-core'
import type { Applied } from '../apply'
import type { NodeId, ParentKey } from '../ids'
import { tables } from '../store'
import {
  childrenSignal,
  createChildrenIndex,
  descendantsOf as descendantsIn,
  rebuildChildren,
  updateChildren,
} from './children'

const childrenIndex = createChildrenIndex()

/** Ordered child ids. `key` is a node id, or a page id for its top level. */
export function childrenOf(key: ParentKey): Signal<readonly NodeId[]> {
  return childrenSignal(childrenIndex, key)
}

export function children(key: ParentKey): readonly NodeId[] {
  return childrenOf(key).value
}

/** Descendants of `key`, parents before children. */
export function descendants(key: ParentKey): NodeId[] {
  return descendantsIn(childrenIndex, key)
}

export function rebuildDerived(): void {
  rebuildChildren(childrenIndex, tables)
}

export function updateDerived(applied: readonly Applied[]): void {
  updateChildren(childrenIndex, tables, applied)
}
