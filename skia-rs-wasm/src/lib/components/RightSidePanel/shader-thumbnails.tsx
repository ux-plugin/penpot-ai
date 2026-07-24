/**
 * Shared shader-thumbnail rendering, used by both the preset modal and the
 * Assets panel. Every visible thumbnail is a real preview of its shader, drawn
 * by the SAME isolated preview surface the editor uses — one GL context feeding
 * N cells.
 *
 * Thumbnails ANIMATE: a single module-level rAF loop round-robins the mounted
 * presets, drawing one per frame on the shared surface and blitting it into that
 * preset's cell(s). One draw+blit per frame keeps it cheap; with a handful of
 * presets each still updates several times a second.
 *
 * **Contention.** That surface is a singleton the focus editor also animates, so
 * the loop is gated: it runs only while at least one thumbnail is mounted AND no
 * focus stage is active. Opening the editor pauses it (the last frame stays
 * frozen in each cell — cells are independent 2D canvases, unaffected by what
 * the surface does next); closing it resumes (via a `focusStage` subscription).
 * When the last thumbnail unmounts (tab switched away) the loop stops and the
 * surface is released. A per-preset cache repaints a cell instantly on (re)mount
 * before the loop's next pass reaches it.
 */

import { useEffect, useRef } from 'react'
import type { Material } from '../../renderer/api/material'
import { getWasmModule } from '../../renderer/wasm-module'
import { focusStage, isFocusStageActive } from '../../renderer/signals/focus-stage'
import {
  attachPreview,
  blitPreviewTo,
  detachPreview,
  drawPreview,
  isPreviewSupported,
} from '../../renderer/focus-preview'
import type { WasmModule } from '../../renderer/wasm-types'

export const THUMB_W = 220
export const THUMB_H = 132
/** Thumbnails loop over this many seconds (matches the preview's default). */
const LOOP_SECONDS = 4

export interface ThumbEntry {
  id: string
  material: Material
  /** Representative phase — unused while animating; kept so presets satisfy the type. */
  thumbPhase: number
}

function dpr(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

/** Latest rendered frame per preset — repaints a cell instantly on (re)mount. */
const cache = new Map<string, HTMLCanvasElement>()
/** Mounted cells wanting live updates, by preset id. */
const registry = new Map<string, { entry: ThumbEntry; cells: Set<HTMLCanvasElement> }>()

let host: HTMLDivElement | null = null
let attached = false
let rafId: number | null = null
let rrIndex = 0
let clockStart = 0

function ensureAttached(module: WasmModule): boolean {
  if (attached) return true
  if (!host) {
    host = document.createElement('div')
    host.style.cssText = `position:fixed;left:-9999px;top:0;width:${THUMB_W}px;height:${THUMB_H}px;pointer-events:none`
    document.body.appendChild(host)
  }
  attached = attachPreview(module, host, THUMB_W, THUMB_H)
  return attached
}

function releaseSurface(): void {
  if (rafId != null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (attached) {
    const module = getWasmModule()
    if (module) detachPreview(module)
    attached = false
  }
}

/** Animated (time, phase) shared by every thumbnail this frame. */
function clock(): { time: number; phase: number } {
  const now = performance.now()
  if (clockStart === 0) clockStart = now
  const t = (now - clockStart) / 1000
  return { time: t % LOOP_SECONDS, phase: (t / LOOP_SECONDS) % 1 }
}

function paintFromCache(id: string, cell: HTMLCanvasElement): void {
  const src = cache.get(id)
  if (src) cell.getContext('2d')?.drawImage(src, 0, 0)
}

function renderEntry(module: WasmModule, entry: ThumbEntry): void {
  const { time, phase } = clock()
  drawPreview(module, entry.material, time, phase)
  // Update the cache (for instant remount paint) then every mounted cell — all
  // copy the same just-drawn surface frame.
  let c = cache.get(entry.id)
  if (!c) {
    c = document.createElement('canvas')
    c.width = Math.round(THUMB_W * dpr())
    c.height = Math.round(THUMB_H * dpr())
    cache.set(entry.id, c)
  }
  const cctx = c.getContext('2d')
  if (cctx) blitPreviewTo(cctx)
  const reg = registry.get(entry.id)
  if (reg) {
    for (const cell of reg.cells) {
      const ctx = cell.getContext('2d')
      if (ctx) blitPreviewTo(ctx)
    }
  }
}

/**
 * The shared offscreen surface is busy only while a focus stage edits. A shader
 * DRAG no longer contends for it — its drop preview is rendered by the main canvas
 * (a transient WASM clone), so thumbnails (and the cursor chip) keep animating.
 */
function surfaceBusy(): boolean {
  return isFocusStageActive()
}

function tick(): void {
  rafId = null
  if (registry.size === 0 || surfaceBusy()) {
    releaseSurface()
    return
  }
  const module = getWasmModule()
  if (!module || !isPreviewSupported(module) || !ensureAttached(module)) {
    releaseSurface()
    return
  }
  const ids = [...registry.keys()]
  const reg = registry.get(ids[rrIndex % ids.length])
  rrIndex++
  if (reg) renderEntry(module, reg.entry)
  rafId = requestAnimationFrame(tick)
}

function startLoop(): void {
  if (rafId == null && registry.size > 0 && !surfaceBusy()) {
    rafId = requestAnimationFrame(tick)
  }
}

// Resume when the surface frees up (a focus stage closes); pause is handled
// inside `tick` (it bails while the surface is busy). Subscribed once.
focusStage.subscribe(() => (surfaceBusy() ? releaseSurface() : startLoop()))

function register(entry: ThumbEntry, cell: HTMLCanvasElement): void {
  let reg = registry.get(entry.id)
  if (!reg) {
    reg = { entry, cells: new Set() }
    registry.set(entry.id, reg)
  }
  reg.cells.add(cell)
  // Immediate first paint (synchronous, not waiting on the rAF loop) so the cell
  // never flashes blank — and so it renders at all where rAF is throttled. The
  // loop then takes over to animate.
  if (!cache.has(entry.id)) {
    const module = getWasmModule()
    if (module && isPreviewSupported(module) && !surfaceBusy() && ensureAttached(module)) {
      renderEntry(module, entry)
    }
  }
  paintFromCache(entry.id, cell)
  startLoop()
}

function unregister(id: string, cell: HTMLCanvasElement): void {
  const reg = registry.get(id)
  if (reg) {
    reg.cells.delete(cell)
    if (reg.cells.size === 0) registry.delete(id)
  }
  if (registry.size === 0) releaseSurface()
}

/** A live, animating thumbnail of `entry`'s shader. */
export function ShaderThumbnail({ entry }: { entry: ThumbEntry }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cell = ref.current
    if (!cell) return
    const d = dpr()
    cell.width = Math.round(THUMB_W * d)
    cell.height = Math.round(THUMB_H * d)
    register(entry, cell)
    return () => unregister(entry.id, cell)
  }, [entry])
  return <canvas ref={ref} className="h-full w-full object-cover" />
}
