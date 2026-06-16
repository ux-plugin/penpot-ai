/**
 * Drag-to-create shapes on the canvas (e.g. rectangle), similar to Penpot workspace draw tools.
 */

import { Observable, EMPTY, concat, of } from 'rxjs'
import { filter, map, scan, switchMap, take, takeUntil, tap } from 'rxjs/operators'
import { modShift, pointerPos, signalToObservable, viewport } from '../signals/pointer'
import { dragStopper } from '../streams/drag-stopper'
import { setSelectedIds } from '../store/document-selection'
import {
  lineDrawPreview as lineDrawPreviewSignal,
  shapeDrawPreview as shapeDrawPreviewSignal,
} from '../signals/selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { screenToWorld } from '../viewport'
import { makeSelrect } from '../../worker/types'
import { isSnapPixelGridEnabled } from '../store/workspace-settings'
import { snapDrawRectToGrid, type DrawRect } from './pixel-snap'
import { applyChanges } from '../../page-crud'
import {
  createEllipse,
  createFrame,
  createLine,
  createParametricPath,
  createRect,
  createText,
} from '../node-factory'
import type { AddObjChange, PenpotNode } from 'penpot-exporter/types'
import type { DrawTool } from '../machine/canvas-machine'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Minimum rubber-band size in screen pixels before committing a shape. */
const MIN_DRAW_SCREEN_PX = 3

/**
 * After a draw commits, the canvas machine's `drawingShape.onDone` reads this to
 * decide whether to drop into text-edit mode: it holds the new shape id for a
 * text shape, and is reset to null at the start of every draw. Single-flight —
 * draws are sequential (one `drawingShape` invocation at a time). A `fromObservable`
 * actor has no typed `output`, so this ref is how the id reaches the machine.
 */
export const pendingTextEdit: { id: string | null } = { id: null }

/**
 * Constrain a line's end point to the nearest 0/45/90° from its start while
 * preserving length — the Shift behaviour every line tool has.
 */
function constrainLineEnd(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number } {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return end
  const step = Math.PI / 4
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: start.x + Math.cos(snapped) * len, y: start.y + Math.sin(snapped) * len }
}

export function handleDrawShape(tool: DrawTool): Observable<void> {
  const initialVp = viewport.value
  const effectivePageId = getActiveOrSinglePageId()
  const page = effectivePageId ? getPage(effectivePageId) : undefined

  if (!initialVp || !effectivePageId || !page) {
    shapeDrawPreviewSignal.value = null
    lineDrawPreviewSignal.value = null
    return EMPTY
  }

  const stopper = dragStopper()
  const snap = isSnapPixelGridEnabled()

  return signalToObservable(pointerPos).pipe(
    filter((pos): pos is { x: number; y: number } => pos !== null),
    take(1),
    switchMap((initialPosition) => {
      const drawStream = signalToObservable(pointerPos).pipe(
        filter((pos): pos is { x: number; y: number } => pos !== null),
        scan(
          (_acc, pos) => {
            const x1 = Math.min(initialPosition.x, pos.x)
            const y1 = Math.min(initialPosition.y, pos.y)
            const x2 = Math.max(initialPosition.x, pos.x)
            const y2 = Math.max(initialPosition.y, pos.y)
            return { rect: makeSelrect(x1, y1, x2 - x1, y2 - y1), pos }
          },
          { rect: makeSelrect(0, 0, 0, 0), pos: initialPosition }
        ),
        takeUntil(stopper)
      )

      // `lastRect` stays the RAW screen rect (drives the click-vs-drag threshold
      // below); `lastWorld` holds the snapped world geometry when snap is on;
      // `lastPointer` is the raw current pointer — the line tool needs the actual
      // end point, not a normalized bbox corner.
      let lastRect = makeSelrect(0, 0, 0, 0)
      let lastWorld: DrawRect | null = null
      let lastPointer = initialPosition

      return concat(
        drawStream.pipe(
          tap(({ rect, pos }) => {
            lastRect = rect
            lastPointer = pos
            if (tool === 'line') {
              // The line follows its real endpoints (world space); no rect band.
              const vp = viewport.value
              if (vp) {
                const start = screenToWorld(vp, initialPosition.x, initialPosition.y)
                let end = screenToWorld(vp, pos.x, pos.y)
                if (modShift.value) end = constrainLineEnd(start, end)
                lineDrawPreviewSignal.value = { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
              }
              shapeDrawPreviewSignal.value = null
              return
            }
            lineDrawPreviewSignal.value = null
            const vp = snap ? viewport.value : null
            if (vp) {
              const snapped = snapDrawRectToGrid(rect, vp)
              lastWorld = snapped.world
              shapeDrawPreviewSignal.value = snapped.screenRect
            } else {
              lastWorld = null
              shapeDrawPreviewSignal.value = rect
            }
          }),
          map(() => undefined)
        ),
        of(null).pipe(
          // async so we can await the WASM sync below before the actor completes.
          switchMap(async () => {
            shapeDrawPreviewSignal.value = null
            lineDrawPreviewSignal.value = null
            // Reset per draw; set below only when a text shape is committed.
            pendingTextEdit.id = null

            // Click (no real drag) vs drag. Like Penpot: the text tool supports
            // click-to-create (a small auto-width box that grows with typing);
            // rect/frame require a real drag.
            // Line cares about drag length (a horizontal/vertical line has a
            // near-zero bbox side); every other tool needs both sides to clear
            // the click threshold.
            const isClick =
              tool === 'line'
                ? Math.hypot(lastRect.width, lastRect.height) < MIN_DRAW_SCREEN_PX
                : lastRect.width < MIN_DRAW_SCREEN_PX || lastRect.height < MIN_DRAW_SCREEN_PX
            if (isClick && tool !== 'text') {
              return
            }

            const vp = viewport.value
            if (!vp) return

            // When pixel snap is on, reuse the exact snapped world rect from the
            // live preview so the created shape matches the preview pixel-for-pixel.
            const snapped = snap ? lastWorld : null
            const worldOrigin = snapped
              ? { x: snapped.x, y: snapped.y }
              : screenToWorld(vp, lastRect.x, lastRect.y)
            // Click-created text: Penpot's tiny initial box (4×17 world units) with
            // auto-width grow. Dragged: the drawn size, fixed grow (min 1px when snapped).
            const w = isClick ? 4 : snapped ? Math.max(1, snapped.width) : lastRect.width / vp.zoom
            const h = isClick ? 17 : snapped ? Math.max(1, snapped.height) : lastRect.height / vp.zoom
            if (!isClick) {
              if (tool === 'line') {
                if (Math.hypot(w, h) < 1e-6) return
              } else if (w < 1e-6 || h < 1e-6) {
                return
              }
            }

            const currentPage = effectivePageId ? getPage(effectivePageId) : undefined
            if (!currentPage) return

            const root = Object.values(currentPage.objects).find((o) => o.parentId == null)
            const rootId = root?.id ?? ROOT_UUID

            // Shared geometry + the default fill/stroke used by the filled shapes.
            const geom = { x: worldOrigin.x, y: worldOrigin.y, width: w, height: h, parentId: rootId }
            const filled = {
              fillColor: '#3B82F6',
              fillOpacity: 0.85,
              strokeColor: '#1E40AF',
              strokeWidth: 2,
            }

            let newNode: PenpotNode
            switch (tool) {
              case 'frame':
                newNode = createFrame({
                  ...geom,
                  fillColor: '#F3F4F6',
                  fillOpacity: 1,
                  strokeColor: '#9CA3AF',
                  strokeWidth: 1,
                })
                break
              case 'text':
                newNode = createText({
                  ...geom,
                  // Empty: the box opens into edit mode with a blinking caret
                  // (no placeholder text), and the user types into it.
                  text: '',
                  // Click → auto-width box that grows with typing; drag → fixed
                  // box at the drawn size (Penpot's text-tool behaviour).
                  growType: isClick ? 'auto-width' : 'fixed',
                })
                break
              case 'ellipse':
                newNode = createEllipse({ ...geom, ...filled })
                break
              case 'line': {
                // A line follows its actual endpoints (any direction), with
                // Shift constraining to 0/45/90°. Open path — stroke only.
                const start = screenToWorld(vp, initialPosition.x, initialPosition.y)
                let end = screenToWorld(vp, lastPointer.x, lastPointer.y)
                if (modShift.value) end = constrainLineEnd(start, end)
                newNode = createLine({
                  x1: start.x,
                  y1: start.y,
                  x2: end.x,
                  y2: end.y,
                  parentId: rootId,
                  strokeColor: '#1E40AF',
                  strokeWidth: 2,
                })
                break
              }
              case 'triangle':
              case 'polygon':
              case 'star':
                newNode = createParametricPath(tool, { ...geom, ...filled })
                break
              default:
                newNode = createRect({ ...geom, ...filled })
                break
            }

            const addChange: AddObjChange = {
              type: 'add-obj',
              id: newNode.id,
              obj: newNode,
              frameId: rootId,
              parentId: rootId,
              index: root?.shapes?.length ?? 0,
              pageId: effectivePageId,
            }
            // Await so the shape is in the WASM scene before we enter edit mode —
            // `text_editor_focus` needs it present, otherwise the caret never
            // shows on the first click that creates the box (the sync is async).
            await applyChanges([addChange])
            setSelectedIds(new Set([newNode.id]))
            // A freshly created text shape opens straight into edit mode.
            if (tool === 'text') pendingTextEdit.id = newNode.id
          })
        )
      )
    })
  )
}
