/**
 * The shared focus-mode preview surface — ONE canvas + ONE extra WebGL2
 * context, owned by the FocusStage system and reused by every focus mode
 * (shader today; 3D/animation later).
 *
 * **Why shared, not per-feature.** A WebGL context is bound to exactly one
 * canvas *element* for life — it can't be re-pointed. So a canvas per feature
 * would mean a GL context per feature, against a browser cap of ~16. Focus
 * modes are mutually exclusive (it's a takeover; only one is ever live), so a
 * single surface serves them all: main canvas + three.js overlay + this = 3.
 *
 * **Why the element is a singleton.** Since a context dies with its element,
 * letting React mount/unmount the canvas would destroy and rebuild the context
 * on every open — paying a context create + `GrDirectContext` build + a full
 * per-context shader program re-compile each time. Instead the element lives
 * here forever and panes `attach`/`detach` it by reparenting, which preserves
 * the context. Closing focus only *purges* GPU memory (`_preview_purge`),
 * keeping the context warm so reopening is instant.
 *
 * **Context discipline.** Every wasm `_preview_*` call is wrapped in
 * make-current → call → restore-previous. The Rust side binds whatever context
 * is current (`Interface::new_native()`, and `preview_init` reads
 * `GL_FRAMEBUFFER_BINDING`), so calling these with the main context current
 * would capture the main canvas's framebuffer and corrupt both. We restore the
 * *previous* handle rather than assuming it was the main canvas.
 *
 * Mirrors the register/make-current sequence already used for the main canvas
 * in `api/canvas.ts`.
 */

import type { WasmModule } from './wasm-types'
import type { Material } from './api/material'
import { setPreviewMaterial } from './api/material'

/**
 * Cap the preview's device-pixel buffer. The preview is a small pane and
 * material patterns are low-frequency, so there's no reason to rasterise a
 * 4K buffer on a hi-DPI screen — and it bounds fragment cost when a
 * clock-driven material animates.
 */
const MAX_PREVIEW_PX = 2048

let canvasEl: HTMLCanvasElement | null = null
let handle: number | null = null
let ready = false
let container: HTMLElement | null = null
let size = { w: 0, h: 0 }

/** Device-pixel buffer size for a CSS size, capped. */
function deviceSize(cssW: number, cssH: number): { w: number; h: number } {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  let w = Math.max(1, Math.round(cssW * dpr))
  let h = Math.max(1, Math.round(cssH * dpr))
  const longest = Math.max(w, h)
  if (longest > MAX_PREVIEW_PX) {
    const q = MAX_PREVIEW_PX / longest
    w = Math.max(1, Math.round(w * q))
    h = Math.max(1, Math.round(h * q))
  }
  return { w, h }
}

/**
 * Tear down everything and forget the element. Used on context loss: a lost
 * context can't be recreated on the same canvas, so the element itself must be
 * replaced — the next `attach` builds a fresh one.
 */
function discard(module: WasmModule | null): void {
  if (module && handle !== null) {
    withPreviewContext(module, () => module._preview_destroy())
  }
  if (canvasEl && canvasEl.parentElement) canvasEl.parentElement.removeChild(canvasEl)
  canvasEl = null
  handle = null
  ready = false
  size = { w: 0, h: 0 }
}

function createCanvas(module: WasmModule): boolean {
  const el = document.createElement('canvas')
  el.style.display = 'block'
  el.style.width = '100%'
  el.style.height = '100%'

  // Mirrors the main canvas's attributes (api/canvas.ts). `depth` is off — a
  // full-surface 2D shader draw needs no depth buffer.
  const ctx = el.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: true,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null
  if (!ctx) return false

  el.addEventListener('webglcontextlost', (e) => {
    // Must preventDefault for a restore to ever be possible; we rebuild from
    // scratch on the next attach rather than trying to resurrect this one.
    e.preventDefault()
    const c = container
    discard(null)
    container = c
  })

  handle = module.GL.registerContext(ctx, { majorVersion: 2 })
  canvasEl = el
  return true
}

/** Run `fn` with the preview GL context current, restoring the previous one. */
function withPreviewContext<T>(module: WasmModule, fn: () => T): T | null {
  if (handle === null) return null
  const gl = module.GL
  const prev = gl.currentContext?.handle ?? null
  gl.makeContextCurrent(handle)
  try {
    return fn()
  } finally {
    if (prev !== null && prev !== handle) gl.makeContextCurrent(prev)
  }
}

/** True when the running binary predates the preview exports. */
export function isPreviewSupported(module: WasmModule): boolean {
  return typeof module._preview_init === 'function'
}

/**
 * Mount the preview surface into `el` at the given CSS size, creating the
 * canvas + GL context + Skia state on first use. Idempotent — reattaching an
 * existing surface just reparents it and resizes.
 */
export function attachPreview(
  module: WasmModule,
  el: HTMLElement,
  cssW: number,
  cssH: number
): boolean {
  if (!isPreviewSupported(module)) return false
  if (!canvasEl && !createCanvas(module)) return false

  container = el
  if (canvasEl!.parentElement !== el) el.appendChild(canvasEl!)

  if (!ready) {
    const { w, h } = deviceSize(cssW, cssH)
    canvasEl!.width = w
    canvasEl!.height = h
    const ok = withPreviewContext(module, () => module._preview_init(w, h))
    if (!ok) return false
    ready = true
    size = { w, h }
    return true
  }
  // Already live: let `resizePreview` own the sizing. Assigning `canvas.width`
  // resets the drawing buffer even when the value is unchanged, which would
  // leave Skia's surface wrapping a stale framebuffer — so only touch it when
  // the size actually changed, and always re-wrap in the same step.
  resizePreview(module, cssW, cssH)
  return true
}

/**
 * Detach from the DOM and release GPU memory, but keep the element + context
 * alive so reopening focus is instant.
 */
export function detachPreview(module: WasmModule): void {
  if (canvasEl?.parentElement) canvasEl.parentElement.removeChild(canvasEl)
  container = null
  if (ready) withPreviewContext(module, () => module._preview_purge())
}

export function resizePreview(module: WasmModule, cssW: number, cssH: number): void {
  if (!ready || !canvasEl) return
  const { w, h } = deviceSize(cssW, cssH)
  if (w === size.w && h === size.h) return
  canvasEl.width = w
  canvasEl.height = h
  size = { w, h }
  withPreviewContext(module, () => module._preview_resize(w, h))
}

/**
 * Push a material to the preview and draw it. `time` (seconds) feeds `u_time`;
 * static shaders can leave it at 0.
 */
export function drawPreview(
  module: WasmModule,
  material: Material | null | undefined,
  time = 0
): void {
  if (!ready) return
  withPreviewContext(module, () => {
    setPreviewMaterial(module, material)
    module._preview_draw(time)
  })
}

/** Full teardown — app shutdown only. */
export function destroyPreview(module: WasmModule): void {
  discard(module)
  container = null
}
