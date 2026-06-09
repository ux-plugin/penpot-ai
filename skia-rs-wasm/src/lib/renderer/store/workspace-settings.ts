/**
 * Workspace gesture/editing settings (see docs/state-architecture.md §3).
 *
 * Mirrors Penpot frontend's `:snap-pixel-grid` flag in `:workspace-layout`
 * (frontend/src/app/main/data/workspace/layout.cljs). When enabled, interactive
 * pointer gestures (move / resize / draw) snap geometry to the whole-pixel
 * (integer world-unit) grid. Programmatic/typed edits are expected to bypass it,
 * matching the frontend's `:ignore-snap-pixel` on the sidebar/nudge paths.
 *
 * Default ON, like the frontend's `default-layout`.
 */

import { signal } from '@preact/signals-core'

/** Whether interactive gestures snap to the whole-pixel grid. Default: on. */
export const snapPixelGrid = signal(true)

/** Read the flag without subscribing (e.g. inside drag handlers). */
export function isSnapPixelGridEnabled(): boolean {
  return snapPixelGrid.peek()
}

/** Toggle snapping (e.g. from a menu item or keyboard shortcut). */
export function toggleSnapPixelGrid(): void {
  snapPixelGrid.value = !snapPixelGrid.value
}

/** Set the flag explicitly. */
export function setSnapPixelGrid(enabled: boolean): void {
  snapPixelGrid.value = enabled
}
