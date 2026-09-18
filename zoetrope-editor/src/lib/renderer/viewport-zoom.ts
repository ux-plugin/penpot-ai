/**
 * Imperative viewport-zoom helpers for UI controls (e.g. the top-bar zoom widget).
 * They mirror the ZOOM_* keyboard commands but run outside the dispatch path: read
 * the live `viewport` signal, mutate a Viewport about the canvas centre, push it to
 * the renderer, and write the signal back. No-op until the renderer + viewport exist.
 */

import { Viewport } from './viewport'
import { viewport } from './signals/pointer'
import { useWorkspaceStore } from './store/workspace-store'
import { getViewportShortcuts } from './store/shortcuts-store'
import type { Point } from './types'

/** Canvas centre in surface-local screen coords — the fixed point to zoom about
 *  (matches the keyboard path's `zoomCenter`). Null if the canvas isn't mounted. */
function canvasCenter(): Point | null {
  const el = typeof document !== 'undefined' ? document.querySelector('canvas') : null
  if (!el) return null
  return { x: el.clientWidth / 2, y: el.clientHeight / 2 }
}

function applyZoom(mutate: (v: Viewport) => void): void {
  const data = viewport.value
  const renderer = useWorkspaceStore.getState().renderer
  if (!data || !renderer) return
  const next = Viewport.from(data)
  mutate(next)
  renderer.applyViewport(next)
  viewport.value = { panX: next.panX, panY: next.panY, zoom: next.zoom }
}

export function zoomInAtCenter(): void {
  const c = canvasCenter()
  if (!c) return
  applyZoom((v) => v.zoomAt(c, getViewportShortcuts().zoomInFactor))
}

export function zoomOutAtCenter(): void {
  const c = canvasCenter()
  if (!c) return
  applyZoom((v) => v.zoomAt(c, getViewportShortcuts().zoomOutFactor))
}

/** Zoom to an absolute level (1 = 100%), keeping the canvas centre fixed. */
export function setZoomLevel(zoom: number): void {
  const c = canvasCenter()
  applyZoom((v) => {
    if (c && v.zoom > 0) v.zoomAt(c, zoom / v.zoom)
    else v.setZoom(zoom)
  })
}
