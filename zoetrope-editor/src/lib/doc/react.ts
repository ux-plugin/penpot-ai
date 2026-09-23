/** Reading the document from React. Each hook subscribes to one signal. */
import { useSyncExternalStore } from 'react'
import type { ReadonlySignal } from '@preact/signals-core'
import { childrenOf } from './derived'
import type { NodeId, PageId, ParentKey } from './ids'
import { meta } from './meta'
import type { Kind, RecordOf } from './schema'
import { currentPageId, field, sig, tables } from './store'

export function useSignal<T>(s: ReadonlySignal<T>): T {
  return useSyncExternalStore(
    (onChange) => s.subscribe(() => onChange()),
    () => s.peek(),
    () => s.peek(),
  )
}

export function useRecord<K extends Kind>(kind: K, id: string | null | undefined): RecordOf<K> | undefined {
  const s = id ? sig(kind, id) : undefined
  return useSyncExternalStore(
    (onChange) => {
      const off = s?.subscribe(() => onChange())
      const offRev = tables[kind].rev.subscribe(() => onChange())
      return () => {
        off?.()
        offRev()
      }
    },
    () => (id ? sig(kind, id)?.peek() : undefined),
    () => (id ? sig(kind, id)?.peek() : undefined),
  )
}

export function useNode(id: NodeId | null | undefined) {
  return useRecord('node', id)
}

export function useField<K extends Kind, F extends keyof RecordOf<K>>(
  kind: K,
  id: string | null | undefined,
  key: F,
): RecordOf<K>[F] | undefined {
  const s = id ? field(kind, id, key) : undefined
  return useSyncExternalStore(
    (onChange) => (s ? s.subscribe(() => onChange()) : () => {}),
    () => s?.peek(),
    () => s?.peek(),
  )
}

export function useChildren(key: ParentKey | null | undefined): readonly NodeId[] {
  const s = key ? childrenOf(key) : undefined
  return useSyncExternalStore(
    (onChange) => (s ? s.subscribe(() => onChange()) : () => {}),
    () => s?.peek() ?? EMPTY,
    () => s?.peek() ?? EMPTY,
  )
}

const EMPTY: readonly NodeId[] = Object.freeze([])

export function useCurrentPageId(): PageId | null {
  return useSignal(currentPageId)
}

export function useMeta() {
  return useSignal(meta)
}

/** Re-render when any record of `kind` is added or removed. */
export function useMembership(kind: Kind): number {
  return useSignal(tables[kind].rev)
}
