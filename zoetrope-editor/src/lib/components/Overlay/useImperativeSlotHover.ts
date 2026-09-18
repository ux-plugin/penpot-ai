/**
 * Empty-slot hover chrome.
 *
 * Split across the two surfaces on purpose:
 *  - the OUTLINE is drawn by the renderer (`setShapeHighlight`), traced over the
 *    slot's own geometry. It follows corner radii and rotation, and can't drift
 *    from what's painted, because it *is* the painted shape's outline. An SVG
 *    rect could only ever mirror the slot's bounding box.
 *  - the NAME stays in SVG, where it renders in the app's font at crisp DOM
 *    resolution and matches the other canvas labels. It is authored in world
 *    coords — the SVG's viewBox maps world→screen — so only the font size is
 *    scaled by 1/zoom.
 *
 * The WASM call is gated on the hovered id actually changing: each one costs a
 * render frame, and pointer moves arrive far faster than slots change.
 */
import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'
import { effect } from '@preact/signals-core'
import { viewport as viewportSignal, worldPointerPos } from '../../renderer/signals/pointer'
import { dropIntentSignal } from '../../renderer/signals/drop-intent'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { useWorkspaceStore } from '../../renderer/store/workspace-store'
import { clearShapeHighlight, setShapeHighlight } from '../../renderer/api/highlight'
import { resolveHoveredSlot } from '../../renderer/slot/slot-hover'
import type { IndexedShape } from '../../worker/types'

/** Same accent the slot chrome has always used. */
const HOVER_COLOR = '#7F77DD'
const FONT = 11
const FONT_MAX = 34

export function useImperativeSlotHover(labelRef: RefObject<SVGTextElement | null>): void {
  useLayoutEffect(() => {
    // Last id handed to WASM, so we only pay a frame when it actually changes.
    let highlighted: string | null = null

    const applyHighlight = (id: string | null) => {
      if (id === highlighted) return
      const { renderer } = useWorkspaceStore.getState()
      // No renderer yet (or context gone): drop the update rather than queue it.
      // The next pointer move re-applies it, and `highlighted` stays honest
      // about what WASM is actually showing.
      if (!renderer?.isInitialized()) return
      const module = renderer.getModule()
      if (!module) return
      if (id) setShapeHighlight(module, id, HOVER_COLOR)
      else clearShapeHighlight(module)
      highlighted = id
    }

    const stop = effect(() => {
      const point = worldPointerPos.value
      const vp = viewportSignal.value
      // Subscribing to the drag signal doubles as the "is a drag in flight" test.
      const dragging = dropIntentSignal.value != null
      const label = labelRef.current
      if (!label) return

      const pageId = getActiveOrSinglePageId()
      const objects = pageId
        ? (docProxy.pageMap.get(pageId)?.objects as Record<string, IndexedShape> | undefined)
        : undefined
      const hovered = resolveHoveredSlot(objects, point, dragging)

      if (!hovered || !vp || !Number.isFinite(vp.zoom) || vp.zoom <= 0) {
        label.style.display = 'none'
        applyHighlight(null)
        return
      }
      applyHighlight(hovered.id)

      label.style.display = ''
      label.textContent = hovered.name
      label.setAttribute('x', String(hovered.rect.x))
      label.setAttribute('y', String(hovered.rect.y - 5 / vp.zoom))
      label.setAttribute('font-size', String(Math.min(FONT / vp.zoom, FONT_MAX)))
    })

    return () => {
      stop()
      // Chrome lives in WASM now, so unmounting the overlay has to take it down
      // explicitly — otherwise the last hovered slot stays outlined forever.
      applyHighlight(null)
    }
  }, [labelRef])
}
