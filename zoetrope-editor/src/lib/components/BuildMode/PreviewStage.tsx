/**
 * Build-mode center stage — the live app preview and its generated code.
 *
 * Generalizes the Phase-1 demo harness off the hardcoded demo: it reads the
 * REAL current page, runs it through nodesToPresentation (document -> engine
 * presentation, the M0 adapter) plus the page's PageInteractions, then:
 *   - Preview tab: InteractionRuntime renders it as a live interactive React tree
 *   - Code tab:    emitReactComponent emits the whole-app React source
 *
 * The stage is scoped BY selection: it renders the selected node and its
 * children, with no whole-page fallback — you see what a component contains by
 * selecting it. Selection comes from the component tree (or Design mode) via the
 * shared store, so all three surfaces stay in sync.
 *
 * Clicks inside the preview go to the APP, not to selection: the preview is a
 * running prototype, so a click fires whatever interaction is authored on that
 * element. Alt/Option-click is the inspect gesture — it selects and swallows the
 * event, so inspecting a button never also triggers it.
 */

import { CodeBlock } from '../CodeBlock'
import { useCallback, useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import type { IndexedPage } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { setSelectedIds } from '../../renderer/store/document-selection'
import { nodesToPresentation, findPNode } from '../../renderer/interactions/document/nodes-to-presentation'
import { emptyPageInteractions, type PageInteractions } from '../../renderer/interactions/ir'
import { emitReactComponent } from '../../renderer/interactions/compile/emit-react'
import { InteractionRuntime } from '../../renderer/interactions/preview/InteractionRuntime'
import {
  buildEnv,
  pushActivity,
  type LoggedActivity,
  type RuntimeState,
  type ActivityEntry,
} from '../../renderer/interactions/preview/runtime'
import { StatePanel } from './StatePanel'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * The preview surface contributes NOTHING visual. Appearance comes from the
 * design alone (via PNode.style) and the browser's own defaults are neutralized
 * per role by `resetFor` — this used to be a hardcoded theme (indigo buttons,
 * grey list rows) that made every preview look like a web page rather than like
 * the file it came from.
 */
const PREVIEW_CSS = `
[data-preview-root] { font: inherit; color: inherit; }
`

/** Turn a layer or page name into a valid PascalCase React component identifier. */
function componentNameFor(raw: string | undefined): string {
  const pascal = (raw ?? '')
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

  const full = useMemo(() => (page ? nodesToPresentation(page) : null), [page])
  const ir: PageInteractions = useMemo(() => page?.interactions ?? emptyPageInteractions(), [page])

  // Selection DRIVES the stage: you see a component's contents by selecting it.
  // There is no whole-page fallback — with nothing (or several things) selected
  // the stage stays empty and says so, rather than quietly showing the page.
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])
  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const root = useMemo(
    () => (full && selectedId ? findPNode(full, selectedId) : null),
    [full, selectedId],
  )

  const selectedShape = selectedId ? page?.objects[selectedId] : undefined
  const scopeName = root ? (selectedShape?.name ?? 'selection') : null
  // Parent to step back out to. The root frame isn't offered — it IS the page,
  // and "select the page" is what the empty state already covers.
  const parentId = selectedShape?.parentId
  const parent = parentId && parentId !== ROOT_UUID ? page?.objects[parentId] : undefined

  /** Why the stage is empty — a selection prompt, not a "nothing here" dead end. */
  const emptyReason = !full
    ? 'Nothing to preview yet — add components in Design mode.'
    : selectedIds.size > 1
      ? 'Several components selected — pick one to see what it contains.'
      : !selectedId
        ? 'Select a component to see what it contains.'
        : 'That selection has nothing to render — pick a frame or shape on this page.'

  // The emitted component takes the SELECTED layer's name — selecting "Card"
  // should produce `export function Card()`, not the page name.
  const name = componentNameFor(selectedShape?.name ?? page?.name)
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
  // without a reset, so they don't appear here. Scope changes re-seed too —
  // carrying a half-mutated store into a different subtree reads as a glitch.
  const runtimeKey = `${root?.nodeId ?? ''}::${ir.variables.map((v) => v.id).join('|')}`

  // Live runtime observation for the state panel. `onRuntime` fires from an
  // effect inside the runtime, so these setStates are safe.
  const [panelOpen, setPanelOpen] = useState(false)
  const [rt, setRt] = useState<RuntimeState | null>(null)
  const [log, setLog] = useState<LoggedActivity[]>([])
  const onRuntime = useCallback((next: RuntimeState, activity: ActivityEntry | null) => {
    setRt(next)
    // A null activity means the runtime just mounted — which, thanks to
    // `key={runtimeKey}`, is exactly when the scope changed. Clearing here keeps
    // the feed describing what you're actually looking at, without the parent
    // needing an effect to watch the key.
    setLog((cur) => (activity ? pushActivity(cur, activity) : []))
  }, [])

  const env = useMemo(() => (rt ? buildEnv(ir, rt) : {}), [ir, rt])

  const inView = useCallback((nodeId: string) => !!root && !!findPNode(root, nodeId), [root])
  const nameOf = useCallback(
    (nodeId: string) => page?.objects[nodeId]?.name ?? nodeId.slice(0, 8),
    [page],
  )

  /**
   * The preview is a RUNNING app, so a plain click belongs to the app: it falls
   * through to whatever interaction is authored on that element. Selecting is
   * the deliberate act — Alt/Option-click — and it swallows the event so
   * inspecting a button never also fires it. Layer selection otherwise comes
   * from the component tree, which is always visible beside the stage.
   */
  const onPreviewClickCapture = (e: React.MouseEvent) => {
    if (!e.altKey) return
    const el = (e.target as HTMLElement).closest('[data-node-id]')
    const id = el?.getAttribute('data-node-id')
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedIds(new Set([id]))
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

        {/* Scope breadcrumb. Clicking inside the preview selects — and therefore
            narrows — so stepping back out to the parent has to be one click. */}
        {scopeName && (
          <div className="ml-2 flex min-w-0 items-center gap-2 text-xs">
            {parent && (
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={`Select ${parent.name ?? 'parent'}`}
                onClick={() => setSelectedIds(new Set([parent.id]))}
              >
                ↑ {parent.name ?? 'Parent'}
              </button>
            )}
            <span className="truncate text-muted-foreground">
              Showing <span className="font-medium text-foreground">{scopeName}</span>
            </span>
          </div>
        )}

        {/* The inspect gesture is invisible otherwise — clicks go to the app. */}
        {tab === 'preview' && root && (
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">⌥-click to select</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!root ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {emptyReason}
          </div>
        ) : tab === 'preview' ? (
          <div className="flex justify-center p-8">
            <style>{PREVIEW_CSS}</style>
            <div
              className="min-h-40 min-w-80 rounded-lg border border-border bg-white p-6 text-sm text-foreground shadow-sm"
              onClickCapture={onPreviewClickCapture}
              data-preview-root
            >
              <InteractionRuntime key={runtimeKey} ir={ir} root={root} onRuntime={onRuntime} />
            </div>
          </div>
        ) : (
          <div className="h-full p-4">
            <CodeBlock code={code} className="h-full" />
          </div>
        )}
      </div>

      {/* An action's effect can land outside the scoped subtree; this is where
          you see that it happened at all. */}
      {root && tab === 'preview' && (
        <StatePanel
          ir={ir}
          env={env}
          log={log}
          open={panelOpen}
          onToggle={() => setPanelOpen((o) => !o)}
          inView={inView}
          nameOf={nameOf}
          onSelect={(id) => setSelectedIds(new Set([id]))}
        />
      )}
    </div>
  )
}
