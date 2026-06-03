import { useState, useCallback, useMemo, useEffect } from 'react'
import { Undo2, Redo2, FilePlus } from 'lucide-react'
import { CanvasWrapper } from './lib/renderer/canvas-wrapper'
import { ShapeToolbar } from './lib/components/ShapeToolbar'
import { LayersPanel } from './lib/components/LayersPanel/LayersPanel'
import { RightSidePanel } from './lib/components/RightSidePanel/RightSidePanel'
import { createNewDocument, setDocument, undo, redo } from './lib/page-crud'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from './lib/renderer/store/workspace-store'

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
  const [error, setError] = useState<string | null>(null)
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

  useEffect(() => {
    void setDocument(createNewDocument())
  }, [])

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
      className="canvas-container relative font-sans"
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'var(--editor-canvas-chrome)' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <CanvasWrapper
          rendererOptions={rendererOptions}
          onError={handleError}
          containerStyle={{ cursor: 'crosshair', width: '100%', height: '100%' }}
          overlays={
            <>
              <LayersPanel />
              <RightSidePanel />
              <ShapeToolbar />
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
                  onClick={() => void setDocument(createNewDocument())}
                >
                  <FilePlus className="size-4" />
                </Button>
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
              </div>
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
