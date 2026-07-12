/**
 * Drag-to-create shapes on the canvas (e.g. rectangle), similar to Penpot workspace draw tools.
 */

import { Observable, EMPTY, concat, of } from 'rxjs'
import { filter, map, scan, switchMap, take, takeUntil, tap } from 'rxjs/operators'
import { pointerPos, signalToObservable, viewport } from '../signals/pointer'
import { dragStopper } from '../streams/drag-stopper'
import { setSelectedIds } from '../store/document-selection'
import { shapeDrawPreview as shapeDrawPreviewSignal } from '../signals/selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { screenToWorld } from '../viewport'
import { makeSelrect } from '../../worker/types'
import { isSnapPixelGridEnabled } from '../store/workspace-settings'
import { snapDrawRectToGrid, type DrawRect } from './pixel-snap'
import { applyChanges } from '../../page-crud'
import {
  createEllipse,
  createFrame,
  createParametricPath,
  createRect,
  createSlot,
  createText,
} from '../node-factory'
import type { AddObjChange, DelObjChange, PenpotNode } from 'penpot-exporter/types'
import type { LocalNode } from '../../common/slot-shape'
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

export function handleDrawShape(tool: DrawTool): Observable<void> {
  const initialVp = viewport.value
  const effectivePageId = getActiveOrSinglePageId()
  const page = effectivePageId ? getPage(effectivePageId) : undefined

  if (!initialVp || !effectivePageId || !page) {
    shapeDrawPreviewSignal.value = null
    return EMPTY
  }

  const stopper = dragStopper()
  const snap = isSnapPixelGridEnabled()

  return signalToObservable(pointerPos).pipe(
    filter((pos): pos is { x: number; y: number } => pos !== null),
    take(1),
    switchMap((initialPosition) => {
      const selrectStream = signalToObservable(pointerPos).pipe(
        filter((pos): pos is { x: number; y: number } => pos !== null),
        scan(
          (_acc, pos) => {
            const x1 = Math.min(initialPosition.x, pos.x)
            const y1 = Math.min(initialPosition.y, pos.y)
            const x2 = Math.max(initialPosition.x, pos.x)
            const y2 = Math.max(initialPosition.y, pos.y)
            return makeSelrect(x1, y1, x2 - x1, y2 - y1)
          },
          makeSelrect(0, 0, 0, 0)
        ),
        takeUntil(stopper)
      )

      // `lastRect` stays the RAW screen rect (drives the click-vs-drag threshold
      // below); `lastWorld` holds the snapped world geometry when snap is on.
      let lastRect = makeSelrect(0, 0, 0, 0)
      let lastWorld: DrawRect | null = null

      return concat(
        selrectStream.pipe(
          tap((rect) => {
            lastRect = rect
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
            // Reset per draw; set below only when a text shape is committed.
            pendingTextEdit.id = null

            // Click (no real drag) vs drag. Like Penpot: the text tool supports
            // click-to-create (a small auto-width box that grows with typing);
            // rect/frame require a real drag.
            const isClick =
              lastRect.width < MIN_DRAW_SCREEN_PX || lastRect.height < MIN_DRAW_SCREEN_PX
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
            if (!isClick && (w < 1e-6 || h < 1e-6)) return

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

            // LocalNode: slots aren't in the upstream PenpotNode union (defined
            // locally), so widen here and cast at the change boundary below.
            let newNode: LocalNode
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
              case 'slot':
                // An empty outlet box: light fill, dashed-looking subtle stroke.
                // Renders as a clipped frame (translateShapeType maps slot→frame)
                // until a view is shown in it.
                newNode = createSlot({
                  ...geom,
                  fillColor: '#F5F3FF',
                  fillOpacity: 1,
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
              // Slot is a local extension of the node union; the commit pipeline
              // treats objects structurally (by `type` string), so cast is safe.
              obj: newNode as PenpotNode,
              frameId: rootId,
              parentId: rootId,
              index: root?.shapes?.length ?? 0,
              pageId: effectivePageId,
            }
            // Await so the shape is in the WASM scene before we enter edit mode —
            // `text_editor_focus` needs it present, otherwise the caret never
            // shows on the first click that creates the box (the sync is async).
            // Pair with the inverse del-obj so creation is undoable (Cmd+Z removes it).
            const undoChange: DelObjChange = { type: 'del-obj', id: newNode.id, pageId: effectivePageId }
            await applyChanges([addChange], { undoChanges: [undoChange] })
            setSelectedIds(new Set([newNode.id]))
            // A freshly created text shape opens straight into edit mode.
            if (tool === 'text') pendingTextEdit.id = newNode.id
          })
        )
      )
    })
  )
}
