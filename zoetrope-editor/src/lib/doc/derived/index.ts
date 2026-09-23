/**
 * Derived state over the live tables: indexes the reducer keeps current.
 * Callers read; nothing outside this directory builds an index.
 */
import type { Applied } from '../apply'
import type { NodeId, ParentKey } from '../ids'
import { tables } from '../store'
import { rebuildAll, updateAll } from './define'
import { childrenOf } from './children'

export { derived } from './define'
export type { Derived } from './define'
export { childrenOf, descendants } from './children'
export { readersOf, ownedBy, dangling, provideReaders } from './readers'
export type { Owned, Dangling } from './readers'
export { ofType } from './types'
export { rowsOf, countUnder } from './rows'
export type { Row } from './rows'

/** Ordered child ids. `key` is a node id, or a page id for its top level. Reactive. */
export function children(key: ParentKey): readonly NodeId[] {
  return childrenOf(key).value
}

export function rebuildDerived(): void {
  rebuildAll(tables)
}

export function updateDerived(applied: readonly Applied[]): void {
  updateAll(tables, applied)
}
