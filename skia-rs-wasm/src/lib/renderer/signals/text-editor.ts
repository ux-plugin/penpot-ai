/**
 * High-frequency text-editor state (caret/selection geometry, composing flag).
 * The edit-mode *mode* itself (which shape is being edited) lives in the XState
 * canvas-machine; these signals carry the per-frame data the render loop and
 * overlay read without going through React.
 */

import { signal } from '@preact/signals-core'
import type { Rect } from '../api/text-editor'

/** True while a text shape is being edited. The render loop gates the
 * editor frame calls (update_blink / render_overlay / poll_event) on this. */
export const textEditorActive = signal<boolean>(false)

/** Shape id currently being edited (mirrors the machine mode for low-level,
 * non-React consumers like the render loop). */
export const textEditorShapeId = signal<string | null>(null)

/** Caret rectangle in shape-local space (for overlay placement / scroll-into-view). */
export const textCaretRect = signal<Rect | null>(null)

/** Selection rectangles in shape-local space. */
export const textSelectionRects = signal<Rect[]>([])

/** True between compositionstart and compositionend (IME). */
export const textIsComposing = signal<boolean>(false)
