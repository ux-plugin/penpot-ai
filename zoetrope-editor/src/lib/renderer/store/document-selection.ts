/**
 * The selection: ephemeral, one signal holding a frozen set. Setting it
 * re-queries the WASM selection rect.
 */
import { signal } from '@preact/signals-core'
import { movePreviewWorldDelta, rotatePreviewDeltaDeg } from '../signals/pointer'
import { querySelectionRect, selectionRect, wasmSelectionRect } from '../signals/selection'
import { useWorkspaceStore } from './workspace-store'
import { useSignal } from '../../doc/react'

const EMPTY: ReadonlySet<string> = new Set()

export const selectedIds = signal<ReadonlySet<string>>(EMPTY)

function syncSelectionDerived(): void {
  const ids = selectedIds.peek()
  const renderer = useWorkspaceStore.getState().renderer
  if (ids.size === 0 || !renderer) {
    wasmSelectionRect.value = null
  } else {
    wasmSelectionRect.value = querySelectionRect(renderer, ids)
  }
}

export function setSelectedIds(ids: Iterable<string>): void {
  selectedIds.value = new Set(ids)
  syncSelectionDerived()
}

export function clearSelection(): void {
  selectedIds.value = EMPTY
  rotatePreviewDeltaDeg.value = 0
  movePreviewWorldDelta.value = { x: 0, y: 0 }
  wasmSelectionRect.value = null
  selectionRect.value = null
}

/** A mutable copy. */
export function getSelectedIdsSet(): Set<string> {
  return new Set(selectedIds.peek())
}

export function isSelected(id: string): boolean {
  return selectedIds.peek().has(id)
}

export function useSelectedIds(): ReadonlySet<string> {
  return useSignal(selectedIds)
}
