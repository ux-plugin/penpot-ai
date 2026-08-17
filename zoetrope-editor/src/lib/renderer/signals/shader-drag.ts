/**
 * Pointer-driven drag of a shader from the Assets panel onto the canvas — the
 * custom replacement for native HTML5 drag-and-drop. Native DnD can't give us a
 * custom cursor chip, a live preview, or hover feedback; a pointer drag can.
 *
 * The drop PREVIEW is drawn by the real renderer: as the cursor moves we load a
 * transient, shader-filled clone of the hovered shape into the WASM store (see
 * `handlers/shader-preview-node` — the shader twin of the flex drop placeholder).
 * That gives a WYSIWYG fill clipped to the shape's true silhouette, animated, and
 * under the floating tools (it's canvas content), with no overlay/clip math. The
 * clone is WASM-only — never in docProxy or undo — and is destroyed on release.
 * The cursor chip + target label are the only DOM chrome (`ShaderDragOverlay`).
 *
 * **Target resolution.** A shader is a fill: the whole shape is a valid target,
 * even one with no fill (an unfilled path you can't click "inside"). So we don't
 * use the fill-based selection hit-test — we test the cursor against the SELRECT
 * of each TOP-LEVEL object (the "upper-most component"), topmost by draw order.
 * That makes any shape droppable anywhere in its bounds and is deterministic
 * regardless of nesting depth. Off every top-level bound → an empty-canvas rect.
 */

import { signal } from '@preact/signals-core'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { ShaderPreset } from '../shader-lang/presets'
import { viewport } from './pointer'
import { useWorkspaceStore } from '../store/workspace-store'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { worldToScreen, screenToWorld } from '../viewport'
import { applyShaderToNode, createRectWithShader } from '../handlers/shader-drop'
import {
  showShaderPreviewForNode,
  showShaderPreviewRect,
  hideShaderPreview,
  type ShaderPreviewNode,
} from '../handlers/shader-preview-node'
import type { IndexedPage } from '../../worker/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** World size of a rectangle created by dropping on empty canvas (matches shader-drop). */
const NEW_W = 240
const NEW_H = 160
/** Pointer travel before a press becomes a drag (vs a click-to-apply). */
const DRAG_THRESHOLD = 4

/** A rectangle in CLIENT coordinates (what the DOM overlay positions against). */
export interface DragRect {
  left: number
  top: number
  width: number
  height: number
}

/** A rectangle in WORLD coordinates (for the transient preview rect). */
export interface WorldRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ShaderDragTargetComponent {
  kind: 'component'
  nodeId: string
  name: string
  /** Client-space bounds — for the label in the fixed overlay. */
  rect: DragRect
}
export interface ShaderDragTargetEmpty {
  kind: 'empty'
  rect: DragRect
  /** World-space ghost bounds (for the transient preview rect). */
  world: WorldRect
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
let clickSuppressUntil = 0
/** The live transient preview clone in WASM, or null when none is showing. */
let preview: ShaderPreviewNode | null = null

function findSurface(): HTMLElement | null {
  return document.querySelector('[data-canvas-surface]')
}

/** Is the client point over the canvas (not a floating panel)? */
function overCanvas(clientX: number, clientY: number): boolean {
  const el = document.elementFromPoint(clientX, clientY)
  return !!el?.closest('[data-canvas-surface]')
}

interface Selrect {
  x: number
  y: number
  width: number
  height: number
}

interface RootInfo {
  rootId: string
  /** The root's DOCUMENT child list (never includes the transient preview). */
  rootChildIds: readonly string[]
}

function getRootInfo(page: IndexedPage): RootInfo | null {
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  if (!root?.id) return null
  return { rootId: root.id, rootChildIds: root.shapes ?? [] }
}

/**
 * Topmost top-level object whose selrect contains the world point, or null. We
 * scan `root.shapes` (draw order, last = top) and keep the last match, so an
 * overlapping shape drawn later wins — mirroring visual stacking.
 */
function topLevelHit(page: IndexedPage, wx: number, wy: number): string | null {
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const children = root?.shapes
  if (!children) return null
  let hit: string | null = null
  for (const id of children) {
    if (id === ROOT_UUID) continue
    const s = (page.objects[id] as { selrect?: Selrect } | undefined)?.selrect
    if (s && wx >= s.x && wx <= s.x + s.width && wy >= s.y && wy <= s.y + s.height) {
      hit = id
    }
  }
  return hit
}

function nodeClientRect(page: IndexedPage, nodeId: string): DragRect | null {
  const vp = viewport.value
  const node = page.objects[nodeId] as { selrect?: Selrect } | undefined
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

/** World-space ghost bounds matching {@link emptyGhost}, for the preview rect. */
function emptyGhostWorld(cursorX: number, cursorY: number): WorldRect {
  const vp = viewport.value
  const c = vp ? screenToWorld(vp, cursorX - surfaceOrigin.left, cursorY - surfaceOrigin.top) : { x: 0, y: 0 }
  return { x: c.x - NEW_W / 2, y: c.y - NEW_H / 2, width: NEW_W, height: NEW_H }
}

/** Synchronously resolve the drop target for a client-space cursor. */
function resolveTarget(clientX: number, clientY: number): ShaderDragState['target'] {
  const sx = clientX - surfaceOrigin.left
  const sy = clientY - surfaceOrigin.top
  const within = sx >= 0 && sy >= 0 && sx <= surfaceOrigin.width && sy <= surfaceOrigin.height
  if (!within) return null

  const vp = viewport.value
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : null
  if (vp && page) {
    const world = screenToWorld(vp, sx, sy)
    const id = topLevelHit(page, world.x, world.y)
    if (id) {
      const rect = nodeClientRect(page, id)
      if (rect) {
        const name = (page.objects[id] as { name?: string }).name ?? 'Component'
        return { kind: 'component', nodeId: id, name, rect }
      }
    }
  }
  return { kind: 'empty', rect: emptyGhost(clientX, clientY), world: emptyGhostWorld(clientX, clientY) }
}

/** Drive the transient WASM preview clone to match the resolved target. */
function syncPreview(target: ShaderDragState['target'], material: ShaderPreset['material']): void {
  const renderer = useWorkspaceStore.getState().renderer
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : null
  const root = page ? getRootInfo(page) : null
  if (!renderer || !page || !root) return

  if (target?.kind === 'component') {
    const node = page.objects[target.nodeId] as Record<string, unknown> | undefined
    if (node) {
      preview = showShaderPreviewForNode(
        renderer,
        root.rootId,
        root.rootChildIds,
        target.nodeId,
        node,
        material,
        preview,
      )
      return
    }
  } else if (target?.kind === 'empty') {
    preview = showShaderPreviewRect(renderer, root.rootId, root.rootChildIds, target.world, material, preview)
    return
  }
  clearPreview()
}

/** Tear down the transient preview clone, if any. */
function clearPreview(): void {
  if (!preview) return
  const renderer = useWorkspaceStore.getState().renderer
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : null
  const root = page ? getRootInfo(page) : null
  if (renderer && root) hideShaderPreview(renderer, root.rootChildIds, preview)
  preview = null
}

function onMove(e: PointerEvent): void {
  const cur = shaderDrag.peek()
  if (!cur) return
  const target = resolveTarget(e.clientX, e.clientY)
  syncPreview(target, cur.preset.material)
  shaderDrag.value = { ...cur, cursor: { x: e.clientX, y: e.clientY }, target }
}

function onUp(e: PointerEvent): void {
  const cur = shaderDrag.peek()
  const t = cur?.target
  const overCanvasNow = overCanvas(e.clientX, e.clientY)
  teardown()
  clearPreview()
  shaderDrag.value = null
  if (!cur) return
  clickSuppressUntil = performance.now() + 300
  // A release over a floating panel cancels — you dropped off the canvas.
  if (!overCanvasNow) return
  if (t?.kind === 'component') {
    void applyShaderToNode(cur.preset.material, t.nodeId)
  } else {
    void createRectWithShader(cur.preset.material, e.clientX - surfaceOrigin.left, e.clientY - surfaceOrigin.top)
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    teardown()
    clearPreview()
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
  const target = resolveTarget(clientX, clientY)
  syncPreview(target, preset.material)
  shaderDrag.value = { preset, cursor: { x: clientX, y: clientY }, target }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey, true)
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
