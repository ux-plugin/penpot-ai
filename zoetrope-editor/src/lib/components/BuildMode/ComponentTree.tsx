/**
 * Build-mode component tree — the document's shape hierarchy shown as the list
 * of buildable components.
 *
 * Reuses the same data path as the Design-mode LayersPanel (docProxy +
 * orderedNodesWithDepth) and the same shared selection store, so selecting a
 * component here and a layer there stay in sync — one document, two views.
 *
 * Selection/navigation only: reparenting is a design-time concern, so unlike
 * LayerRow this has no drag handlers.
 */

import { useCallback, useMemo } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { IndexedPage } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { setSelectedIds } from '../../renderer/store/document-selection'
import { orderedNodesWithDepth } from '../../renderer/store/ordered-page-nodes'
import { ShapeIcon } from '../shape-icons'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

export function ComponentTree() {
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page: IndexedPage | undefined = pid ? doc.pageMap.get(pid) : undefined

  const components = useMemo(() => {
    if (!page) return []
    return orderedNodesWithDepth(page).filter(({ node }) => node.id !== ROOT_UUID)
  }, [page])

  const onSelect = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Components
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {!page && <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>}
          {page && components.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No components yet</p>
          )}
          {components.length > 0 && (
            <ul className="list-none space-y-0.5 p-0">
              {components.map(({ node, depth }) => {
                const active = selectedIds.has(node.id)
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(node.id)}
                      aria-selected={active}
                      data-component-id={node.id}
                      className={cn(
                        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
                        active ? 'bg-muted/80 text-foreground' : 'text-foreground hover:bg-muted/60',
                      )}
                      style={{ paddingLeft: 8 + depth * 12 }}
                    >
                      <ShapeIcon type={node.type} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{node.name ?? 'Component'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
