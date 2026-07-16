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
  /** Center content — fills the canvas-hole region under the header bar. */
  center: ReactNode
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
   */
  onExit?: () => void
}

/** The active focus session, or `null` when the editor is in its normal shell. */
export const focusStage = signal<FocusStageSession | null>(null)

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
