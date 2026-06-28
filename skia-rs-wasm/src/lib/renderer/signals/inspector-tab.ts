/**
 * Which inspector tab is active. Shared across Design and Build modes (the
 * inspector is one panel hosted in both), so it's a signal like editor-mode —
 * the active tab persists when you switch modes or selection.
 */

import { signal } from '@preact/signals-core'

export type InspectorTab = 'parameters' | 'interactions' | 'motion' | 'code'

export const inspectorTab = signal<InspectorTab>('parameters')

export function setInspectorTab(tab: InspectorTab): void {
  if (inspectorTab.peek() !== tab) inspectorTab.value = tab
}
