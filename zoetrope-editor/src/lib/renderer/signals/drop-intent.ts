/**
 * Drag drop-intent: the current "where would this land" result, written per frame
 * by the move handler and read by the overlay to draw the insertion line + target
 * highlight. Null when no drag is active or the pointer isn't over a droppable
 * container. See handlers/drop-intent.ts.
 */
import { signal } from '@preact/signals-core'
import type { DropIntent } from '../handlers/drop-intent'

export const dropIntentSignal = signal<DropIntent | null>(null)

export function clearDropIntent(): void {
  if (dropIntentSignal.value !== null) dropIntentSignal.value = null
}
