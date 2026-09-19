import { useSyncExternalStore } from 'react'
import type { Signal } from '@preact/signals-core'

/**
 * Read a signal in React, committing as soon as it changes.
 *
 * The sibling `useSignalCoalesced` batches to one commit per animation frame,
 * which is right for signals that churn (pointer, viewport, selection) — but
 * wrong for state that changes once per user action and decides what's on
 * screen. A route change deferred to a frame that never arrives (a throttled or
 * background tab, a context with no compositor) leaves the app rendering the
 * previous view indefinitely.
 *
 * Rule of thumb: coalesce what streams, commit immediately what navigates.
 */
export function useSignalValue<T>(sig: Signal<T>): T {
  return useSyncExternalStore(
    (onChange) => sig.subscribe(() => onChange()),
    () => sig.peek(),
    () => sig.peek(),
  )
}
