/**
 * Pen tool — click to place anchors, drag to pull bézier handles. Mirrors
 * Penpot's path drawing (data/workspace/path/drawing.cljs): a click adds a
 * corner node, a click-drag pulls a smooth handle out of that node, moving
 * previews the next segment, Shift fixes the angle, clicking the first anchor
 * closes the path, and Esc / Enter / double-click finishes it.
 *
 * Every anchor begins *pending* on mousedown and commits on mouseup, so the same
 * gesture covers a plain corner (down-up) and a curve (down-drag-up). Alt during
 * the drag breaks handle symmetry (out-handle only). The handler owns its own
 * DOM subscriptions for the duration of one path (it spans many clicks).
 */

import { Observable, EMPTY } from 'rxjs'
import { modShift, pointerPos, viewport } from '../signals/pointer'
import { penDrawPreview as penDrawPreviewSignal } from '../signals/selection'
import type { PenAnchorView } from '../signals/selection'
import { setSelectedIds } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { screenToWorld, worldToScreen } from '../viewport'
import { applyChanges } from '../../page-crud'
import { createBezierPath } from '../node-factory'
import { reflect, type Anchor } from '../geom/anchors'
import type { AddObjChange } from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** Screen-px radius around the first anchor that closes the path. */
const CLOSE_HIT_PX = 10
/** Min screen-px movement before a click is treated as a handle-drag (curve). */
const DRAG_PX = 4

type Pt = { x: number; y: number }

/** Constrain `end` to the nearest 0/45/90° from `start`, preserving length. */
export function constrainAngle(start: Pt, end: Pt): Pt {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return end
  const step = Math.PI / 4
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len }
}

const clonePt = (p: Pt): Pt => ({ x: p.x, y: p.y })
const cloneAnchor = (a: Anchor): PenAnchorView => ({
  point: clonePt(a.point),
  ...(a.handleIn ? { handleIn: clonePt(a.handleIn) } : {}),
  ...(a.handleOut ? { handleOut: clonePt(a.handleOut) } : {}),
})

export function handlePenDraw(): Observable<void> {
  const vp0 = viewport.value
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : undefined
  const firstScreen = pointerPos.value
  if (!vp0 || !pageId || !page || !firstScreen) {
    penDrawPreviewSignal.value = null
    return EMPTY
  }

  const anchors: Anchor[] = []
  // The click that started this session is the first anchor; the user may still
  // be holding the button to drag its out-handle, so it begins pending with the
  // button assumed down (the down already fired before we could subscribe).
  let pending: Anchor | null = { point: screenToWorld(vp0, firstScreen.x, firstScreen.y) }
  let downScreen: Pt = firstScreen
  let mouseDown = true
  let dragging = false

  const publish = (cursor: Pt | null, willClose: boolean) => {
    penDrawPreviewSignal.value = {
      anchors: anchors.map(cloneAnchor),
      pending: pending ? cloneAnchor(pending) : null,
      cursor,
      willClose,
    }
  }
  publish(null, false)

  return new Observable<void>((subscriber) => {
    let done = false

    const nearFirst = (screen: Pt): boolean => {
      const vp = viewport.value
      if (!vp || anchors.length < 2) return false
      const fs = worldToScreen(vp, anchors[0].point.x, anchors[0].point.y)
      return Math.hypot(screen.x - fs.x, screen.y - fs.y) <= CLOSE_HIT_PX
    }

    const commitPending = () => {
      if (pending) {
        anchors.push(pending)
        pending = null
      }
    }

    const commitNode = (closed: boolean) => {
      if (anchors.length < 2) return
      const currentPage = getPage(pageId)
      if (!currentPage) return
      const root = Object.values(currentPage.objects).find((o) => o.parentId == null)
      const rootId = root?.id ?? ROOT_UUID
      const node = createBezierPath(anchors, {
        parentId: rootId,
        closed,
        strokeColor: '#1E40AF',
        strokeWidth: 2,
        ...(closed ? { fillColor: '#3B82F6', fillOpacity: 0.85 } : {}),
      })
      const change: AddObjChange = {
        type: 'add-obj',
        id: node.id,
        obj: node,
        frameId: rootId,
        parentId: rootId,
        index: root?.shapes?.length ?? 0,
        pageId,
      }
      void applyChanges([change]).then(() => setSelectedIds(new Set([node.id])))
    }

    const finish = (closed: boolean) => {
      if (done) return
      done = true
      commitPending()
      commitNode(closed)
      penDrawPreviewSignal.value = null
      subscriber.next(undefined)
      subscriber.complete()
    }

    // Only canvas events count — clicks on the toolbar, side panels, or other UI
    // chrome (the overlays floating over the canvas) must not place anchors.
    const UI_CHROME =
      'aside, button, input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="toolbar"]'
    const onCanvas = (e: Event): boolean =>
      (e.target as Element | null)?.closest(UI_CHROME) == null

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !onCanvas(e)) return
      const vp = viewport.value
      const screen = pointerPos.value
      if (!vp || !screen) return
      // Missed-up guard: a still-pending anchor means a previous mouseup never
      // reached us — land it as a corner before starting the next.
      commitPending()
      if (nearFirst(screen)) {
        finish(true)
        return
      }
      let p = screenToWorld(vp, screen.x, screen.y)
      const last = anchors[anchors.length - 1]
      if (modShift.value && last) p = constrainAngle(last.point, p)
      pending = { point: p }
      downScreen = screen
      mouseDown = true
      dragging = false
      publish(p, false)
    }

    const onMove = (e: MouseEvent) => {
      const vp = viewport.value
      const screen = pointerPos.value
      if (!vp || !screen) return

      if (mouseDown && pending) {
        if (!dragging && Math.hypot(screen.x - downScreen.x, screen.y - downScreen.y) > DRAG_PX) {
          dragging = true
        }
        if (dragging) {
          // Drag pulls the out-handle; mirror it as the in-handle for a smooth
          // node, unless Alt asks for an asymmetric (out-only) handle.
          const out = screenToWorld(vp, screen.x, screen.y)
          pending.handleOut = out
          pending.handleIn = e.altKey ? undefined : reflect(pending.point, out)
          publish(null, false)
          return
        }
        publish(null, false)
        return
      }

      // Free move between anchors: trailing preview to the cursor.
      let cur = screenToWorld(vp, screen.x, screen.y)
      const last = anchors[anchors.length - 1]
      if (modShift.value && last) cur = constrainAngle(last.point, cur)
      publish(cur, nearFirst(screen))
    }

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (mouseDown && pending) {
        commitPending()
        mouseDown = false
        dragging = false
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault()
        finish(false)
      }
    }

    const onDbl = (e: MouseEvent) => {
      if (e.button === 0 && onCanvas(e)) finish(false)
    }

    window.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey)
    window.addEventListener('dblclick', onDbl)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dblclick', onDbl)
      if (!done) penDrawPreviewSignal.value = null
    }
  })
}
