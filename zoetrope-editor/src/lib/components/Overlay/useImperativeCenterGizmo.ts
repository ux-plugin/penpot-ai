/**
 * Keep the centre gizmo in step with the selection box during a gesture.
 *
 * The box and its handles are written straight to the DOM from a signal `effect`, which
 * runs the instant a drag assigns `wasmSelectionRect` — no frame of latency. The gizmo,
 * being ordinary React fed from `useSignalCoalesced`, waits for that hook's rAF and then a
 * render, so it lands a frame or more later. Both are drawing the SAME selection, so the
 * difference is plainly visible: the box tracks the pointer and the centre trails it.
 *
 * So the gizmo's POSITION is driven imperatively here, alongside the box. Everything else
 * about it — the pivot dot's radius, the degenerate fallback box, the rotate grab — depends
 * on zoom and on selection identity rather than on the gesture, so React keeps owning it;
 * this hook deliberately touches nothing but the transform, and never visibility.
 */

import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'
import { effect } from '@preact/signals-core'
import { wasmSelectionRect as wasmSelectionRectSignal } from '../../renderer/signals/selection'

export function useImperativeCenterGizmo(centerGRef: RefObject<SVGGElement | null>): void {
  useLayoutEffect(() => {
    return effect(() => {
      const sel = wasmSelectionRectSignal.value
      const g = centerGRef.current
      if (!g) return
      const c = sel?.center
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return
      g.setAttribute('transform', `translate(${c.x},${c.y})`)
    })
  }, [centerGRef])
}
