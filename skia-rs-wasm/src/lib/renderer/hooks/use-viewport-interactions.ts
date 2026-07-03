/**
 * React hook for viewport interactions.
 *
 * Pointer surface for canvas gestures: all non-text pointer events land on ONE
 * full-size wrapper element (`surfaceRef`) layered over the canvas (canvas itself
 * is `pointerEvents:'none'`). Being a single element makes the native `dblclick`
 * for entering text editing reliable (both presses share it), the way Penpot's
 * single `viewport-controls` SVG does. Selection handles sit above the wrapper.
 *
 * Text editing pointers (caret / drag-select / word-select) are NOT handled here —
 * they go to the contentEditable in `TextEditorOverlay`, which sits over the shape
 * and reads element-local `offsetX/offsetY` (shape-local for free), exactly like
 * Penpot's `v3_editor`. The sink's only job during editing is click-away: a
 * mousedown that reaches the wrapper is outside the text box → `STOP_TEXT_EDIT`.
 * Keyboard/zoom shortcuts stay on the window.
 */

import type { RefObject } from 'react'
import { useEffect, useRef, useCallback } from 'react'
import { getSelectedIdsSet, setSelectedIds } from '../store/document-selection'
import { useWorkspaceStore } from '../store/workspace-store'
import { useCanvasActor } from '../machine/canvas-actor-context'
import { useViewportShortcutsStore } from '../store/shortcuts-store'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { isScene3D, scene3dProxy, setFocusedObject } from '../three/scene3d-store'
import { Viewport, screenToWorld } from '../viewport'
import type { ViewportPanModifier, SelectionRectResult } from '../types'
import { effect } from '@preact/signals-core'
import { modAlt, modCtrl, modMeta, modShift, pointerPanning, pointerPos, viewport } from '../signals/pointer'
import { wasmSelectionRect } from '../signals/selection'
import { queryNodesAtPoint, pickTopmostNode } from '../selection/query-at-point'
import { createPenStartPath } from '../handlers/draw-path'
import { buildKeyBindings, dispatchKey } from '../input/key-bindings'
import type { CommandCtx } from '../input/commands'
import { resolveCanvasCursor } from '../input/cursor'

function hasPanModifier(e: MouseEvent, mod: ViewportPanModifier): boolean {
  if (mod === null) return false
  switch (mod) {
    case 'shift': return e.shiftKey
    case 'alt': return e.altKey
    case 'ctrl': return e.ctrlKey
    case 'meta': return e.metaKey
    default: return false
  }
}

/** Is the configured pan modifier currently held? Reads the live modifier signals
 *  (kept up to date by canvas-wrapper's window key listeners) so the cursor effect
 *  reacts to Shift/Space without a mouse-move. */
function panModifierHeld(mod: ViewportPanModifier): boolean {
  switch (mod) {
    case 'shift': return modShift.value
    case 'alt': return modAlt.value
    case 'ctrl': return modCtrl.value
    case 'meta': return modMeta.value
    default: return false
  }
}

/** True if world point is inside the selection rect (respects rotation). */
function isPointInSelectionBounds(
  point: { x: number; y: number },
  sel: SelectionRectResult
): boolean {
  const { center, width, height, transform } = sel
  const dx = point.x - center.x
  const dy = point.y - center.y
  const { a, b, c, d } = transform
  const det = a * d - b * c
  if (Math.abs(det) < 1e-10) return false
  const localX = (d * dx - c * dy) / det
  const localY = (-b * dx + a * dy) / det
  const hw = width / 2
  const hh = height / 2
  return localX >= -hw && localX <= hw && localY >= -hh && localY <= hh
}

interface UseViewportInteractionsParams {
  /** The single full-size pointer surface (wrapper) layered over the canvas. */
  surfaceRef: RefObject<HTMLElement | null>
  /** Called with the new Viewport instance after each pan/zoom; consumer should update store from it. */
  onViewportUpdate?: (next: Viewport) => void
}

export function useViewportInteractions({
  surfaceRef,
  onViewportUpdate,
}: UseViewportInteractionsParams) {
  const canvasActor = useCanvasActor()
  const renderer = useWorkspaceStore((state) => state.renderer)
  const shortcuts = useViewportShortcutsStore((state) => state.viewportShortcuts)
  // Refs for panning state
  const isPanningRef = useRef<boolean>(false)
  const lastPanPosRef = useRef<{ x: number; y: number } | null>(null)
  const pendingPanUpdateRef = useRef<boolean>(false)
  /** Accumulates pan while the viewport signal + WASM apply are limited to one commit per animation frame. */
  const pendingPanViewportRef = useRef<Viewport | null>(null)

  // Handle mouse wheel for zooming
  const handleWheel = useCallback((e: WheelEvent) => {
    const surface = surfaceRef.current
    if (!viewport.value || !renderer || !surface) return
    if (!shortcuts.wheelZoomEnabled) return

    e.preventDefault()
    e.stopPropagation()

    const rect = surface.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const scalePerPixel = shortcuts.wheelScalePerPixel
    const absDelta = Math.abs(e.deltaY) + Math.abs(e.deltaX)
    const scale = 1 + scalePerPixel * absDelta
    const zoomFactor = e.deltaY < 0 ? scale : 1 / scale
    const next = Viewport.from(viewport.value)
    next.zoomAt({ x, y }, zoomFactor)
    renderer.applyViewport(next)
    onViewportUpdate?.(next)
  }, [surfaceRef, renderer, onViewportUpdate, shortcuts.wheelZoomEnabled, shortcuts.wheelScalePerPixel])

  // Handle mouse down
  const handleMouseDown = useCallback((e: MouseEvent) => {
    const surface = surfaceRef.current
    if (!surface) return

    const panWithButton = e.button === shortcuts.panMouseButton
    const panWithMod = e.button === 0 && hasPanModifier(e, shortcuts.panWithModifier)
    if (panWithButton || panWithMod) {
      e.preventDefault()
      isPanningRef.current = true
      pointerPanning.value = true // cursor effect yields 'grabbing' to the pan
      pendingPanViewportRef.current = null
      canvasActor.send({ type: 'PAN_START' })
      lastPanPosRef.current = { x: e.clientX, y: e.clientY }
      surface.style.cursor = 'grabbing'
      return
    }

    // Left mouse button for selection/moving/text
    if (e.button === 0) {
      e.preventDefault()

      const rect = surface.getBoundingClientRect()
      const screenX = e.clientX - rect.left
      const screenY = e.clientY - rect.top
      const snap = canvasActor.getSnapshot()

      // Any mousedown that reaches the wrapper during editing is *outside* the
      // text box — clicks inside land on the contentEditable (which sits above
      // the wrapper) and never get here. So this is a Penpot-style click-away:
      // commit + exit, then fall through to normal select/move handling.
      if (snap.matches('textEditing')) {
        canvasActor.send({ type: 'STOP_TEXT_EDIT' })
      }

      // Same click-away rule for vector editing: anchor/handle presses are caught
      // by the overlay markers (pointerEvents 'auto') and never reach the surface,
      // so any mousedown that lands here is outside the path → commit + exit.
      if (snap.matches('pathEditing')) {
        canvasActor.send({ type: 'STOP_PATH_EDIT' })
      }

      // NOTE: 3D-scene editing has no click-away hook here on purpose. Exit is driven
      // by *selection* (Scene3DLayer's "3D-edit follows the selection" rule), so it
      // fires no matter how the selection changed — a canvas click that hits another
      // node (setSelectedIds below), a Layers-panel click, or a keyboard/programmatic
      // change. Empty-canvas clicks are handled by the machine's `scene3dEditing`
      // POINTER_DOWN_ON_CANVAS transition (they don't mutate selection until pointer-up).

      const activeDrawTool = canvasActor.getSnapshot().context.drawTool
      if (activeDrawTool === 'pen') {
        // Pen creation flows through the unified path editor (Phase C — one pen):
        // the first click makes an empty 1-node path and drops into the Add
        // sub-tool anchored on that node; the overlay handles every later click.
        // No separate `drawingPath` world. The pen tool stays armed, so finishing
        // (Done/Esc → idle) lets the next click start another path.
        pointerPos.value = { x: screenX, y: screenY }
        const vp = viewport.value
        if (vp && canvasActor.getSnapshot().matches('idle')) {
          void createPenStartPath(screenToWorld(vp, screenX, screenY)).then((id) => {
            if (!id) return
            canvasActor.send({ type: 'START_PATH_EDIT', shapeId: id })
            canvasActor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
            canvasActor.send({ type: 'PATH_SET_DRAFT_FROM', node: 0 })
          })
        }
        return
      }
      if (activeDrawTool != null) {
        pointerPos.value = { x: screenX, y: screenY }
        canvasActor.send({ type: 'POINTER_DOWN_DRAW' })
        return
      }

      pointerPos.value = { x: screenX, y: screenY }

      const mod = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      const store = useWorkspaceStore.getState()
      const { workerClient } = store
      const selectedIds = getSelectedIdsSet()
      const hitPageId = getActiveOrSinglePageId()
      const page = hitPageId ? getPage(hitPageId) : undefined
      const viewportForHit = viewport.value

      if (mod) {
        canvasActor.send({ type: 'POINTER_DOWN_ON_CANVAS', append: shift, remove: shift && mod })
        return
      }

      if (!workerClient || !viewportForHit || !hitPageId) {
        canvasActor.send({ type: 'POINTER_DOWN_ON_CANVAS', append: false, remove: false })
        return
      }
      queryNodesAtPoint(workerClient, hitPageId, viewportForHit, screenX, screenY).then(
        (ids) => {
          const topId = pickTopmostNode(page, ids)
          if (topId) {
            if (shift) {
              const next = new Set(selectedIds)
              if (next.has(topId)) next.delete(topId)
              else next.add(topId)
              setSelectedIds(next)
            } else {
              // Keep full selection when clicking an already-selected node (group drag)
              if (!selectedIds.has(topId)) {
                setSelectedIds(new Set([topId]))
              }
            }
            canvasActor.send({ type: 'POINTER_DOWN_ON_SELECTION', position: { x: screenX, y: screenY } })
          } else {
            // Fallback: click in empty space (e.g. inside stroke-only shape) but inside selection bounds → start move
            const currentIds = getSelectedIdsSet()
            const wasmRect = wasmSelectionRect.peek()
            if (
              currentIds.size > 0 &&
              wasmRect != null &&
              viewportForHit != null
            ) {
              const world = screenToWorld(viewportForHit, screenX, screenY)
              if (isPointInSelectionBounds(world, wasmRect)) {
                canvasActor.send({ type: 'POINTER_DOWN_ON_SELECTION', position: { x: screenX, y: screenY } })
                return
              }
            }
            canvasActor.send({ type: 'POINTER_DOWN_ON_CANVAS', append: false, remove: false })
          }
        }
      )
    }
  }, [surfaceRef, canvasActor, shortcuts.panMouseButton, shortcuts.panWithModifier])

  // Handle mouse move for panning. The cursor is owned by the reactive effect
  // below (input/cursor.ts), not set here — so it stays correct without a move.
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const surface = surfaceRef.current
    if (!surface) return

    if (isPanningRef.current && lastPanPosRef.current) {
      e.preventDefault()
      const dx = e.clientX - lastPanPosRef.current.x
      const dy = e.clientY - lastPanPosRef.current.y
      lastPanPosRef.current = { x: e.clientX, y: e.clientY }

      const current = viewport.value
      if (!current) return

      const base = pendingPanViewportRef.current ?? Viewport.from(current)
      const next = Viewport.from(base)
      next.pan(dx, dy)
      pendingPanViewportRef.current = next

      if (!pendingPanUpdateRef.current) {
        pendingPanUpdateRef.current = true
        requestAnimationFrame(() => {
          pendingPanUpdateRef.current = false
          const latest = pendingPanViewportRef.current
          if (latest && renderer && isPanningRef.current) {
            renderer.applyViewport(Viewport.from(latest))
            onViewportUpdate?.(latest)
            pendingPanViewportRef.current = null
          }
        })
      }
    }
  }, [surfaceRef, renderer, onViewportUpdate])

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    if (isPanningRef.current) {
      canvasActor.send({ type: 'PAN_END' })
      isPanningRef.current = false
      pointerPanning.value = false // hand the cursor back to the reactive effect
      lastPanPosRef.current = null
      const vp = pendingPanViewportRef.current ?? viewport.value
      pendingPanViewportRef.current = null
      if (vp && renderer) {
        renderer.applyViewport(Viewport.from(vp))
        onViewportUpdate?.(Viewport.from(vp))
      }
    }
  }, [canvasActor, renderer, onViewportUpdate])

  // Double-click to ENTER text editing. Mirrors Penpot's viewport on-double-click
  // (native `dblclick`, then act on the hovered/hit shape). Reliable because the
  // wrapper is the single body surface, so both presses land on it. Word-select
  // *while* editing is handled by the contentEditable's own onDoubleClick (its
  // pointers land on the editor element, not the wrapper).
  const handleDoubleClick = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return
    const surface = surfaceRef.current
    if (!surface) return
    const snap = canvasActor.getSnapshot()
    if (snap.context.drawTool != null || snap.matches('textEditing')) return

    const rect = surface.getBoundingClientRect()
    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top

    const { workerClient } = useWorkspaceStore.getState()
    const hitPageId = getActiveOrSinglePageId()
    const page = hitPageId ? getPage(hitPageId) : undefined
    const vp = viewport.value
    if (!workerClient || !vp || !hitPageId || !page) return

    queryNodesAtPoint(workerClient, hitPageId, vp, screenX, screenY).then((ids) => {
      const topId = pickTopmostNode(page, ids)
      const node = topId ? (page.objects[topId] as { type?: string } | undefined) : undefined
      if (topId && isScene3D(topId)) {
        // A 3D scene drops into 3D-edit mode (the analogue of double-clicking into
        // a frame), focused on its first object.
        setSelectedIds(new Set([topId]))
        setFocusedObject(scene3dProxy.scenes.get(topId)?.objects[0]?.id ?? null)
        canvasActor.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: topId })
      } else if (topId && node?.type === 'text') {
        setSelectedIds(new Set([topId]))
        canvasActor.send({ type: 'START_TEXT_EDIT', shapeId: topId })
      } else if (topId && node?.type === 'path') {
        // A path drops into vector-edit mode (drag its anchors/handles), the
        // path analogue of double-clicking a text shape to edit its content.
        setSelectedIds(new Set([topId]))
        canvasActor.send({ type: 'START_PATH_EDIT', shapeId: topId })
      } else {
        // Stroke-miss fallback: open paths only register a hit on the stroke
        // (query-selection uses precise geometry, not the bbox), so a double-click
        // in the *fill area* of an already-selected path returns no node. If a
        // single path is selected and the point is within its bounds, edit it
        // anyway — mirrors the mousedown bounds-fallback and Figma/Illustrator.
        const sel = getSelectedIdsSet()
        const selId = sel.size === 1 ? [...sel][0] : null
        const selObj = selId ? (page.objects[selId] as { type?: string } | undefined) : undefined
        const wasmRect = wasmSelectionRect.peek()
        if (
          selId &&
          selObj?.type === 'path' &&
          wasmRect &&
          isPointInSelectionBounds(screenToWorld(vp, screenX, screenY), wasmRect)
        ) {
          canvasActor.send({ type: 'START_PATH_EDIT', shapeId: selId })
        }
      }
    })
  }, [surfaceRef, canvasActor])

  // Single reactive writer of the surface cursor (replaces the old ~10 imperative
  // `surface.style.cursor = …` sites). Re-runs on any machine transition AND on any
  // modifier / panning / selection-rect signal change — so Alt/Shift flip the cursor
  // with no mouse-move needed. The pan gesture owns the cursor while it's in flight.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const panMod = shortcuts.panWithModifier
    const apply = () => {
      if (pointerPanning.peek()) return // pan drag set 'grabbing'; don't fight it
      const snap = canvasActor.getSnapshot()
      surface.style.cursor = resolveCanvasCursor(
        snap,
        { alt: modAlt.peek(), panHeld: panModifierHeld(panMod) },
        wasmSelectionRect.peek(),
      )
    }
    const sub = canvasActor.subscribe(apply)
    const dispose = effect(() => {
      // Touch the reactive deps so the effect re-runs when any of them change.
      const deps = [
        modShift.value, modAlt.value, modCtrl.value, modMeta.value,
        pointerPanning.value, wasmSelectionRect.value,
      ]
      void deps
      apply()
    })
    return () => {
      sub.unsubscribe()
      dispose()
    }
  }, [surfaceRef, canvasActor, shortcuts.panWithModifier])

  // Keyboard shortcuts: resolved through the central binding table + command
  // dispatcher (input/key-bindings.ts). Adding a shortcut is a row there, not a
  // branch here. The pen-draft Esc (cancel-but-stay) is still owned by the overlay's
  // own capture-phase handler, which stopPropagation()s before this runs.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const ctx: CommandCtx = {
      actor: canvasActor,
      renderer,
      getViewport: () => viewport.value,
      onViewportUpdate,
      zoomCenter: () => {
        const rect = surfaceRef.current?.getBoundingClientRect()
        return rect ? { x: rect.width / 2, y: rect.height / 2 } : null
      },
      shortcuts,
    }
    dispatchKey(e, buildKeyBindings(shortcuts), ctx)
  }, [surfaceRef, canvasActor, renderer, onViewportUpdate, shortcuts])

  // Set up event listeners (read ref inside effect, not during render)
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    // Wheel on the container (parent) so zoom works even when the cursor is over
    // an interactive SVG handle (which sits above the wrapper).
    const wheelTarget = surface.parentElement ?? surface
    surface.addEventListener('mousedown', handleMouseDown)
    surface.addEventListener('dblclick', handleDoubleClick)
    wheelTarget.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      surface.removeEventListener('mousedown', handleMouseDown)
      surface.removeEventListener('dblclick', handleDoubleClick)
      wheelTarget.removeEventListener('wheel', handleWheel)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [surfaceRef, handleWheel, handleDoubleClick, handleMouseDown, handleMouseMove, handleMouseUp, handleKeyDown])
}
