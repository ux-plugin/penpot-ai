/**
 * Shared shader-thumbnail rendering + cache, used by both the preset modal and
 * the Assets panel. Each preset is drawn ONCE by the shared isolated preview
 * surface (one GL context → N thumbnails) and cached as an offscreen canvas;
 * every later paint just blits the cached canvas — so switching tabs or
 * reopening the modal never re-touches the surface.
 *
 * **Why a cache and not a per-mount render.** The Assets tab lives in the left
 * rail, which stays visible while the shader focus stage is open — and the stage
 * animates that same single surface. Rendering once (when the surface is free)
 * and painting from the cache forever means the panel never contends with the
 * stage. If a stage is active on first request, we defer and render when it
 * closes (subscribing to `focusStage`).
 */

import { useEffect, useRef, useState } from 'react'
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

export const THUMB_W = 220
export const THUMB_H = 132

export interface ThumbEntry {
  id: string
  material: Material
  /** Phase (0→1) to freeze the thumbnail at — a representative frame. */
  thumbPhase: number
}

const cache = new Map<string, HTMLCanvasElement>()
let pending = false

function dpr(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

/**
 * Render any un-cached entries into offscreen canvases via the shared surface.
 * No-op while a focus stage owns the surface or another render is in flight.
 * Returns true if it rendered at least one new thumbnail.
 */
export function ensureShaderThumbnails(entries: ThumbEntry[]): boolean {
  const module = getWasmModule()
  if (!module || !isPreviewSupported(module)) return false
  const missing = entries.filter((e) => !cache.has(e.id))
  if (missing.length === 0 || pending || isFocusStageActive()) return false

  pending = true
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${THUMB_W}px;height:${THUMB_H}px;pointer-events:none`
  document.body.appendChild(host)
  let rendered = false
  try {
    if (attachPreview(module, host, THUMB_W, THUMB_H)) {
      const d = dpr()
      for (const e of missing) {
        drawPreview(module, e.material, 0, e.thumbPhase)
        const c = document.createElement('canvas')
        c.width = Math.round(THUMB_W * d)
        c.height = Math.round(THUMB_H * d)
        const ctx = c.getContext('2d')
        if (ctx && blitPreviewTo(ctx)) {
          cache.set(e.id, c)
          rendered = true
        }
      }
    }
  } finally {
    detachPreview(module)
    host.remove()
    pending = false
  }
  return rendered
}

export function getThumbnail(id: string): HTMLCanvasElement | undefined {
  return cache.get(id)
}

/**
 * Ensure the given entries are rendered, returning a version that bumps once
 * they land so painters re-run. If the surface is busy (a stage is open), it
 * retries when the stage closes.
 */
export function useShaderThumbnails(entries: ThumbEntry[]): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (ensureShaderThumbnails(entries)) {
      setVersion((v) => v + 1)
      return
    }
    // Couldn't render now (a stage owns the surface, or wasm isn't ready).
    // Retry whenever the focus stage changes — closing it frees the surface.
    return focusStage.subscribe(() => {
      if (ensureShaderThumbnails(entries)) setVersion((v) => v + 1)
    })
  }, [entries])
  return version
}

/** Paints a cached thumbnail into a canvas, or nothing (placeholder) if absent. */
export function ShaderThumbnail({ id, version }: { id: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const src = getThumbnail(id)
    const dst = ref.current
    if (!src || !dst) return
    dst.width = src.width
    dst.height = src.height
    dst.getContext('2d')?.drawImage(src, 0, 0)
  }, [id, version])
  return <canvas ref={ref} className="h-full w-full object-cover" />
}
