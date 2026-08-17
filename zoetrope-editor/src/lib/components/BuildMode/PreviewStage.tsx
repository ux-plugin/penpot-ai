/**
 * Build-mode center stage — the live app preview and its generated code.
 *
 * Generalizes the Phase-1 demo harness off the hardcoded demo: it reads the
 * REAL current page, runs it through nodesToPresentation (document -> engine
 * presentation, the M0 adapter) plus the page's PageInteractions, then:
 *   - Preview tab: InteractionRuntime renders it as a live interactive React tree
 *   - Code tab:    emitReactComponent emits the whole-app React source
 *
 * Clicking an element in the preview selects its design node via the shared
 * selection store (the same one the component tree and Design mode use), so the
 * three stay in sync. Selection runs on the capture phase and does not
 * preventDefault, so any authored interaction still fires on the element.
 */

import { CodeBlock } from '../CodeBlock'
import { useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import type { IndexedPage } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { setSelectedIds } from '../../renderer/store/document-selection'
import { nodesToPresentation } from '../../renderer/interactions/document/nodes-to-presentation'
import { emptyPageInteractions, type PageInteractions } from '../../renderer/interactions/ir'
import { emitReactComponent } from '../../renderer/interactions/compile/emit-react'
import { InteractionRuntime } from '../../renderer/interactions/preview/InteractionRuntime'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Default theme for the preview's deterministic baseline elements. A shape's own
 * fill (carried by nodesToPresentation as an inline style) overrides these, and
 * AI-authored JSX will replace them entirely later — this just keeps the bare
 * baseline from looking like raw HTML.
 */
const PREVIEW_CSS = `
[data-preview-root] { color: #1f2937; font: 14px/1.5 system-ui, -apple-system, sans-serif; }
[data-preview-root] > div { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
[data-preview-root] button { background: #4f46e5; color: #fff; border: 0; padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 500; cursor: pointer; }
[data-preview-root] button:hover { filter: brightness(0.93); }
[data-preview-root] button:disabled { opacity: 0.5; cursor: not-allowed; }
[data-preview-root] ul { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 6px; }
[data-preview-root] li { background: #f3f4f6; padding: 8px 12px; border-radius: 6px; }
[data-preview-root] input { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }
[data-preview-root] h1, [data-preview-root] h2 { margin: 0; font-weight: 600; }
[data-preview-root] a { color: #4f46e5; }
`

/** Turn a page name into a valid PascalCase React component identifier. */
function componentNameFor(page: IndexedPage | undefined): string {
  const pascal = (page?.name ?? '')
    .replace(/[^A-Za-z0-9]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return /^[A-Za-z]/.test(pascal) ? pascal : 'Screen'
}

export function PreviewStage() {
  const doc = useSnapshot(docProxy)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = (pid ? doc.pageMap.get(pid) : undefined) as IndexedPage | undefined

  const root = useMemo(() => (page ? nodesToPresentation(page) : null), [page])
  const ir: PageInteractions = useMemo(() => page?.interactions ?? emptyPageInteractions(), [page])
  const name = useMemo(() => componentNameFor(page), [page])
  const code = useMemo(() => {
    if (!root) return ''
    try {
      return emitReactComponent(ir, root, { componentName: name })
    } catch (e) {
      return '// Failed to generate code:\n// ' + (e instanceof Error ? e.message : String(e))
    }
  }, [ir, root, name])

  // Re-seed the runtime store when the variable SET changes (add/remove), so newly
  // authored state shows up live. Trigger/action/binding edits are picked up
  // without a reset, so they don't appear here.
  const runtimeKey = ir.variables.map((v) => v.id).join('|')

  const onPreviewClickCapture = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-node-id]')
    const id = el?.getAttribute('data-node-id')
    if (id && id !== ROOT_UUID) setSelectedIds(new Set([id]))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-transparent">
      <div className="flex shrink-0 items-center gap-1 px-3 py-3">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Build view">
          {(['preview', 'code'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                tab === t ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!root ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            Nothing to preview yet — add components in Design mode.
          </div>
        ) : tab === 'preview' ? (
          <div className="flex justify-center p-8">
            <style>{PREVIEW_CSS}</style>
            <div
              className="min-h-40 min-w-80 rounded-lg border border-border bg-white p-6 text-sm text-foreground shadow-sm"
              onClickCapture={onPreviewClickCapture}
              data-preview-root
            >
              <InteractionRuntime key={runtimeKey} ir={ir} root={root} />
            </div>
          </div>
        ) : (
          <div className="h-full p-4">
            <CodeBlock code={code} className="h-full" />
          </div>
        )}
      </div>
    </div>
  )
}
