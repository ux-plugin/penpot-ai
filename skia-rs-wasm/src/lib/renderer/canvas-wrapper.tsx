/**
 * React component wrapper that initializes both worker and canvas renderer.
 * Mounts the canvas interaction actor (`canvasMachine`) here — library entry point for XState context.
 */

import { useEffect, useRef, useState } from 'react'
import { useActorRef } from '@xstate/react'
import { cn } from '@/lib/utils'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import type { CanvasWrapperProps } from './types'
import { useWorkspaceStore } from './store/workspace-store'
import { useViewportShortcutsStore } from './store/shortcuts-store'
import { modAlt, modCtrl, modMeta, modShift, viewport } from './signals/pointer'
import { initRendererClient, cleanupRendererClient } from './renderer-init'
import { SelectionOverlay } from '../components/Overlay/SelectionOverlay'
import { MotionPathOverlay } from '../components/Overlay/MotionPathOverlay'
import { MotionBadge } from '../components/Overlay/MotionBadge'
import { TextEditorOverlay } from '../components/Overlay/TextEditorOverlay'
import { PathEditorOverlay } from '../components/Overlay/PathEditorOverlay'
import { Scene3DLayer } from './three/Scene3DLayer'
import { focusViewportRect } from './three/scene3d-focus'
import { useViewportInteractions } from './hooks/use-viewport-interactions'
import { useStreams } from './hooks/use-streams'
import { cleanupWorker, initWorker } from '../worker-init'
import { initWasmModule } from '../wasm-init'
import { canvasMachine } from './machine/canvas-machine'
import { CanvasActorProvider } from './machine/canvas-actor-context'

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 600

function CanvasWorkspace({
  className,
  containerStyle,
  containerClassName,
  startSlot,
  endSlot,
  bottomSlot,
  centerOverlay,
  workspaceClassName,
  rendererOptions,
  shortcuts: initialViewportShortcuts,
  wasmPath = '/wasm/render-wasm.js',
  workerScriptUrl,
}: Omit<CanvasWrapperProps, 'overlays'>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const holeRef = useRef<HTMLDivElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  const [timelineHeight, setTimelineHeight] = useState(260)
  const timelineResizeRef = useRef<{ startY: number; startH: number } | null>(null)
  const setViewportShortcuts = useViewportShortcutsStore((state) => state.setViewportShortcuts)

  // Apply initial shortcuts when provided (e.g. on mount or when prop changes)
  useEffect(() => {
    if (initialViewportShortcuts) {
      setViewportShortcuts(initialViewportShortcuts)
    }
  }, [initialViewportShortcuts, setViewportShortcuts])

  const { workerClient, wasmModule, renderer } = useWorkspaceStore()

  useEffect(() => {
    // Fired by the WASM renderer (wapi_notifyTilesRenderComplete) on the main
    // thread once a full tile render pass settles. Reserved as a hook for
    // post-render work; nothing to do yet.
    const handleTilesRenderComplete = () => {
      // Placeholder: no-op until post-tile-render work is needed.
    }
    document.addEventListener('penpot:wasm:tiles-complete', handleTilesRenderComplete)

    initWasmModule(wasmPath).catch((error) => {
      console.error('Failed to load WASM module:', error)
    })
    initWorker(workerScriptUrl).catch((error) => {
      console.error('Failed to initialize worker:', error)
    })

    return () => {
      document.removeEventListener('penpot:wasm:tiles-complete', handleTilesRenderComplete)
      cleanupWorker()
    }
  }, [wasmPath, workerScriptUrl])

  useEffect(() => {
    if (!workerClient || !wasmModule) return
    const canvas = canvasRef.current
    if (!canvas) return
    initRendererClient(canvas, rendererOptions).catch((error) => {
      console.error('Failed to initialize renderer:', error)
    })
    return () => {
      cleanupRendererClient()
    }
  }, [workerClient, wasmModule, rendererOptions])

  // Derive canvas size from container and keep WASM viewbox in sync
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const syncSize = () => {
      const w = Math.round(container.clientWidth)
      const h = Math.round(container.clientHeight)
      const width = w > 0 ? w : DEFAULT_WIDTH
      const height = h > 0 ? h : DEFAULT_HEIGHT
      setCanvasSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
      const { renderer: r } = useWorkspaceStore.getState()
      if (r) {
        try {
          r.resize(width, height)
        } catch {
          // Context not ready yet (e.g. before initPage)
        }
      }
    }

    syncSize()
    const ro = new ResizeObserver(syncSize)
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Publish the central canvas-hole rect (between the panels), in overlay-canvas px, so
  // 3D focus mode renders there instead of over the full-bleed canvas + panels. Recomputes
  // whenever the hole or the canvas column changes size (rail resize, timeline resize,
  // window resize).
  useEffect(() => {
    const hole = holeRef.current
    const container = containerRef.current
    if (!hole || !container) return
    const measure = () => {
      const h = hole.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      focusViewportRect.value = { x: h.left - c.left, y: h.top - c.top, w: h.width, h: h.height }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(hole)
    ro.observe(container)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      focusViewportRect.value = null
    }
  }, [])

  // When renderer becomes available, resize to current canvas size
  useEffect(() => {
    if (!renderer) return
    const { width, height } = canvasSize
    try {
      renderer.resize(width, height)
    } catch {
      // Context not ready yet
    }
  }, [renderer, canvasSize])

  // Update modifier keys on window keydown/keyup for move Shift constrain, etc.
  useEffect(() => {
    const update = (e: KeyboardEvent) => {
      modShift.value = e.shiftKey
      modAlt.value = e.altKey
      modCtrl.value = e.ctrlKey
      modMeta.value = e.metaKey
    }
    const reset = () => {
      modShift.value = false
      modAlt.value = false
      modCtrl.value = false
      modMeta.value = false
    }
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', reset)
    }
  }, [])

  useStreams(canvasRef)
  useViewportInteractions({
    surfaceRef,
    onViewportUpdate: (next) => {
      viewport.value = { panX: next.panX, panY: next.panY, zoom: next.zoom }
    },
  })

  const hasSlots = startSlot != null || endSlot != null || bottomSlot != null

  const canvasColumn = (
    <div
      ref={containerRef}
      className={cn('relative min-h-0 min-w-0', hasSlots ? 'flex-1' : 'h-full w-full', containerClassName)}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 1,
        minHeight: 1,
        position: 'relative',
        ...containerStyle,
      }}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        className={className}
        style={{ display: 'block', width: '100%', height: '100%', border: 'none', boxSizing: 'content-box', pointerEvents: 'none' }}
      />
      {/* Single pointer sink: full-size surface over the canvas, below the SVG
          handles (Stage 1) and the text-editor overlay. All pointer listeners
          attach here (see use-viewport-interactions). */}
      <div
        ref={surfaceRef}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'all', touchAction: 'none' }}
      />
      {/* Motion path/ghosts draw BELOW the selection chrome; the badge sits ON TOP. */}
      <MotionPathOverlay canvasSize={canvasSize} />
      <SelectionOverlay canvasSize={canvasSize} canvasRef={canvasRef} />
      <MotionBadge canvasSize={canvasSize} />
      <TextEditorOverlay />
      <PathEditorOverlay />
      <Scene3DLayer canvasSize={canvasSize} />
    </div>
  )

  if (!hasSlots) {
    return canvasColumn
  }

  // Layered shell. BACK layer: the canvas (+ its overlays), full-bleed -- it
  // never reflows when panels resize, only when the window does (the canvas
  // lives outside the panel tree). FRONT layer: a flex column on top,
  // transparent + pointer-events-none except where the rails / timeline /
  // handles opt back in, so the canvas shows through the gaps and still
  // receives pointer events.
  //
  // Top: a SINGLE flat horizontal resizable group (left rail | transparent
  // centre hole | right rail). It is intentionally NOT nested inside another
  // Panel -- a ResizablePanelGroup wrapped in a Panel mis-sizes its children
  // (renders them as slivers). Every panel gets an explicit defaultSize summing
  // to 100. Bottom: a full-width timeline strip docked across the whole width.
  // The hole is `relative` so the shape toolbar can float at its bottom edge.
  return (
    <div className={cn('relative h-full min-h-0 min-w-0 w-full', workspaceClassName)}>
      {/* `isolate` scopes the canvas's internal z-indexes (its overlays use z 5-7) into
          their own stacking context, so nothing on the canvas can ever paint above the
          panel/tool layer below — the rails, timeline, and toolbars always win. */}
      <div className="absolute inset-0 isolate">{canvasColumn}</div>

      <div className="pointer-events-none absolute inset-0 flex flex-col">
        <div className="min-h-0 w-full flex-1">
          <ResizablePanelGroup orientation="horizontal" className="pointer-events-none h-full w-full">
            {startSlot != null && (
              <>
                <ResizablePanel
                  id="left-rail"
                  minSize={12}
                  defaultSize={18}
                  collapsible
                  collapsedSize={0}
                  className="pointer-events-auto min-h-0 min-w-0"
                >
                  {startSlot}
                </ResizablePanel>
                <ResizableHandle withHandle className="pointer-events-auto" />
              </>
            )}
            <ResizablePanel
              id="canvas-hole"
              minSize={30}
              defaultSize={62}
              className="relative min-h-0 min-w-0"
            >
              <div ref={holeRef} className="relative h-full w-full">
                {centerOverlay}
              </div>
            </ResizablePanel>
            {endSlot != null && (
              <>
                <ResizableHandle withHandle className="pointer-events-auto" />
                <ResizablePanel
                  id="right-rail"
                  minSize={12}
                  defaultSize={20}
                  collapsible
                  collapsedSize={0}
                  className="pointer-events-auto min-h-0 min-w-0"
                >
                  {endSlot}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>

        {bottomSlot != null && (
          <div
            className="pointer-events-auto relative w-full shrink-0 border-t border-border bg-background"
            style={{ height: timelineHeight }}
          >
            {/* Manual top-edge resize handle. We can't use a ResizablePanel here
                (nesting a panel group inside a panel mis-sizes the rails), so the
                timeline height is a plain state dragged from this strip. Drag up
                to grow. */}
            <div
              className="group/tl-resize absolute inset-x-0 top-0 z-10 flex h-2 -translate-y-1/2 cursor-row-resize items-center justify-center"
              onPointerDown={(e) => {
                timelineResizeRef.current = { startY: e.clientY, startH: timelineHeight }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                const drag = timelineResizeRef.current
                if (!drag) return
                const next = drag.startH + (drag.startY - e.clientY)
                const max = Math.max(160, window.innerHeight - 200)
                setTimelineHeight(Math.min(max, Math.max(120, next)))
              }}
              onPointerUp={(e) => {
                timelineResizeRef.current = null
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                } catch {
                  /* ignore */
                }
              }}
              onLostPointerCapture={() => {
                timelineResizeRef.current = null
              }}
            >
              <div className="h-1 w-8 rounded-full bg-border transition-colors group-hover/tl-resize:bg-primary/50" />
            </div>
            {bottomSlot}
          </div>
        )}
      </div>
    </div>
  )
}

export function CanvasWrapper({ overlays, ...workspaceProps }: CanvasWrapperProps) {
  const canvasActorRef = useActorRef(canvasMachine)
  return (
    <CanvasActorProvider actorRef={canvasActorRef}>
      <CanvasWorkspace {...workspaceProps} />
      {overlays}
    </CanvasActorProvider>
  )
}
