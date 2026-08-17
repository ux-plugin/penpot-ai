/* eslint-disable react-hooks/set-state-in-effect -- this hook synchronises a
   floating popover to a live DOM measurement of the docked inspector; the
   synchronous setState on mount / on each measure is the intended behaviour. */
import { useEffect, useState } from 'react'

/**
 * Viewport `right` offset (px) that places a floating editor flush against the
 * left border of the docked inspector panel (`[data-right-side-panel]`).
 *
 * The inspector is a resizable dock panel now, so its left edge moves as the
 * user drags the handle — a `ResizeObserver` keeps the offset in sync. Returns
 * `null` while inactive or before the panel is found so callers can fall back
 * to a static offset.
 */
export function useInspectorAnchorRight(active: boolean, gap = 8): number | null {
  const [right, setRight] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      setRight(null)
      return
    }
    const panel = document.querySelector('[data-right-side-panel]')
    if (!(panel instanceof HTMLElement)) {
      setRight(null)
      return
    }
    const measure = () => {
      const rect = panel.getBoundingClientRect()
      setRight(Math.max(0, Math.round(window.innerWidth - rect.left + gap)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [active, gap])

  return right
}
