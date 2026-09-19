import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useFontReconnect } from '@/lib/renderer/api/font-reconnect'
import { CanvasWrapper } from './lib/renderer/canvas-wrapper'
import { ShapeToolbar } from './lib/components/ShapeToolbar'
import { CursorHint } from './lib/components/CursorHint'
import { ShaderDragOverlay } from './lib/components/Overlay/ShaderDragOverlay'
import { ComponentDragOverlay } from './lib/components/Overlay/ComponentDragOverlay'
import { DevJournalPanel } from './lib/components/DevJournalPanel'
import { LayersPanel } from './lib/components/LayersPanel/LayersPanel'
import { RightSidePanel } from './lib/components/RightSidePanel/RightSidePanel'
import { undo, redo } from './lib/page-crud'
import {
  activeDocumentId,
  getPersistenceProvider,
  openDocument,
  startDocumentAutosave,
} from './lib/persistence'
import { navigate, route, startRouting } from './lib/routing/route'
import { DocumentsHome } from './lib/components/DocumentsHome/DocumentsHome'
import { useWorkspaceStore } from './lib/renderer/store/workspace-store'
import { SettingsDialog } from './lib/components/Settings/SettingsDialog'
import { TopBar } from './lib/components/TopBar'
import { TimelinePanel } from './lib/components/Motion/TimelinePanel'
import { ComponentTree } from './lib/components/BuildMode/ComponentTree'
import { ChatPanel } from './lib/components/BuildMode/ChatPanel'
import { StoresPanel } from './lib/components/BuildMode/StoresPanel'
import { PreviewStage } from './lib/components/BuildMode/PreviewStage'
import { inspectorTab } from './lib/renderer/signals/inspector-tab'
import { editorMode } from './lib/renderer/signals/editor-mode'
import { focusStage } from './lib/renderer/signals/focus-stage'
import { FocusStage } from './lib/components/FocusStage/FocusStage'
import { useSignalCoalesced } from './lib/renderer/signals/use-signal-coalesced'
import { useSignalValue } from './lib/renderer/signals/use-signal-value'

/**
 * Read the initial value of the render-wasm cache PiP debug overlay
 * from the URL: `?debugPip=1` enables it on first init. Toggle at
 * runtime with Shift+P. Returns false unconditionally in production
 * builds so the entire feature drops out of the bundle.
 */
function readDebugPipFromUrl(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  const v = new URLSearchParams(window.location.search).get('debugPip')
  return v === '1' || v === 'true'
}

/**
 * `?seed=showcase` (dev only): after the initial document loads, materialise the
 * render-core showcase fixture as real, editable shapes so classic (WebGPU) and
 * hybrid (WebGL2) vello can be A/B-compared on identical content. Drops out of
 * production builds entirely.
 */
function readSeedFromUrl(): string | null {
  if (!import.meta.env.DEV) return null
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('seed')
}

const BUILD_TABS = [
  { id: 'components', label: 'Components' },
  { id: 'data', label: 'Data' },
  { id: 'chat', label: 'Chat' },
] as const
type BuildTab = (typeof BUILD_TABS)[number]['id']

/** Build-mode left rail: Components, Data (stores) and Chat as tabs (mirrors the Design rail's tab bar). */
function BuildLeftRail() {
  const [tab, setTab] = useState<BuildTab>('chat')
  return (
    <div className="pointer-events-auto flex h-full w-full min-h-0 flex-col overflow-hidden border-r border-border bg-white">
      <div
        role="tablist"
        aria-label="Build rail"
        className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
      >
        {BUILD_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors ' +
              (tab === t.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'components' ? (
          <div className="h-full overflow-auto">
            <ComponentTree />
          </div>
        ) : tab === 'data' ? (
          <div className="h-full overflow-auto">
            <StoresPanel />
          </div>
        ) : (
          <ChatPanel />
        )}
      </div>
    </div>
  )
}

/** The editor shell: top bar, canvas, rails. Mounted once the first document is
 *  opened and then kept mounted — see `App` below for why. */
function Editor() {
  const mode = useSignalCoalesced(editorMode)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // PiP cache overlay is a dev-only feature. In production, `DEV` is
  // statically false → esbuild folds the state, options field and the
  // keyboard handler / pill below out of the bundle.
  const [debugPip, setDebugPip] = useState<boolean>(() => readDebugPipFromUrl())
  const rendererOptions = useMemo(
    () => (import.meta.env.DEV ? { debug: false, debugPip } : { debug: false }),
    [debugPip]
  )

  const handleError = useCallback((err: Error) => {
    setError(err.message)
    console.error('Error:', err)
  }, [])

  // Load whichever document the URL names. We can't do this on plain mount
  // because the WASM renderer is initialised asynchronously inside CanvasWorkspace
  // — `loadDocument` only calls `renderer.initPage` once `state.renderer` exists,
  // so loading too early populates the model but never paints. Wait for the
  // renderer, then open the routed document; re-runs when the route names a
  // different one. A document that no longer exists sends you home with a notice
  // rather than leaving a blank canvas behind a dead URL.
  const renderer = useWorkspaceStore((s) => s.renderer)
  const currentRoute = useSignalValue(route)
  const loadedIdRef = useRef<string | null>(null)
  const autosaveDisposeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!renderer || currentRoute?.kind !== 'doc') return
    const { id } = currentRoute
    if (loadedIdRef.current === id) return
    loadedIdRef.current = id
    void (async () => {
      if (import.meta.env.DEV) console.debug(`[boot] renderer up at ${Math.round(performance.now())}ms`)
      if (!(await openDocument(id))) {
        loadedIdRef.current = null
        navigate(
          { kind: 'home' },
          { replace: true, notice: `That document no longer exists (${id}).` },
        )
        return
      }
      if (import.meta.env.DEV) console.debug(`[boot] document ${id} loaded at ${Math.round(performance.now())}ms`)
      if (import.meta.env.DEV && readSeedFromUrl() === 'showcase') {
        const { seedShowcaseDocument } = await import('./lib/dev/seed-showcase')
        await seedShowcaseDocument()
        console.debug(`[boot] showcase seeded at ${Math.round(performance.now())}ms`)
      }
      autosaveDisposeRef.current ??= startDocumentAutosave(getPersistenceProvider())
    })()
  }, [renderer, currentRoute])

  useEffect(
    () => () => {
      autosaveDisposeRef.current?.()
      autosaveDisposeRef.current = null
    },
    [],
  )

  // Once back online, retry any fonts that fell back to the default while offline.
  useFontReconnect()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The documents screen renders *over* a still-mounted editor, so without
      // this Cmd+Z on the list would undo an edit on the canvas underneath.
      if (route.peek().kind !== 'doc') return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      const mod = e.metaKey || e.ctrlKey
      // No focus branching here any more: `undo`/`redo` resolve the active lens
      // from the open scope themselves, so this and the toolbar buttons cannot
      // disagree about what Cmd+Z means. Cmd+Z inside the SkSL editor never
      // reaches here — the input guard above lets CodeMirror's native text-undo
      // handle it — so this is Cmd+Z on the surrounding chrome.
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        void undo()
      } else if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        void redo()
      } else if (
        import.meta.env.DEV &&
        e.shiftKey && (e.key === 'P' || e.key === 'p') && !mod
      ) {
        // Shift+P toggles the render-wasm PiP cache overlay live (no
        // re-init). Wrapped in `DEV` so the handler and the call into
        // `setDebugPip` get stripped from production bundles.
        e.preventDefault()
        setDebugPip(prev => {
          const next = !prev
          const renderer = useWorkspaceStore.getState().renderer
          renderer?.setDebugPip(next)
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tab = useSignalCoalesced(inspectorTab)
  const motionActive = tab === 'motion'
  // A focus stage (e.g. shader authoring) temporarily claims the center region
  // and may rebind rails; when none is active the shell composes as usual.
  const focus = useSignalCoalesced(focusStage)
  const startSlot = focus?.left ?? (mode === 'design' ? <LayersPanel /> : <BuildLeftRail />)
  const endSlot = focus?.right ?? <RightSidePanel />
  const bottomSlot = focus?.bottom ?? (motionActive ? <TimelinePanel /> : undefined)
  const baseCenter =
    mode === 'design' ? (
      <ShapeToolbar />
    ) : (
      <div
        className="pointer-events-auto flex h-full w-full"
        style={{ background: 'var(--editor-canvas-chrome)' }}
      >
        <PreviewStage />
      </div>
    )
  // A focus session with its own `center` (shader) fully claims the region. One
  // that declares none (3D edit) contributes ONLY the shared header — the shell
  // keeps its normal center (ShapeToolbar, where the 3D edit toolbar lives) below
  // it, so 3D's chrome stays exactly as it was.
  const centerOverlay = !focus ? (
    baseCenter
  ) : focus.center !== undefined ? (
    <FocusStage session={focus} />
  ) : (
    <>
      <FocusStage session={focus} />
      {baseCenter}
    </>
  )

  return (
    <div
      className="canvas-container relative font-sans [--top-bar-height:2.75rem]"
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'var(--editor-canvas-chrome)' }}
    >
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <div style={{ position: 'absolute', top: 'var(--top-bar-height)', left: 0, right: 0, bottom: 0 }}>
        <CanvasWrapper
          rendererOptions={rendererOptions}
          onError={handleError}
          containerStyle={{ width: '100%', height: '100%' }}
          startSlot={startSlot}
          endSlot={endSlot}
          bottomSlot={bottomSlot}
          centerOverlay={centerOverlay}
          overlays={
            <>
              {mode === 'design' && <CursorHint />}
              <ShaderDragOverlay />
              <ComponentDragOverlay />
              {import.meta.env.DEV && <DevJournalPanel />}
              <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
              {error && (
                <div
                  className="pointer-events-auto fixed bottom-24 left-1/2 z-70 max-w-lg -translate-x-1/2 rounded-lg border border-destructive/40 bg-destructive/15 px-4 py-2 text-sm text-destructive shadow-lg backdrop-blur-sm"
                  role="alert"
                >
                  <span className="font-medium">Error:</span> {error}
                  <button
                    type="button"
                    className="ml-3 rounded text-xs underline"
                    onClick={() => setError(null)}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </>
          }
        />
      </div>
    </div>
  )
}

/**
 * The route switch.
 *
 * The editor is lazy-mounted on the first document open and then never
 * unmounted: unmounting would tear down and re-initialise the WASM renderer on
 * every trip home, while mounting it up-front would pay that cost just to browse
 * a list.
 *
 * It's hidden with `visibility`, not by stacking the documents screen over it.
 * Stacking doesn't work — the editor's chrome (top bar, tool bar, overlays) is
 * `position: fixed` with a higher z-index, so it escapes any covering layer and
 * paints over the list. `visibility: hidden` hides the whole subtree including
 * those fixed children, and blocks pointer events, while *keeping layout* — so
 * the canvas holds its size and the GL surface never sees a resize.
 */
function App() {
  const currentRoute = useSignalValue(route)
  // "A document is, or has been, open." Navigating home doesn't clear
  // `activeDocumentId`, so this latches on its own — no effect, no extra state.
  const openId = useSignalValue(activeDocumentId)
  const editorMounted = currentRoute?.kind === 'doc' || openId !== null
  const editorVisible = currentRoute?.kind === 'doc'

  useEffect(() => startRouting(), [])

  return (
    <>
      {editorMounted && (
        <div
          style={{ visibility: editorVisible ? 'visible' : 'hidden' }}
          aria-hidden={!editorVisible}
        >
          <Editor />
        </div>
      )}
      {!editorVisible && <DocumentsHome />}
    </>
  )
}

export default App
