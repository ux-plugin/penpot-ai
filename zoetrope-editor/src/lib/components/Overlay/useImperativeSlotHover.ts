/**
 * Empty-slot hover chrome: a dashed outline traced over the slot's own geometry,
 * plus its name.
 *
 * Both live in the SVG overlay, authored in world coords — the SVG's viewBox maps
 * world→screen — so stroke width, dash and font size are the only things scaled
 * by 1/zoom. The outline is built from the shape itself (selrect, per-corner
 * radii, and its transform about the centre, the same sandwich the selection
 * rect uses), so it follows rounded corners and rotation rather than mirroring
 * an axis-aligned bounding box.
 *
 * Drawing it here rather than in the renderer keeps it pure chrome on every
 * backend: it never enters the render graph, so hovering never invalidates a
 * cached tile, and no effect on the slot (blur, shadow) can reach the outline.
 */
import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'
import { effect, untracked } from '@preact/signals-core'
import { viewport as viewportSignal, worldPointerPos } from '../../renderer/signals/pointer'
import { dropIntentSignal } from '../../renderer/signals/drop-intent'
import { getActiveOrSinglePageId, getNode, pageObjects, type Node } from '../../doc'
import { resolveHoveredSlot } from '../../renderer/slot/slot-hover'

/** Same accent the slot chrome has always used. */
export const HOVER_COLOR = '#7F77DD'
const FONT = 11
const FONT_MAX = 34

/**
 * Outline stroke, in CSS pixels, matched to the editor's other canvas chrome.
 * Divided by zoom so it keeps its weight, then capped in world units so it
 * doesn't turn into a slab when zoomed far out.
 */
const STROKE_PX = 1.5
const STROKE_MAX = 4
const DASH_PX = 5
const DASH_MAX = 14

type Corners = [number, number, number, number]

/**
 * A `w`×`h` rect centred on the origin with per-corner radii (top-left,
 * top-right, bottom-right, bottom-left). Each radius is clamped to half the
 * shorter side, as the renderer does, so an oversized value draws a pill rather
 * than a self-crossing path.
 */
export function roundedRectPath(w: number, h: number, radii: Corners): string {
  const max = Math.min(w, h) / 2
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, max)))
  const x0 = -w / 2
  const y0 = -h / 2
  const x1 = w / 2
  const y1 = h / 2
  const arc = (r: number, x: number, y: number) => (r > 0 ? `A${r},${r} 0 0 1 ${x},${y}` : `L${x},${y}`)
  return [
    `M${x0 + tl},${y0}`,
    `L${x1 - tr},${y0}`,
    arc(tr, x1, y0 + tr),
    `L${x1},${y1 - br}`,
    arc(br, x1 - br, y1),
    `L${x0 + bl},${y1}`,
    arc(bl, x0, y1 - bl),
    `L${x0},${y0 + tl}`,
    arc(tl, x0 + tl, y0),
    'Z',
  ].join(' ')
}

function cornersOf(node: Node): Corners {
  const n = node as { r1?: number; r2?: number; r3?: number; r4?: number; rx?: number }
  const r = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : (n.rx ?? 0))
  return [r(n.r1), r(n.r2), r(n.r3), r(n.r4)]
}

export function useImperativeSlotHover(
  outlineRef: RefObject<SVGPathElement | null>,
  labelRef: RefObject<SVGTextElement | null>,
): void {
  useLayoutEffect(() => {
    // Last outline drawn, so a pointer move over the same slot at the same zoom
    // doesn't rewrite the path. Pointer moves arrive far faster than slots change.
    let drawn: { id: string; zoom: number; node: Node } | null = null

    const hide = (outline: SVGPathElement, label: SVGTextElement) => {
      outline.style.display = 'none'
      label.style.display = 'none'
      drawn = null
    }

    const stop = effect(() => {
      const point = worldPointerPos.value
      const vp = viewportSignal.value
      // Subscribing to the drag signal doubles as the "is a drag in flight" test.
      const dragging = dropIntentSignal.value != null
      const outline = outlineRef.current
      const label = labelRef.current
      if (!outline || !label) return

      // Untracked: the page is read per pointer move, not watched.
      const { hovered, node } = untracked(() => {
        const pageId = getActiveOrSinglePageId()
        const hovered = resolveHoveredSlot(pageId ? pageObjects(pageId) : undefined, point, dragging)
        return { hovered, node: hovered ? getNode(hovered.id) : undefined }
      })

      if (!hovered || !node || !vp || !Number.isFinite(vp.zoom) || vp.zoom <= 0) {
        hide(outline, label)
        return
      }

      const { x, y, width: w, height: h } = hovered.rect
      if (!(drawn && drawn.id === hovered.id && drawn.zoom === vp.zoom && drawn.node === node)) {
        const t = node.transform
        const matrix =
          t && [t.a, t.b, t.c, t.d].every(Number.isFinite) ? ` matrix(${t.a},${t.b},${t.c},${t.d},0,0)` : ''
        outline.setAttribute('d', roundedRectPath(w, h, cornersOf(node)))
        outline.setAttribute('transform', `translate(${x + w / 2},${y + h / 2})${matrix}`)
        outline.setAttribute('stroke-width', String(Math.min(STROKE_PX / vp.zoom, STROKE_MAX)))
        const dash = Math.min(DASH_PX / vp.zoom, DASH_MAX)
        outline.setAttribute('stroke-dasharray', `${dash},${dash}`)
        outline.style.display = ''
        drawn = { id: hovered.id, zoom: vp.zoom, node }
      }

      label.style.display = ''
      label.textContent = hovered.name
      label.setAttribute('x', String(x))
      label.setAttribute('y', String(y - 5 / vp.zoom))
      label.setAttribute('font-size', String(Math.min(FONT / vp.zoom, FONT_MAX)))
    })

    return () => {
      stop()
      if (outlineRef.current && labelRef.current) hide(outlineRef.current, labelRef.current)
    }
  }, [outlineRef, labelRef])
}
