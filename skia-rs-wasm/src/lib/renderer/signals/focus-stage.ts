/**
 * Focus stage — a generic, feature-agnostic "center takeover" for the editor.
 *
 * The editor shell (`App` → `CanvasWrapper`) composes its center region and
 * rails from slots. A *focus stage* is any feature that temporarily claims the
 * center region (the canvas-hole between the rails) for a dedicated task —
 * authoring a shader, editing a curve, tuning a data binding, etc. — and
 * optionally rebinds the surrounding rails while it's active.
 *
 * This is deliberately NOT shader-specific: a session just carries the React
 * nodes to render in each slot plus an exit hook. The first consumer is the
 * shader material editor (see `ShaderMaterialStage`), but interactions/motion/3D
 * can open their own sessions the same way.
 *
 * A signal (not React state) so non-React modules — the canvas/pointer layer —
 * can read "are we in a focus stage?" to gate design-time interactions, exactly
 * like `editorMode`.
 */

import type { ReactNode } from 'react'
import { signal } from '@preact/signals-core'

export interface FocusStageSession {
  /**
   * Stable identifier for the *kind* of focus (e.g. `'shader-material'`). Used
   * as the React key so switching sessions remounts cleanly, and lets a
   * consumer detect "my stage is already open" without tracking it separately.
   */
  id: string
  /** Title shown in the stage's header bar. */
  title: ReactNode
  /**
   * Center content — fills the canvas-hole region under the header bar. Omit for a
   * header-only session (e.g. 3D edit): the shell keeps its normal center content
   * (the tool strip) beneath the shared header instead.
   */
  center?: ReactNode
  /** Optional left-rail override. Omit to keep the current mode's left rail. */
  left?: ReactNode
  /** Optional right-rail override. Omit to keep the current inspector rail. */
  right?: ReactNode
  /** Optional bottom-strip override. Omit to keep the current bottom slot. */
  bottom?: ReactNode
  /**
   * Called once when the stage closes (Esc, the header exit button, or another
   * session replacing this one). For cleanup only — do NOT call `closeFocusStage`
   * from here (it's already closing).
   *
   * A stage that wants a focus sub-history opens a buffer (`beginFocusBuffer`)
   * and sets `onExit: endFocusBuffer` to fold it into one canvas undo entry on
   * close (see `open-shader-stage.tsx`).
   */
  onExit?: () => void
}

/** The active focus session, or `null` when the editor is in its normal shell. */
export const focusStage = signal<FocusStageSession | null>(null)

/**
 * Height (px) of the shared `FocusStage` header bar. Kept here because two places
 * depend on it: `FocusStage` renders the bar at this height (Tailwind `h-9`), and
 * the canvas shell insets the 3D `focusViewportRect` by it so a scene rendered in
 * the hole doesn't tuck under the bar. Change both if you change this.
 */
export const FOCUS_STAGE_HEADER_PX = 36

/** True while any focus stage is active. Cheap read for non-React gating. */
export function isFocusStageActive(): boolean {
  return focusStage.peek() !== null
}

/**
 * Open a focus stage, replacing any currently-open one (its `onExit` fires
 * first). Consumers own the session's React nodes and their internal state.
 */
export function openFocusStage(session: FocusStageSession): void {
  const prev = focusStage.peek()
  if (prev && prev !== session) prev.onExit?.()
  focusStage.value = session
}

/** Close the active focus stage (fires its `onExit`). No-op if none is open. */
export function closeFocusStage(): void {
  const prev = focusStage.peek()
  if (!prev) return
  focusStage.value = null
  prev.onExit?.()
}
