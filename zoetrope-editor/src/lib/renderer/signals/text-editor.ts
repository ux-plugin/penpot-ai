/**
 * High-frequency text-editor state (caret/selection geometry, composing flag).
 * The edit-mode *mode* itself (which shape is being edited) lives in the XState
 * canvas-machine; these signals carry the per-frame data the render loop and
 * overlay read without going through React.
 */

import { signal } from '@preact/signals-core'
import type { Rect, CurrentStyles } from '../api/text-editor'

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

/** Whether the live WASM editor currently holds no text. Refreshed after every
 * edit while editing (the typed content lives in the editor, not `node.content`,
 * until commit). Lets the selection overlay hide the outline for a freshly
 * click-created empty text box and reveal it the moment a character is typed.
 * Reset to `true` when an edit session ends. */
export const textEditorIsEmpty = signal<boolean>(true)

/** Live, mixed-aware style of the caret / current selection in the edited
 * shape, read from the WASM editor (`text_editor_get_current_styles`). Null when
 * not editing. Drives the typography/fills panels' display while editing: per-
 * property `MULTIPLE` renders as "Mixed", and `selectedColors` lists every fill
 * used across the selection. Refreshed after each editor interaction. */
export const currentStyles = signal<CurrentStyles | null>(null)

/** The contentEditable overlay element of the active edit session (null when
 * not editing). Lets panels hand keyboard focus back to the canvas editor
 * after an interaction (e.g. typing a hex colour) without a caret-moving
 * canvas click. */
export const textEditorDomNode = signal<HTMLElement | null>(null)

/** When the TEXT TOOL is armed (not yet editing), the topmost text shape under the
 * pointer, or null. Drives the I-beam hover cursor via `resolveCanvasCursor` and is
 * the shape the text tool edits on click. Updated on pointermove by the viewport
 * hook; ignored while a non-text tool is active (the resolver gates on the tool). */
export const textToolHoverTarget = signal<string | null>(null)

/** Return keyboard focus to the text-editor overlay, if a session is active.
 * Does not touch the WASM caret/selection — only DOM focus. */
export function refocusTextEditor(): void {
  textEditorDomNode.value?.focus()
}
