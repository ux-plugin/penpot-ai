/**
 * Inspector → Code tab. Shared by both modes.
 *
 * Emits React for the SELECTED component's subtree (the per-node slice), vs the
 * center PreviewStage which emits the whole-app source. Same emitter, narrower
 * `root`: nodesToPresentation(page) is searched for the selected node and that
 * subtree is handed to emitReactComponent. With nothing selected it falls back
 * to the whole page so the tab is never blank.
 */

import { useMemo } from 'react'
import { useSnapshot } from 'valtio'
import type { IndexedPage } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { nodesToPresentation } from '../../renderer/interactions/document/nodes-to-presentation'
import { emptyPageInteractions, type PageInteractions } from '../../renderer/interactions/ir'
import { emitReactComponent, type PNode } from '../../renderer/interactions/compile/emit-react'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

function findPNode(node: PNode, id: string): PNode | null {
  if (node.nodeId === id) return node
  for (const c of node.children ?? []) {
    const found = findPNode(c, id)
    if (found) return found
  }
  return null
}

function pascalCase(raw: string, fallback: string): string {
  const p = raw
    .replace(/[^A-Za-z0-9]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return /^[A-Za-z]/.test(p) ? p : fallback
}

export function CodeTab() {
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = (pid ? doc.pageMap.get(pid) : undefined) as IndexedPage | undefined

  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const { code, scopeLabel } = useMemo(() => {
    if (!page) return { code: '', scopeLabel: '' }
    const full = nodesToPresentation(page)
    if (!full) return { code: '', scopeLabel: '' }
    const ir: PageInteractions = page.interactions ?? emptyPageInteractions()

    const scoped = singleId && singleId !== ROOT_UUID ? findPNode(full, singleId) : null
    const root = scoped ?? full
    const node = scoped ? page.objects[singleId as string] : undefined
    const name = pascalCase(node?.name ?? page.name ?? '', 'Screen')
    try {
      return { code: emitReactComponent(ir, root, { componentName: name }), scopeLabel: scoped ? (node?.name ?? name) : 'whole page' }
    } catch (e) {
      return { code: '// Failed to generate code:\n// ' + (e instanceof Error ? e.message : String(e)), scopeLabel: '' }
    }
  }, [page, singleId])

  if (!code) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Nothing to show — add components in Design mode.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {scopeLabel ? `Scope: ${scopeLabel}` : ''}
      </div>
      <pre
        className="m-0 min-h-0 flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-foreground"
        style={{ fontFamily: 'ui-monospace, monospace' }}
      >
        {code}
      </pre>
    </div>
  )
}
