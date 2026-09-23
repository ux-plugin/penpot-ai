/**
 * Inspector → Code tab. Shared by both modes.
 *
 * Emits React for the SELECTED component's subtree (the per-node slice), vs the
 * center PreviewStage which emits the whole-app source. Same emitter, narrower
 * `root`: the page's presentation tree is searched for the selected node and that
 * subtree is handed to emitReactComponent. With nothing selected it falls back
 * to the whole page so the tab is never blank.
 */

import { CodeBlock } from '../CodeBlock'
import { useMemo } from 'react'
import { computed } from '@preact/signals-core'
import { getActiveOrSinglePageId, getNode, useCurrentPageId, useRecord, useSignal } from '../../doc'
import { useSelectedIds } from '../../renderer/store/document-selection'
import { nodesToPresentation, findPNode } from '../../renderer/interactions/document/nodes-to-presentation'
import { emptyPageInteractions, type PageInteractions } from '../../renderer/interactions/ir'
import { emitReactComponent } from '../../renderer/interactions/compile/emit-react'

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
  const selectedIds = useSelectedIds()
  const currentPageId = useCurrentPageId()
  const pid = currentPageId ?? getActiveOrSinglePageId()
  const page = useRecord('page', pid)
  // A computed over the page's tree, so the code tracks every node edit.
  const full = useSignal(useMemo(() => computed(() => (pid ? nodesToPresentation(pid) : null)), [pid]))

  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const { code, scopeLabel } = useMemo(() => {
    if (!page || !full) return { code: '', scopeLabel: '' }
    const ir: PageInteractions = page.interactions ?? emptyPageInteractions()

    const scoped = singleId ? findPNode(full, singleId) : null
    const root = scoped ?? full
    const node = scoped ? getNode(singleId) : undefined
    const name = pascalCase(node?.name ?? page.name ?? '', 'Screen')
    try {
      return { code: emitReactComponent(ir, root, { componentName: name }), scopeLabel: scoped ? (node?.name ?? name) : 'whole page' }
    } catch (e) {
      return { code: '// Failed to generate code:\n// ' + (e instanceof Error ? e.message : String(e)), scopeLabel: '' }
    }
  }, [page, full, singleId])

  if (!code) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Nothing to show — add components in Design mode.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <CodeBlock code={code} label={scopeLabel || 'tsx'} className="min-h-0 flex-1" />
    </div>
  )
}
