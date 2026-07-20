/**
 * scene3d-focus — "focus mode" for 3D-scene editing: render the edited scene into a
 * large viewport-anchored region instead of its placed box, so you can work on it big
 * and centred while the rest of the canvas dims (adjustable). The placed rect's real
 * size/position are UNTOUCHED — focus only changes *where the scene is drawn*, and
 * reverts on exit. Opt-in per edit session (entering always starts `in-place`).
 *
 * Kept as signals (transient view state, like dolly/pan), not machine state.
 */

import { signal } from '@preact/signals-core'

export type EditPlacement = 'in-place' | 'focus'

/** Where the edited scene renders: at its box (`in-place`) or a centred region (`focus`). */
export const editPlacement = signal<EditPlacement>('in-place')

/**
 * The central canvas viewport (the "hole" between the panels), in overlay-canvas CSS
 * px. The full-bleed canvas underlaps the left/right rails + bottom timeline, so focus
 * mode must render INTO this rect — never over the panels. Published by the canvas
 * shell (canvas-wrapper) as the hole resizes; `null` ⇒ not measured yet (fall back to
 * the whole canvas).
 */
export const focusViewportRect = signal<{ x: number; y: number; w: number; h: number } | null>(
  null,
)

/** How much the surrounding canvas dims while focused (0 = none, 1 = black). The one
 *  shared "how much context do I see" control (a static setting, not a peek gesture). */
export const focusDim = signal(0.4)

/** Drop the dim to reveal the canvas — driven by the *sampling* worktree's eyedropper
 *  when it needs to pick a value from behind the focus, not by a user gesture here. */
export const reveal = signal(false)

export function toggleFocus(): void {
  editPlacement.value = editPlacement.value === 'focus' ? 'in-place' : 'focus'
}

export function exitFocus(): void {
  editPlacement.value = 'in-place'
}

/** The effective dim (0 while the sampling worktree is revealing). */
export function effectiveDim(): number {
  return reveal.value ? 0 : focusDim.value
}
