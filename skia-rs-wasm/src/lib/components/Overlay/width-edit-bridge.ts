/**
 * Bridge between the Width sub-tool's on-canvas handles (PathEditorOverlay) and
 * the mode control docked in the path-edit toolbar (PenEditFlyout). The overlay
 * owns the width-point geometry and commits; the toolbar is a thin control that
 * reads the selected point's mode from here and asks the overlay to change it.
 *
 * Interpolation mode is per width point and governs the segment *leaving* it:
 *   smooth  → Catmull-Rom (rounded)
 *   corner  → linear (straight)
 *   stepped → hold this point's value, hard jump at the next point
 */
import { proxy } from 'valtio'

export type WidthMode = 'smooth' | 'corner' | 'stepped'

export const WIDTH_MODES: WidthMode[] = ['smooth', 'corner', 'stepped']

/** Mode → the wire value stored in `strokeWidthPoints` (…, mode). */
export const WIDTH_MODE_NUM: Record<WidthMode, number> = { smooth: 0, corner: 1, stepped: 2 }

export function widthModeFromNum(n: number): WidthMode {
  return n >= 1.5 ? 'stepped' : n >= 0.5 ? 'corner' : 'smooth'
}

/** On-canvas indicator + menu accent colour per mode (readable on the artboard
 *  in both themes; mirrors the Rust segment-mode semantics). */
export const WIDTH_MODE_COLOR: Record<WidthMode, string> = {
  smooth: '#1D9E75',
  corner: '#BA7517',
  stepped: '#7F77DD',
}
export const WIDTH_MODE_LABEL: Record<WidthMode, string> = {
  smooth: 'Smooth',
  corner: 'Corner',
  stepped: 'Stepped',
}
export const WIDTH_MODE_HINT: Record<WidthMode, string> = {
  smooth: 'rounded',
  corner: 'straight',
  stepped: 'hard edge',
}

/** Live selection state the toolbar reads (via `useSnapshot`). `selectedIdx` is
 *  an index into the current width points, or -1 when nothing is selected. */
export const widthEditState = proxy<{ active: boolean; selectedIdx: number; mode: WidthMode | null }>({
  active: false,
  selectedIdx: -1,
  mode: null,
})

/** Imperative hook the overlay registers so the toolbar can drive a mode change
 *  through the overlay's own commit path. Not reactive — call it directly. */
export const widthEditActions: { setMode: ((m: WidthMode) => void) | null } = { setMode: null }
