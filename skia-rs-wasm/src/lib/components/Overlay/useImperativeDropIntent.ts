/**
 * Imperative drag drop-intent overlay — mirrors useImperativeSelectionRect.
 *
 * Reads `dropIntentSignal` (+ viewport) and drives a world-space `<g>` holding a
 * target-highlight `<rect>` and an insertion `<line>`. Hidden when there's no
 * intent. Authored in world coords; the SVG's viewBox maps world→screen, so we
 * only scale stroke widths by 1/zoom.
 */
import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'
import { effect } from '@preact/signals-core'
import { viewport as viewportSignal } from '../../renderer/signals/pointer'
import { dropIntentSignal } from '../../renderer/signals/drop-intent'

const HIGHLIGHT_STROKE = 2
const LINE_STROKE = 2.5
const STROKE_MAX = 6

export function useImperativeDropIntent(
  gRef: RefObject<SVGGElement | null>,
  rectRef: RefObject<SVGRectElement | null>,
  lineRef: RefObject<SVGLineElement | null>,
  ghostRef: RefObject<SVGRectElement | null>,
): void {
  useLayoutEffect(() => {
    return effect(() => {
      const intent = dropIntentSignal.value
      const vp = viewportSignal.value
      const g = gRef.current
      const r = rectRef.current
      const l = lineRef.current
      const ghost = ghostRef.current
      if (!g || !r || !l || !ghost) return
      if (!intent || !vp || !Number.isFinite(vp.zoom) || vp.zoom <= 0) {
        g.style.display = 'none'
        return
      }
      const zoom = vp.zoom
      g.style.display = ''

      const tr = intent.targetRect
      r.setAttribute('x', String(tr.x))
      r.setAttribute('y', String(tr.y))
      r.setAttribute('width', String(tr.width))
      r.setAttribute('height', String(tr.height))
      r.setAttribute('stroke-width', String(Math.min(HIGHLIGHT_STROKE / zoom, STROKE_MAX)))

      // The ghost footprint stands in for the insertion line, so only show the line
      // when there's no footprint (e.g. missing shape size).
      if (intent.line && !intent.footprint) {
        l.style.display = ''
        l.setAttribute('x1', String(intent.line.x1))
        l.setAttribute('y1', String(intent.line.y1))
        l.setAttribute('x2', String(intent.line.x2))
        l.setAttribute('y2', String(intent.line.y2))
        l.setAttribute('stroke-width', String(Math.min(LINE_STROKE / zoom, STROKE_MAX)))
      } else {
        l.style.display = 'none'
      }

      // The footprint ghost is now drawn by the WASM placeholder itself (a dashed
      // outline mirroring the dragged shape), so the overlay no longer draws a rect
      // for it. `intent.footprint` is still set upstream to keep the insertion line
      // hidden while the placeholder is showing.
      ghost.style.display = 'none'
    })
  }, [gRef, rectRef, lineRef, ghostRef])
}
