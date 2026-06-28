/**
 * Per-frame pointer, modifier, and drag-preview state (see docs/state-architecture.md §3).
 * Handlers write `.value` at pointer rate; React reads hot values via `useSignalCoalesced`.
 */

import { computed, effect, signal } from '@preact/signals-core'
import type { Signal } from '@preact/signals-core'
import { Observable } from 'rxjs'
import type { Point } from '../types'
import type { ViewportData } from '../viewport'
import { screenToWorld } from '../viewport'

export const pointerPos = signal<Point | null>(null)

/** True while the pointer is over UI chrome (side panels / toolbars / popovers),
 *  not the canvas — used to hide canvas-only affordances like the cursor hint chip,
 *  which otherwise trail over the panels (pointerPos updates globally). */
export const pointerOverChrome = signal(false)

export const modShift = signal(false)
export const modAlt = signal(false)
export const modCtrl = signal(false)
export const modMeta = signal(false)

export const keyboardSpace = signal(false)

/** True while a viewport pan drag is in flight. The reactive canvas-cursor effect
 *  (input/cursor.ts) reads this to yield the 'grabbing' cursor to the pan gesture
 *  instead of overwriting it. Mirrors the hot-path `isPanningRef` in the viewport
 *  hook, which stays for synchronous reads during the drag. */
export const pointerPanning = signal(false)

/** Canonical pan/zoom for the canvas; writers set `.value` (see `canvas-wrapper`, `viewport-actions`). */
export const viewport = signal<ViewportData | null>(null)

/** Delta (deg) during active rotate drag; property panel reads via `useSignalCoalesced`. */
export const rotatePreviewDeltaDeg = signal(0)

/** World-space translation during move drag; property panel reads via `useSignalCoalesced`. */
export const movePreviewWorldDelta = signal<Point>({ x: 0, y: 0 })

export const worldPointerPos = computed(() => {
  const pos = pointerPos.value
  const vp = viewport.value
  if (!pos || !vp) return null
  return screenToWorld(vp, pos.x, pos.y)
})

/** Bridge for XState `fromObservable` drag pipelines that still use RxJS operators. */
export function signalToObservable<T>(sig: Signal<T>): Observable<T> {
  return new Observable((subscriber) => {
    const dispose = effect(() => {
      subscriber.next(sig.value)
    })
    return () => dispose()
  })
}
