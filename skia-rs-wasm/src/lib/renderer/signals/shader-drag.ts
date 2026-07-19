/**
 * Pointer-driven drag of a shader from the Assets panel onto the canvas — the
 * custom replacement for native HTML5 drag-and-drop. Native DnD can't give us a
 * custom cursor chip, a live preview, or hover feedback; a pointer drag can.
 *
 * The drag publishes its state to `shaderDrag` (a signal); `ShaderDragOverlay`
 * renders the chip, the target outline/name, and the empty-canvas ghost from it.
 *
 * **Target resolution.** As the cursor moves we hit-test the point (the SAME
 * query the click-selection uses), then walk the hit up to the OUTERMOST element
 * under the page root — the "upper-most component" — because with unbounded
 * nesting the innermost leaf is rarely the intended target. One deterministic
 * target, no depth stepping. On empty canvas the target is a ghost rectangle the
 * drop would create. Coordinates are client-space; `surfaceOrigin` converts to
 * the surface-relative space the hit-test/world math expect.
 */

import { signal } from '@preact/signals-core'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { ShaderPreset } from '../shader-lang/presets'
import { viewport } from './pointer'
import { useWorkspaceStore } from '../store/workspace-store'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { worldToScreen } from '../viewport'
import { queryNodesAtPoint, pickTopmostNode } from '../selection/query-at-point'
import { applyShaderToNode, createRectWithShader } from '../handlers/shader-drop'
import type { IndexedPage } from '../../worker/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** World size of a rectangle created by dropping on empty canvas (matches shader-drop). */
const NEW_W = 240
const NEW_H = 160
/** Pointer travel before a press becomes a drag (vs a click-to-apply). */
const DRAG_THRESHOLD = 4

/** A rectangle in CLIENT coordinates (what the overlay positions against). */
export interface DragRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ShaderDragTargetComponent {
  kind: 'component'
  nodeId: string
  name: string
  rect: DragRect
}
export interface ShaderDragTargetEmpty {
  kind: 'empty'
  rect: DragRect
}

export interface ShaderDragState {
  preset: ShaderPreset
  /** Cursor position in client coordinates. */
  cursor: { x: number; y: number }
  /** The resolved drop target, or null while the cursor is off the canvas. */
  target: ShaderDragTargetComponent | ShaderDragTargetEmpty | null
}

export const shaderDrag = signal<ShaderDragState | null>(null)

let surfaceOrigin = { left: 0, top: 0, width: 0, height: 0 }
let hitInFlight = false
let hitLatest: { x: number; y: number } | null = null
let clickSuppressUntil = 0

function findSurface(): HTMLElement | null {
  return document.querySelector('[data-canvas-surface]')
}

/** Is the client point over the canvas (not a floating panel)? */
function overCanvas(clientX: number, clientY: number): boolean {
  const el = document.elementFromPoint(clientX, clientY)
  return !!el?.closest('[data-canvas-surface]')
}

/** Walk up to the top-level object under the page root (the "upper-most component"). */
function outermostUnderRoot(page: IndexedPage, nodeId: string): string {
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id
  let cur = nodeId
  for (let i = 0; i < 128; i++) {
    const parent = (page.objects[cur] as { parentId?: string } | undefined)?.parentId
    if (!parent || parent === rootId) break
    cur = parent
  }
  return cur
}

function nodeClientRect(page: IndexedPage, nodeId: string): DragRect | null {
  const vp = viewport.value
  const node = page.objects[nodeId] as { selrect?: { x: number; y: number; width: number; height: number } } | undefined
  if (!vp || !node?.selrect) return null
  const s = node.selrect
  const tl = worldToScreen(vp, s.x, s.y)
  return {
    left: tl.x + surfaceOrigin.left,
    top: tl.y + surfaceOrigin.top,
    width: s.width * vp.zoom,
    height: s.height * vp.zoom,
  }
}

/** Ghost rect (client coords) for a new shape centered on the cursor. */
function emptyGhost(cursorX: number, cursorY: number): DragRect {
  const vp = viewport.value
  const zoom = vp?.zoom ?? 1
  const w = NEW_W * zoom
  const h = NEW_H * zoom
  return { left: cursorX - w / 2, top: cursorY - h / 2, width: w, height: h }
}

async function runHitTest(): Promise<void> {
  if (hitInFlight || !hitLatest) return
  const pt = hitLatest
  hitLatest = null
  hitInFlight = true
  try {
    const cur = shaderDrag.peek()
    const { workerClient } = useWorkspaceStore.getState()
    const pageId = getActiveOrSinglePageId()
    const vp = viewport.value
    if (!cur || !workerClient || !pageId || !vp) return

    let target: ShaderDragState['target'] = null
    const withinSurface =
      pt.x >= 0 && pt.y >= 0 && pt.x <= surfaceOrigin.width && pt.y <= surfaceOrigin.height
    if (withinSurface) {
      const ids = await queryNodesAtPoint(workerClient, pageId, vp, pt.x, pt.y)
      const page = getPage(pageId)
      const top = pickTopmostNode(page, ids)
      const latest = shaderDrag.peek()
      if (!latest) return
      if (page && top && top !== ROOT_UUID) {
        const outer = outermostUnderRoot(page, top)
        const rect = nodeClientRect(page, outer)
        if (rect) {
          const name = (page.objects[outer] as { name?: string }).name ?? 'Component'
          target = { kind: 'component', nodeId: outer, name, rect }
        }
      }
      if (!target) {
        target = { kind: 'empty', rect: emptyGhost(latest.cursor.x, latest.cursor.y) }
      }
    }
    const now = shaderDrag.peek()
    if (now) shaderDrag.value = { ...now, target }
  } finally {
    hitInFlight = false
    if (hitLatest) void runHitTest()
  }
}

function onMove(e: PointerEvent): void {
  const cur = shaderDrag.peek()
  if (!cur) return
  const cursor = { x: e.clientX, y: e.clientY }
  // Keep the empty ghost glued to the cursor between hit-tests; the outline for a
  // component target waits for the (async) hit-test to re-resolve.
  const target =
    cur.target?.kind === 'empty' ? { kind: 'empty' as const, rect: emptyGhost(cursor.x, cursor.y) } : cur.target
  shaderDrag.value = { ...cur, cursor, target }
  hitLatest = { x: e.clientX - surfaceOrigin.left, y: e.clientY - surfaceOrigin.top }
  void runHitTest()
}

function onUp(e: PointerEvent): void {
  const cur = shaderDrag.peek()
  teardown()
  shaderDrag.value = null
  if (!cur) return
  clickSuppressUntil = performance.now() + 300
  // A release over a floating panel cancels — you dropped off the canvas.
  if (!overCanvas(e.clientX, e.clientY)) return
  const t = cur.target
  if (t?.kind === 'component') {
    void applyShaderToNode(cur.preset.material, t.nodeId)
  } else {
    void createRectWithShader(cur.preset.material, e.clientX - surfaceOrigin.left, e.clientY - surfaceOrigin.top)
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    teardown()
    shaderDrag.value = null
  }
}

function teardown(): void {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('keydown', onKey, true)
}

function startShaderDrag(preset: ShaderPreset, clientX: number, clientY: number): void {
  const rect = findSurface()?.getBoundingClientRect()
  surfaceOrigin = {
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight,
  }
  shaderDrag.value = { preset, cursor: { x: clientX, y: clientY }, target: null }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey, true)
  hitLatest = { x: clientX - surfaceOrigin.left, y: clientY - surfaceOrigin.top }
  void runHitTest()
}

/**
 * Arm a drag from a shader card's `pointerdown`. Promotes to a real drag only
 * past a small travel threshold, so a plain click still falls through to the
 * card's click-to-apply. Call from the card's `onPointerDown`.
 */
export function armShaderDrag(preset: ShaderPreset, e: ReactPointerEvent): void {
  const start = { x: e.clientX, y: e.clientY }
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
      detach()
      startShaderDrag(preset, ev.clientX, ev.clientY)
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

/** True if a drag just ended — the card's onClick should ignore this click. */
export function consumeShaderDragClick(): boolean {
  if (performance.now() < clickSuppressUntil) {
    clickSuppressUntil = 0
    return true
  }
  return false
}
