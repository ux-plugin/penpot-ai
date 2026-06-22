import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Undo2, Redo2, FilePlus2, Settings } from 'lucide-react'
import { CanvasWrapper } from './lib/renderer/canvas-wrapper'
import { ShapeToolbar } from './lib/components/ShapeToolbar'
import { CursorHint } from './lib/components/CursorHint'
import { LayersPanel } from './lib/components/LayersPanel/LayersPanel'
import { RightSidePanel } from './lib/components/RightSidePanel/RightSidePanel'
import { createNewDocument, setDocument, undo, redo } from './lib/page-crud'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from './lib/renderer/store/workspace-store'
import { SettingsDialog } from './lib/components/Settings/SettingsDialog'
import { ActivityBar } from './lib/components/ActivityBar'
import { BuildWorkspace } from './lib/components/BuildWorkspace'
import { editorMode } from './lib/renderer/signals/editor-mode'
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

  // Auto-create a blank document on first load. We can't do this on plain
  // mount because the WASM renderer is initialised asynchronously inside
  // CanvasWorkspace — `loadDocument` only calls `renderer.initPage` once
  // `state.renderer` exists, so loading too early populates the model but
  // never paints (the canvas stays blank until you click "New document").
  // Wait for the renderer to come up, then load exactly once.
  const renderer = useWorkspaceStore((s) => s.renderer)
  const didLoadInitialDocument = useRef(false)
  useEffect(() => {
    if (!renderer || didLoadInitialDocument.current) return
    didLoadInitialDocument.current = true
    void setDocument(createNewDocument())
  }, [renderer])

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

  return (
    <div
      className="canvas-container relative font-sans [--activity-bar-width:3rem]"
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'var(--editor-canvas-chrome)' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <CanvasWrapper
          rendererOptions={rendererOptions}
          onError={handleError}
          containerStyle={{ width: '100%', height: '100%' }}
          overlays={
            <>
              <ActivityBar />
              {/* The inspector rail floats over both modes (z-50 > Build's z-40). */}
              <RightSidePanel />
{mode === 'design' ? (
                <>
                  <LayersPanel />
                  <ShapeToolbar />
                  <CursorHint />
                  <div
                    className="pointer-events-auto absolute top-3 z-10 flex gap-0.5 rounded-lg border border-border/80 bg-white p-1 shadow-md"
                    style={{ right: 'calc(0.75rem + var(--properties-panel-width, 280px) + 0.75rem)' }}
                    role="toolbar"
                    aria-label="Document actions"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="New document"
                      title="New document"
                      onClick={() => {
                        if (window.confirm('Start a new document? The current one will be discarded.')) {
                          void setDocument(createNewDocument())
                        }
                      }}
                    >
                      <FilePlus2 className="size-4" />
                    </Button>
                    <div className="mx-0.5 h-6 w-px self-center bg-border/70" aria-hidden />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="Undo"
                      title="Undo"
                      onClick={() => void undo()}
                    >
                      <Undo2 className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="Redo"
                      title="Redo"
                      onClick={() => void redo()}
                    >
                      <Redo2 className="size-4" />
                    </Button>
                    <div className="mx-0.5 h-6 w-px self-center bg-border/70" aria-hidden />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="Settings"
                      title="Settings"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings className="size-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <BuildWorkspace />
              )}
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
