/**
 * SVG overlay for selection bounds, resize handles, and area marquee.
 * Selection outline: always-mounted `<g>` + `<rect>` driven by Preact `effect()` (sync with signals).
 * `viewBox` is updated imperatively from `viewportSignal`. Corner squares: imperative `effect()`.
 * Other handles/marquees stay React-driven (cold path).
 */

import type { RefObject } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useSelector } from '@xstate/react'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { useSnapshot } from 'valtio'
import { docProxy, getActiveOrSinglePageId, getPage } from '../../renderer/store/doc-proxy'
import type { TextContent } from 'penpot-exporter/types'
import { isEmptyTextContent } from '../RightSidePanel/Sections/text-typography'
import { pointerPos, viewport as viewportSignal } from '../../renderer/signals/pointer'
import { textEditorIsEmpty, textEditorShapeId } from '../../renderer/signals/text-editor'
import {
  eraseStroke as eraseStrokeSignal,
  selectionCornerHandlesVisible,
  selectionRectOutlineVisible,
  selectionRect as selectionRectSignal,
  shapeDrawPreview as shapeDrawPreviewSignal,
  wasmSelectionRect as wasmSelectionRectSignal,
} from '../../renderer/signals/selection'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { brushBandPath } from '../../renderer/handlers/erase'
import { motionPlaying, motionPreviewActive } from '../../renderer/motion/motion-store'
import {
  HANDLE_FILL,
  HANDLE_SIZE_WORLD,
  HANDLE_STROKE,
  MIN_SELRECT_SIDE_SCREEN,
  SELECTION_STROKE,
  SELECTION_OVERLAY_GLOW,
  getResizeCursor,
  getRotationCursor,
  matrixHasHalfFlip,
  matrixToRotationDeg,
} from './constants'
import { ResizeHandles } from './ResizeHandles'
import { MoveHitArea } from './MoveHitArea'
import { RotationHitArea } from './RotationHitArea'
import { CenterGizmo } from './CenterGizmo'
import { chromeExtent } from './chrome-extent'
import { AreaMarquee } from './AreaMarquee'
import { GradientOverlay } from './GradientOverlay'
import { finiteSelectionOverlayRect } from './finite-selection-overlay-rect'
import { screenRectToWorld } from './screen-rect-to-world'
import { useViewBoxSync } from './useViewBoxSync'
import { useImperativeSelectionRect } from './useImperativeSelectionRect'
import {
  CORNER_HANDLE_POSITIONS,
  useImperativeCornerHandles,
  type CornerPointerRef,
  type CornerRectRefsTuple,
} from './useImperativeCornerHandles'
import { usePointerDownFactory } from './usePointerDownFactory'
import { useGradientFill } from './useGradientFill'
import { useImperativeDropIntent } from './useImperativeDropIntent'
import { useImperativeSlotHover } from './useImperativeSlotHover'

export interface SelectionOverlayProps {
  canvasSize: { width: number; height: number }
  canvasRef: RefObject<HTMLCanvasElement | null>
}

export function SelectionOverlay({ canvasSize, canvasRef }: SelectionOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const hotGRef = useRef<SVGGElement>(null)
  const selRectRef = useRef<SVGRectElement>(null)
  const cornerHandlesGRef = useRef<SVGGElement>(null)
  const cornerRectRefs = useRef<CornerRectRefsTuple>([null, null, null, null])
  const cornerOverrideCursorRef = useRef<string | null>(null)
  const cornerPointerRef = useRef<CornerPointerRef | null>(null)
  const dropIntentGRef = useRef<SVGGElement>(null)
  const dropRectRef = useRef<SVGRectElement>(null)
  const dropLineRef = useRef<SVGLineElement>(null)
  const dropGhostRef = useRef<SVGRectElement>(null)
  const dropLabelRef = useRef<SVGTextElement>(null)
  const slotHoverLabelRef = useRef<SVGTextElement>(null)

  useViewBoxSync(svgRef, canvasSize)
  useImperativeSelectionRect(hotGRef, selRectRef)
  useImperativeCornerHandles(cornerHandlesGRef, cornerRectRefs, cornerOverrideCursorRef, cornerPointerRef)
  useImperativeDropIntent(dropIntentGRef, dropRectRef, dropLineRef, dropGhostRef, dropLabelRef)
  useImperativeSlotHover(slotHoverLabelRef)

  const canvasActor = useCanvasActor()
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])
  const wasmSelectionRect = useSignalCoalesced(wasmSelectionRectSignal)
  const viewport = useSignalCoalesced(viewportSignal)
  const selectionRect = useSignalCoalesced(selectionRectSignal)
  const isSelecting = useSelector(canvasActor, (s) => s.matches('marqueeSelect'))
  const isMoving = useSelector(canvasActor, (s) => s.matches('moving'))
  const isResizing = useSelector(canvasActor, (s) => s.matches('resizing'))
  const resizeHandle = useSelector(canvasActor, (s) => s.context.resizeHandle)
  const isRotating = useSelector(canvasActor, (s) => s.matches('rotating'))
  const rotationCorner = useSelector(canvasActor, (s) => s.context.rotationCorner)
  // While text-editing, suppress selection handles so the MoveHitArea (pointerEvents
  // 'auto') doesn't intercept clicks meant for caret placement / drag-selection.
  const isTextEditing = useSelector(canvasActor, (s) => s.matches('textEditing'))
  // While vector-editing, hide the selection box/handles so they don't sit on top
  // of the anchor/handle markers the PathEditorOverlay draws.
  const isPathEditing = useSelector(canvasActor, (s) => s.matches('pathEditing'))
  // Editing a 3D scene draws its own violet grips + backdrop; hide the 2D selection
  // chrome (corner/rotation handles + outline) so the two don't double up.
  const isScene3dEditing = useSelector(canvasActor, (s) => s.matches('scene3dEditing'))
  // Live editor emptiness + which shape is being edited: while editing, the typed
  // text lives in the WASM editor (not `node.content`), so the outline gate below
  // reads these instead of the stale doc content.
  const editorIsEmpty = useSignalCoalesced(textEditorIsEmpty)
  const editingId = useSignalCoalesced(textEditorShapeId)
  const isMotionPreview = useSignalCoalesced(motionPreviewActive)
  const isMotionPlaying = useSignalCoalesced(motionPlaying)

  const rawZoom = viewport?.zoom ?? 1
  const safeZoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1
  const hasFiniteSelectionRect = finiteSelectionOverlayRect(wasmSelectionRect)
  // Selection chrome (box outline + move grab) shows when a motion preview is
  // PAUSED — hidden only during active playback. Resize + corner squares stay
  // gated on `!isMotionPreview` (W/H resize authoring is Slice 3c, not yet
  // keyframe-aware), but ROTATION is keyframe-aware now (dragging it authors a
  // rotation keyframe via rotate.ts), so its handle shows while paused too.
  const showHandles =
    selectedIds.size >= 1 &&
    hasFiniteSelectionRect &&
    viewport != null &&
    !isMoving &&
    !isTextEditing &&
    !isPathEditing &&
    !isScene3dEditing &&
    !isMotionPlaying
  // How big the box actually is on screen. When it degenerates (a motion scaled
  // the shape to ~0, it's sub-pixel, or we're zoomed far out) the transform's
  // linear part is singular, so EVERY child of the bounds group collapses to a
  // point — the box and its handles stop being grabbable. The centre gizmo takes
  // over in that case; it hangs off a translate-only anchor and can't collapse.
  const extent = chromeExtent(wasmSelectionRect, safeZoom)
  const isDegenerate = extent.degenerate
  // Resize/corner handles need real bounds to hang off, so they also require a
  // non-degenerate box (on top of the existing motion gate — W/H authoring is
  // Slice 3c).
  const showEditHandles = showHandles && !isMotionPreview && !isDegenerate
  // Rotation handle: visible in design mode AND while a motion preview is paused
  // (so the user can grab it to author a rotation keyframe). When degenerate the
  // gizmo carries rotation instead, so the bounds-anchored one stands down.
  const showRotateHandle = showHandles && !isDegenerate

  const hitSize = HANDLE_SIZE_WORLD / safeZoom

  const { onSelectionRectPointerDown, onResizeHandlePointerDown, onRotationPointerDown, onGradientHandlePointerDown } =
    usePointerDownFactory(canvasRef, canvasActor)

  const shapeDrawPreview = useSignalCoalesced(shapeDrawPreviewSignal)
  const eraseStroke = useSignalCoalesced(eraseStrokeSignal)
  const isDrawingShape = useSelector(canvasActor, (s) => s.matches('drawingShape'))
  const shapeDrawWorld =
    isDrawingShape &&
      shapeDrawPreview != null &&
      viewport != null &&
      Number.isFinite(viewport.zoom) &&
      viewport.zoom > 0
      ? screenRectToWorld(viewport, shapeDrawPreview)
      : null

  const areaMarqueeWorld =
    isSelecting &&
      selectionRect != null &&
      viewport != null &&
      Number.isFinite(viewport.zoom) &&
      viewport.zoom > 0
      ? screenRectToWorld(viewport, selectionRect)
      : null

  const rect =
    wasmSelectionRect != null
      ? {
        x: -wasmSelectionRect.width / 2,
        y: -wasmSelectionRect.height / 2,
        width: wasmSelectionRect.width,
        height: wasmSelectionRect.height,
      }
      : null
  const transformStr =
    wasmSelectionRect != null
      ? `translate(${wasmSelectionRect.center.x},${wasmSelectionRect.center.y}) matrix(${wasmSelectionRect.transform.a},${wasmSelectionRect.transform.b},${wasmSelectionRect.transform.c},${wasmSelectionRect.transform.d},0,0)`
      : ''
  const rotationDeg = wasmSelectionRect != null ? matrixToRotationDeg(wasmSelectionRect.transform) : undefined
  const halfFlip = wasmSelectionRect != null ? matrixHasHalfFlip(wasmSelectionRect.transform) : false
  const overrideCursor =
    isResizing && resizeHandle
      ? getResizeCursor(resizeHandle, rotationDeg, halfFlip)
      : isRotating && rotationCorner
        ? getRotationCursor(rotationCorner, rotationDeg, halfFlip)
        : null

  useLayoutEffect(() => {
    cornerOverrideCursorRef.current = overrideCursor
    cornerPointerRef.current = {
      canvasRef,
      sendCornerDown(position, screenPos) {
        pointerPos.value = screenPos
        canvasActor.send({ type: 'POINTER_DOWN_ON_CORNER', handle: position, position: screenPos })
      },
    }
  }, [overrideCursor, canvasRef, canvasActor])

  useLayoutEffect(() => {
    const g = cornerHandlesGRef.current
    const rects = cornerRectRefs.current
    if (!g || g.style.display === 'none') return
    const sel = wasmSelectionRectSignal.peek()
    if (!finiteSelectionOverlayRect(sel)) return
    const rd = matrixToRotationDeg(sel.transform)
    const hf = matrixHasHalfFlip(sel.transform)
    for (let i = 0; i < 4; i++) {
      const el = rects[i]
      if (el) el.style.cursor = overrideCursor ?? getResizeCursor(CORNER_HANDLE_POSITIONS[i], rd, hf)
    }
  }, [overrideCursor, rotationDeg, halfFlip])

  const thresholdTinyWorld = MIN_SELRECT_SIDE_SCREEN / safeZoom
  const showCornerHandles =
    wasmSelectionRect != null &&
    wasmSelectionRect.width > thresholdTinyWorld &&
    wasmSelectionRect.height > thresholdTinyWorld

  useLayoutEffect(() => {
    selectionCornerHandlesVisible.value = showEditHandles && showCornerHandles
  }, [showEditHandles, showCornerHandles])

  // Hide the selection outline only for an empty *click-created* text box, so it
  // shows just the caret until characters are typed. Click-created boxes are
  // `auto-width` (content-driven); a *drag-created* box is `fixed` and keeps its
  // outline even while empty (the user explicitly drew that box). Recomputed each
  // render; on commit the machine leaves `textEditing` and re-reads the content.
  const selectedTextEmpty = (() => {
    if (selectedIds.size !== 1) return false
    const id = selectedIds.values().next().value
    const pid = getActiveOrSinglePageId()
    const node =
      id && pid
        ? (getPage(pid)?.objects[id] as
            | { type?: string; content?: TextContent; growType?: string }
            | undefined)
        : undefined
    if (node?.type !== 'text' || node.growType !== 'auto-width') return false
    // While this shape is being edited, the typed text isn't in `node.content`
    // yet — read the live editor signal so the outline appears on the first key.
    if (isTextEditing && editingId === id) return editorIsEmpty
    return isEmptyTextContent(node.content)
  })()

  useLayoutEffect(() => {
    // Hide the box outline while vector-editing too — the PathEditorOverlay's
    // anchor/handle markers stand in for the selection box.
    selectionRectOutlineVisible.value =
      !isMoving && !selectedTextEmpty && !isPathEditing && !isScene3dEditing && !isMotionPlaying
  }, [isMoving, selectedTextEmpty, isPathEditing, isScene3dEditing, isMotionPlaying])

  const gradientForOverlay = useGradientFill()

  return (
    <svg
      ref={svgRef}
      aria-hidden
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <filter id="selection-line-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
          <feFlood floodColor={SELECTION_OVERLAY_GLOW} result="flood" />
          <feComposite in="flood" in2="blur" operator="in" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {eraseStroke != null && eraseStroke.points.length >= 1 && (
        <g style={{ pointerEvents: 'none' }}>
          {eraseStroke.mode === 'lasso' ? (
            <polygon
              points={eraseStroke.points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="rgba(226,75,74,0.18)"
              stroke="#E24B4A"
              strokeWidth={1 / rawZoom}
              strokeLinejoin="round"
              strokeDasharray={`${5 / rawZoom},${4 / rawZoom}`}
            />
          ) : (
            // Brush: draw the UNIONed swept band (self-overlaps merged) so passing
            // back over the same spot reads as one filled area, not a tangle of
            // crossing outlines. This is exactly what the release will subtract.
            <path
              d={brushBandPath(eraseStroke.points, eraseStroke.radius, eraseStroke.cap, rawZoom)}
              fill="rgba(226,75,74,0.18)"
              fillRule="evenodd"
              stroke="#E24B4A"
              strokeWidth={1 / rawZoom}
              strokeLinejoin="round"
            />
          )}
          {/* Free-form: bézier handle lines + square markers on each placed node. */}
          {eraseStroke.mode === 'lasso' &&
            (eraseStroke.nodes ?? []).map((n, i) => (
              <g key={i}>
                {(['hIn', 'hOut'] as const).map((h) =>
                  n[h] ? (
                    <g key={h}>
                      <line
                        x1={n.x}
                        y1={n.y}
                        x2={n[h]!.x}
                        y2={n[h]!.y}
                        stroke="#E24B4A"
                        strokeWidth={1 / rawZoom}
                      />
                      <circle cx={n[h]!.x} cy={n[h]!.y} r={3 / rawZoom} fill="#E24B4A" />
                    </g>
                  ) : null,
                )}
                <rect
                  x={n.x - 3 / rawZoom}
                  y={n.y - 3 / rawZoom}
                  width={6 / rawZoom}
                  height={6 / rawZoom}
                  fill="#fff"
                  stroke="#E24B4A"
                  strokeWidth={1.5 / rawZoom}
                />
              </g>
            ))}
          {/* Cursor over the first node → next click cuts the loop closed. */}
          {eraseStroke.mode === 'lasso' &&
            eraseStroke.close &&
            eraseStroke.nodes?.[0] &&
            (() => {
              const n0 = eraseStroke.nodes[0]
              const off = 15 / rawZoom
              const s = 20 / rawZoom / 24
              return (
                <g transform={`translate(${n0.x + off} ${n0.y - off})`}>
                  <circle r={13 / rawZoom} fill="#fff" stroke="#E24B4A" strokeWidth={1.5 / rawZoom} />
                  <g
                    transform={`scale(${s}) translate(-12 -12)`}
                    fill="none"
                    stroke="#E24B4A"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <line x1="20" y1="4" x2="8.12" y2="15.88" />
                    <line x1="14.47" y1="14.48" x2="20" y2="20" />
                    <line x1="8.12" y1="8.12" x2="12" y2="12" />
                  </g>
                </g>
              )
            })()}
        </g>
      )}
      {/* Empty-slot hover chrome: an unpainted slot is invisible by design, so
          hovering reveals it. Only the NAME lives here — the outline is traced by
          the renderer over the slot's real geometry (see useImperativeSlotHover).
          Editor-only either way: never in the document. */}
      <text
        ref={slotHoverLabelRef}
        fill="#7F77DD"
        fontWeight={500}
        style={{ display: 'none', pointerEvents: 'none', userSelect: 'none' }}
      />

      <g ref={dropIntentGRef} style={{ display: 'none', pointerEvents: 'none' }}>
        <rect ref={dropRectRef} fill="none" stroke="#378ADD" rx={6} style={{ pointerEvents: 'none' }} />
        <rect ref={dropGhostRef} fill="rgba(55,138,221,0.10)" stroke="#378ADD" rx={4} style={{ pointerEvents: 'none' }} />
        <line ref={dropLineRef} stroke="#E24B4A" strokeLinecap="round" style={{ pointerEvents: 'none' }} />
        <text
          ref={dropLabelRef}
          fill="#378ADD"
          fontWeight={500}
          style={{ display: 'none', pointerEvents: 'none', userSelect: 'none' }}
        />
      </g>
      <g ref={hotGRef} style={{ display: 'none' }}>
        <rect
          ref={selRectRef}
          fill="none"
          stroke={SELECTION_STROKE}
          style={{ pointerEvents: 'none' }}
        />
      </g>
      <g ref={cornerHandlesGRef} style={{ pointerEvents: 'auto', display: 'none' }}>
        <rect
          ref={(el) => {
            cornerRectRefs.current[0] = el
          }}
          data-handle="top-left"
          fill={HANDLE_FILL}
          stroke={HANDLE_STROKE}
          style={{ pointerEvents: 'auto' }}
        />
        <rect
          ref={(el) => {
            cornerRectRefs.current[1] = el
          }}
          data-handle="top-right"
          fill={HANDLE_FILL}
          stroke={HANDLE_STROKE}
          style={{ pointerEvents: 'auto' }}
        />
        <rect
          ref={(el) => {
            cornerRectRefs.current[2] = el
          }}
          data-handle="bottom-right"
          fill={HANDLE_FILL}
          stroke={HANDLE_STROKE}
          style={{ pointerEvents: 'auto' }}
        />
        <rect
          ref={(el) => {
            cornerRectRefs.current[3] = el
          }}
          data-handle="bottom-left"
          fill={HANDLE_FILL}
          stroke={HANDLE_STROKE}
          style={{ pointerEvents: 'auto' }}
        />
      </g>
      {showHandles && rect != null && (
        <>
          <g transform={transformStr}>
            <MoveHitArea
              bounds={rect}
              hitSize={hitSize}
              overrideCursor={overrideCursor}
              onPointerDown={onSelectionRectPointerDown}
            />
            {showEditHandles && (
              <ResizeHandles
                effectiveBounds={rect}
                zoom={safeZoom}
                skipCorners
                rotationDeg={rotationDeg}
                halfFlip={halfFlip}
                overrideCursor={overrideCursor}
                onResizeHandlePointerDown={onResizeHandlePointerDown}
              />
            )}
            {showRotateHandle && (
              <RotationHitArea
                bounds={rect}
                zoom={safeZoom}
                rotationDeg={rotationDeg}
                halfFlip={halfFlip}
                overrideCursor={overrideCursor}
                onPointerDown={onRotationPointerDown}
              />
            )}
          </g>
          {/*
            Mounted OUTSIDE the bounds group on purpose: that group's linear part
            is singular at scale 0, so anything inside it collapses. The gizmo
            anchors to the centre (translate only) and survives.
          */}
          {wasmSelectionRect != null && (
            <CenterGizmo
              center={wasmSelectionRect.center}
              zoom={safeZoom}
              degenerate={isDegenerate}
              allowRotate={showHandles}
              overrideCursor={overrideCursor}
              onMovePointerDown={onSelectionRectPointerDown}
              onRotationPointerDown={onRotationPointerDown}
            />
          )}
          {gradientForOverlay != null && (
            <g style={{ filter: 'url(#selection-line-glow)' }}>
              <GradientOverlay wasmSelectionRect={wasmSelectionRect} gradient={gradientForOverlay} zoom={safeZoom} onHandlePointerDown={onGradientHandlePointerDown} />
            </g>
          )}
        </>
      )}
      {shapeDrawWorld && <AreaMarquee world={shapeDrawWorld} zoom={safeZoom} />}
      {areaMarqueeWorld && <AreaMarquee world={areaMarqueeWorld} zoom={safeZoom} />}
    </svg>
  )
}

