/**
 * scene3d-recenter — bring a 3D scene back into view by panning/zooming the *2D*
 * document viewport so the scene's container box is centred and comfortably fit.
 *
 * This is the 2D-viewport analogue of the 3D Frame-view (F): `F` reframes the 3D
 * *camera* inside the box; recenter moves the *document* viewport so the box itself
 * returns to the middle of the screen (used when the scene has been panned off it).
 */

import { Viewport } from '../viewport'
import { viewport } from '../signals/pointer'
import { useWorkspaceStore } from '../store/workspace-store'
import { getNode } from '../store/doc-proxy'

export interface WorldRect {
  cx: number
  cy: number
  w: number
  h: number
}

/**
 * The viewport (world visible top-left + zoom) that centres `rect` in a `cw × ch`
 * canvas at a comfortable fit. `padding` leaves margin around the scene; `maxZoom`
 * caps how far it zooms *in* on a small scene so recenter never blows it up. Pure.
 * (worldToScreen maps rect centre → canvas centre: panX = cx − (cw/2)/zoom.)
 */
export function fitViewportToRect(
  rect: WorldRect,
  cw: number,
  ch: number,
  opts: { padding?: number; minZoom?: number; maxZoom?: number } = {},
): { panX: number; panY: number; zoom: number } {
  const padding = opts.padding ?? 1.3
  const minZoom = opts.minZoom ?? 0.02
  const maxZoom = opts.maxZoom ?? 2
  const w = Math.max(rect.w, 1e-3)
  const h = Math.max(rect.h, 1e-3)
  const fit = Math.min(cw / (w * padding), ch / (h * padding))
  const zoom = Math.max(minZoom, Math.min(maxZoom, fit))
  return { panX: rect.cx - cw / 2 / zoom, panY: rect.cy - ch / 2 / zoom, zoom }
}

/** World bounds of a scene container — WASM's live selection rect, else node bounds. */
function sceneWorldRect(sceneId: string): WorldRect | null {
  const renderer = useWorkspaceStore.getState().renderer
  const r = renderer?.getSelectionRect([sceneId])
  if (r && r.width > 0 && r.height > 0) {
    return { cx: r.center.x, cy: r.center.y, w: r.width, h: r.height }
  }
  const node = getNode(sceneId) as
    | { x?: number; y?: number; width?: number; height?: number }
    | undefined
  if (node && typeof node.x === 'number' && typeof node.width === 'number' && node.width > 0) {
    const w = node.width
    const h = node.height ?? w
    return { cx: node.x + w / 2, cy: (node.y ?? 0) + h / 2, w, h }
  }
  return null
}

/** Pan+zoom the 2D viewport so the scene box is centred and comfortably fit. No-op
 *  until the renderer + viewport + canvas exist, or if the scene has no bounds. */
export function recenterOnScene(sceneId: string): void {
  const data = viewport.value
  const renderer = useWorkspaceStore.getState().renderer
  const canvas = typeof document !== 'undefined' ? document.querySelector('canvas') : null
  if (!data || !renderer || !canvas) return
  const rect = sceneWorldRect(sceneId)
  if (!rect) return
  const next = Viewport.from(fitViewportToRect(rect, canvas.clientWidth, canvas.clientHeight))
  renderer.applyViewport(next)
  viewport.value = { panX: next.panX, panY: next.panY, zoom: next.zoom }
}
