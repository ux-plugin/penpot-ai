import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useFontReconnect } from '@/lib/renderer/api/font-reconnect'
import { CanvasWrapper } from './lib/renderer/canvas-wrapper'
import { ShapeToolbar } from './lib/components/ShapeToolbar'
import { CursorHint } from './lib/components/CursorHint'
import { LayersPanel } from './lib/components/LayersPanel/LayersPanel'
import { RightSidePanel } from './lib/components/RightSidePanel/RightSidePanel'
import { undo, redo } from './lib/page-crud'
import { getPersistenceProvider, loadInitialDocument, startDocumentAutosave } from './lib/persistence'
import { useWorkspaceStore } from './lib/renderer/store/workspace-store'
import { SettingsDialog } from './lib/components/Settings/SettingsDialog'
import { TopBar } from './lib/components/TopBar'
import { TimelinePanel } from './lib/components/Motion/TimelinePanel'
import { ComponentTree } from './lib/components/BuildMode/ComponentTree'
import { ChatPanel } from './lib/components/BuildMode/ChatPanel'
import { PreviewStage } from './lib/components/BuildMode/PreviewStage'
import { inspectorTab } from './lib/renderer/signals/inspector-tab'
import { editorMode } from './lib/renderer/signals/editor-mode'
import { focusStage } from './lib/renderer/signals/focus-stage'
import { FocusStage } from './lib/components/FocusStage/FocusStage'
import { useSignalCoalesced } from './lib/renderer/signals/use-signal-coalesced'

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

/** Build-mode left rail: live component tree above the chat panel. */
function BuildLeftRail() {
  return (
    <div className="pointer-events-auto flex h-full w-full min-h-0 flex-col overflow-hidden border-r border-border bg-white">
      <div className="min-h-0 flex-1 overflow-auto">
        <ComponentTree />
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-border">
        <ChatPanel />
      </div>
    </div>
  )
}

function App() {
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

  // Load the initial document on first render. We can't do this on plain mount
  // because the WASM renderer is initialised asynchronously inside CanvasWorkspace
  // — `loadDocument` only calls `renderer.initPage` once `state.renderer` exists,
  // so loading too early populates the model but never paints. Wait for the
  // renderer to come up, then load exactly once: the persisted document if the
  // environment can restore one (capability-gated), else a blank document. Once
  // loaded, start the debounced autosave (a no-op when the provider can't persist).
  const renderer = useWorkspaceStore((s) => s.renderer)
  const didLoadInitialDocument = useRef(false)
  const autosaveDisposeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!renderer || didLoadInitialDocument.current) return
    didLoadInitialDocument.current = true
    void (async () => {
      await loadInitialDocument()
      autosaveDisposeRef.current = startDocumentAutosave(getPersistenceProvider())
    })()
    return () => {
      autosaveDisposeRef.current?.()
      autosaveDisposeRef.current = null
    }
  }, [renderer])

  // Once back online, retry any fonts that fell back to the default while offline.
  useFontReconnect()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      const mod = e.metaKey || e.ctrlKey
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
  const centerOverlay = focus ? (
    <FocusStage session={focus} />
  ) : mode === 'design' ? (
    <ShapeToolbar />
  ) : (
    <div
      className="pointer-events-auto flex h-full w-full"
      style={{ background: 'var(--editor-canvas-chrome)' }}
    >
      <PreviewStage />
    </div>
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

export default App
