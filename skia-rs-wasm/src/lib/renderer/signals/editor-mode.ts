/**
 * Top-level editor mode: which view the workspace is in.
 *
 * A signal (not React state) on purpose — it mirrors `selection` and is meant
 * to be read from outside React too. Build mode will need the canvas/pointer
 * layer (non-React modules) to gate design-time interactions, and a signal is
 * the same cross-boundary state mechanism those modules already use.
 */

import { signal } from '@preact/signals-core'

export type EditorMode = 'design' | 'build'

/** Active editor mode. Written by TopBar tabs; read by App (overlay switch) + renderer modules. */
export const editorMode = signal<EditorMode>('design')

export function setEditorMode(mode: EditorMode): void {
  if (editorMode.peek() !== mode) editorMode.value = mode
}
