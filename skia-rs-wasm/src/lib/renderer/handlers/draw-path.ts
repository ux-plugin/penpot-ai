/**
 * Pen tool — click to place straight-segment anchors, building a path. Mirrors
 * Penpot's path drawing (data/workspace/path/drawing.cljs): a click adds a node,
 * moving previews the next segment, Shift fixes the angle, clicking the first
 * anchor closes the path, and Esc / Enter / double-click finishes it.
 *
 * Bézier handles via click-drag are a planned follow-up; this iteration is
 * straight segments only. The handler owns its own DOM event subscriptions for
 * the duration of one path (it spans many clicks), completing on finish.
 */

import { Observable, EMPTY } from 'rxjs'
import { filter } from 'rxjs/operators'
import { modShift, pointerPos, signalToObservable, viewport } from '../signals/pointer'
import { penDrawPreview as penDrawPreviewSignal } from '../signals/selection'
import { setSelectedIds } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { screenToWorld, worldToScreen } from '../viewport'
import { applyChanges } from '../../page-crud'
import { createPolyline } from '../node-factory'
import type { AddObjChange } from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** Screen-px radius around the first anchor that closes the path. */
const CLOSE_HIT_PX = 10

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

export function handlePenDraw(): Observable<void> {
  const vp0 = viewport.value
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : undefined
  const firstScreen = pointerPos.value
  if (!vp0 || !pageId || !page || !firstScreen) {
    penDrawPreviewSignal.value = null
    return EMPTY
  }

  // Anchor 1 comes from the click that started the session (the handler's own
  // mousedown listener subscribes after this, so it never double-counts it).
  const anchors: Pt[] = [screenToWorld(vp0, firstScreen.x, firstScreen.y)]
  penDrawPreviewSignal.value = { anchors: [...anchors], cursor: null, willClose: false }

  return new Observable<void>((subscriber) => {
    let done = false

    const nearFirst = (screen: Pt): boolean => {
      const vp = viewport.value
      if (!vp || anchors.length < 2) return false
      const fs = worldToScreen(vp, anchors[0].x, anchors[0].y)
      return Math.hypot(screen.x - fs.x, screen.y - fs.y) <= CLOSE_HIT_PX
    }

    const commit = (closed: boolean) => {
      if (anchors.length < 2) return
      const currentPage = getPage(pageId)
      if (!currentPage) return
      const root = Object.values(currentPage.objects).find((o) => o.parentId == null)
      const rootId = root?.id ?? ROOT_UUID
      const node = createPolyline(anchors, {
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
      commit(closed)
      penDrawPreviewSignal.value = null
      subscriber.next(undefined)
      subscriber.complete()
    }

    // Preview: trailing segment from the last anchor to the cursor.
    const moveSub = signalToObservable(pointerPos)
      .pipe(filter((p): p is Pt => p !== null))
      .subscribe((screen) => {
        const vp = viewport.value
        if (!vp) return
        let cur = screenToWorld(vp, screen.x, screen.y)
        const last = anchors[anchors.length - 1]
        if (modShift.value) cur = constrainAngle(last, cur)
        penDrawPreviewSignal.value = {
          anchors: [...anchors],
          cursor: cur,
          willClose: nearFirst(screen),
        }
      })

    // Only canvas clicks place anchors — clicks on the toolbar, side panels, or
    // other UI chrome (the overlays floating over the canvas) must not.
    const UI_CHROME =
      'aside, button, input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="toolbar"]'
    const onCanvas = (e: Event): boolean =>
      (e.target as Element | null)?.closest(UI_CHROME) == null

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !onCanvas(e)) return
      const vp = viewport.value
      const screen = pointerPos.value
      if (!vp || !screen) return
      if (nearFirst(screen)) {
        finish(true)
        return
      }
      let p = screenToWorld(vp, screen.x, screen.y)
      const last = anchors[anchors.length - 1]
      if (modShift.value) p = constrainAngle(last, p)
      // Skip a duplicate point (also collapses the two mousedowns of a dblclick).
      if (Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) {
        anchors.push(p)
        penDrawPreviewSignal.value = { anchors: [...anchors], cursor: p, willClose: false }
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
    window.addEventListener('keydown', onKey)
    window.addEventListener('dblclick', onDbl)

    return () => {
      moveSub.unsubscribe()
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dblclick', onDbl)
      if (!done) penDrawPreviewSignal.value = null
    }
  })
}
