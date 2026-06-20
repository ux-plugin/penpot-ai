/**
 * Build-mode Parameters tab — a compact, read-only summary of the selected
 * component's design props (name, type, position, size).
 *
 * Geometry/style editing stays in Design mode (full RightSidePanel); Build mode
 * is about behavior, so here Parameters is read-only. Same selection store, so
 * it tracks whatever is selected in the tree or preview.
 */

import { useMemo } from 'react'
import { useSnapshot } from 'valtio'
import type { IndexedShape } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs text-foreground">{value}</span>
    </div>
  )
}

function num(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '—'
}

export function ReadOnlyParameters() {
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = pid ? doc.pageMap.get(pid) : undefined
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const node = singleId ? (page?.objects[singleId] as IndexedShape | undefined) : undefined

  if (!node || singleId === ROOT_UUID) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {selectedIds.size > 1 ? 'Select one component.' : 'Select a component to view its parameters.'}
      </div>
    )
  }

  const n = node as IndexedShape & { x?: number; y?: number; width?: number; height?: number }
  return (
    <div className="p-3">
      <div className="mb-2 border-b border-border pb-2">
        <div className="truncate text-sm font-medium text-foreground">{node.name ?? 'Component'}</div>
        <div className="text-xs text-muted-foreground">{node.type}</div>
      </div>
      <Row label="X" value={num(n.x)} />
      <Row label="Y" value={num(n.y)} />
      <Row label="Width" value={num(n.width)} />
      <Row label="Height" value={num(n.height)} />
    </div>
  )
}
