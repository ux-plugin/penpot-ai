/**
 * Pointer-driven drag of a component from the Assets panel onto the canvas.
 *
 * The same custom-drag approach as `shader-drag` (native HTML5 DnD can't give us
 * a cursor chip or live feedback), but a good deal simpler: a component drop has
 * no target to resolve. A shader has to land *on* a shape, so that drag hit-tests
 * every top-level object as it moves; a copy is placed wherever the cursor is, so
 * all this tracks is the position and a ghost box the size of the main.
 *
 * The ghost is DOM chrome rather than a transient WASM clone — a plain outline of
 * where the copy will land is all the feedback the gesture needs, and it keeps
 * the renderer out of an interaction that is otherwise pure document work.
 *
 * Release over a floating panel cancels; Escape cancels.
 */

import { signal } from '@preact/signals-core'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { LocalComponent } from '../../common/component'
import { viewport } from './pointer'
import { getNode } from '../../doc'
import { screenToWorld } from '../viewport'
import { instantiateComponent } from '../component/component-crud'
import { setSelectedIds } from '../store/document-selection'

/** Fallback ghost size when the main can't be measured (e.g. it lives on another page). */
const FALLBACK_W = 200
const FALLBACK_H = 100
/** Pointer travel before a press becomes a drag (vs a click-to-place). */
const DRAG_THRESHOLD = 4

/** A rectangle in CLIENT coordinates (what the DOM overlay positions against). */
export interface DragRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ComponentDragState {
  component: LocalComponent
  cursor: { x: number; y: number }
  /** Where the copy would land, in client coords. Null while off the canvas. */
  ghost: DragRect | null
}

export const componentDrag = signal<ComponentDragState | null>(null)

let surfaceOrigin = { left: 0, top: 0, width: 0, height: 0 }
let clickSuppressUntil = 0

function findSurface(): HTMLElement | null {
  return document.querySelector('[data-canvas-surface]')
}

/** Is the client point over the canvas (not a floating panel)? */
function overCanvas(clientX: number, clientY: number): boolean {
  const el = document.elementFromPoint(clientX, clientY)
  return !!el?.closest('[data-canvas-surface]')
}

/** World size of the component's main, for the ghost and for centring the drop. */
function mainSize(component: LocalComponent): { width: number; height: number } {
  const sr = getNode(component.mainInstanceId)?.selrect
  return {
    width: sr?.width && sr.width > 0 ? sr.width : FALLBACK_W,
    height: sr?.height && sr.height > 0 ? sr.height : FALLBACK_H,
  }
}

/**
 * Ghost rect (client coords) for a copy centred on the cursor, or null where a
 * drop wouldn't land.
 *
 * Uses the same `overCanvas` hit-test the drop does rather than the surface's
 * bounding rect: the two disagree along the panel edges, and a ghost drawn where
 * the release will be rejected promises a placement that never happens.
 */
function ghostFor(component: LocalComponent, clientX: number, clientY: number): DragRect | null {
  if (!overCanvas(clientX, clientY)) return null
  const zoom = viewport.value?.zoom ?? 1
  const size = mainSize(component)
  const w = size.width * zoom
  const h = size.height * zoom
  return { left: clientX - w / 2, top: clientY - h / 2, width: w, height: h }
}

/** Top-left world position for a copy centred on a client point. */
function dropPosition(
  component: LocalComponent,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const vp = viewport.value
  if (!vp) return null
  const world = screenToWorld(vp, clientX - surfaceOrigin.left, clientY - surfaceOrigin.top)
  const size = mainSize(component)
  return { x: world.x - size.width / 2, y: world.y - size.height / 2 }
}

function onMove(e: PointerEvent): void {
  const cur = componentDrag.peek()
  if (!cur) return
  componentDrag.value = {
    ...cur,
    cursor: { x: e.clientX, y: e.clientY },
    ghost: ghostFor(cur.component, e.clientX, e.clientY),
  }
}

function onUp(e: PointerEvent): void {
  const cur = componentDrag.peek()
  const droppedOnCanvas = overCanvas(e.clientX, e.clientY)
  teardown()
  componentDrag.value = null
  if (!cur) return
  clickSuppressUntil = performance.now() + 300
  // A release over a floating panel cancels — you dropped off the canvas.
  if (!droppedOnCanvas) return
  const at = dropPosition(cur.component, e.clientX, e.clientY)
  void instantiateComponent(cur.component.id, at ?? undefined).then((copyId) => {
    if (copyId) setSelectedIds(new Set([copyId]))
  })
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    teardown()
    componentDrag.value = null
  }
}

function teardown(): void {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('keydown', onKey, true)
}

function startComponentDrag(component: LocalComponent, clientX: number, clientY: number): void {
  const rect = findSurface()?.getBoundingClientRect()
  surfaceOrigin = {
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight,
  }
  componentDrag.value = {
    component,
    cursor: { x: clientX, y: clientY },
    ghost: ghostFor(component, clientX, clientY),
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey, true)
}

/**
 * Arm a drag from a component row's `pointerdown`. Promotes to a real drag only
 * past a small travel threshold, so a plain click still falls through to the
 * row's click-to-place. Call from the row's `onPointerDown`.
 */
export function armComponentDrag(component: LocalComponent, e: ReactPointerEvent): void {
  const start = { x: e.clientX, y: e.clientY }
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
      detach()
      startComponentDrag(component, ev.clientX, ev.clientY)
    }
  }
  const up = () => detach()
  const detach = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** True if a drag just ended — the row's onClick should ignore this click. */
export function consumeComponentDragClick(): boolean {
  if (performance.now() < clickSuppressUntil) {
    clickSuppressUntil = 0
    return true
  }
  return false
}
