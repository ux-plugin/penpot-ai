/**
 * When a version gets captured — the knobs, and the measure they read.
 *
 * Three independent decisions, deliberately separate because they answer
 * different questions:
 *
 * - **Every N changes** is *when to look*. A long session that never leaves the
 *   stage would otherwise leave a single version covering an hour of work.
 * - **On leaving focus mode** is the boundary capture. It is the one that makes
 *   "what did this shape look like before I opened it" answerable at all.
 * - **Minimum change** is *whether it was worth it*. Nudging one uniform twenty
 *   times should not fill the timeline with twenty near-identical entries.
 *
 * Not persisted, matching every other setting in this codebase — shortcuts and
 * the pixel-snap flag are in-memory too, and inventing a storage convention for
 * this one would be the odd thing out.
 */

import { create } from 'zustand'
import { stableStringify } from './version-store'

export interface CapturePolicy {
  /** Checkpoint mid-session after this many committed changes. 0 disables it. */
  everyNChanges: number
  /** Capture when a focus stage closes. */
  onExitFocus: boolean
  /** Whether a capture must clear {@link CapturePolicy.minChange} to be kept. */
  minChangeEnabled: boolean
  /** How much must differ, in the units {@link changeSize} returns. */
  minChange: number
}

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  everyNChanges: 25,
  onExitFocus: true,
  minChangeEnabled: false,
  minChange: 8,
}

interface PolicyState extends CapturePolicy {
  set: (patch: Partial<CapturePolicy>) => void
  reset: () => void
}

export const useCapturePolicyStore = create<PolicyState>((set) => ({
  ...DEFAULT_CAPTURE_POLICY,
  set: (patch) => set(patch),
  reset: () => set(DEFAULT_CAPTURE_POLICY),
}))

/** Read without subscribing — capture runs outside React. */
export function capturePolicy(): CapturePolicy {
  const { set: _set, reset: _reset, ...policy } = useCapturePolicyStore.getState()
  return policy
}

/**
 * The changed span of two strings, found by trimming the common prefix and
 * suffix. For typing — which is what shader source editing is — that is the
 * number of characters actually touched, at O(n) and without an edit-distance
 * matrix. It over-counts a change that moves a block around, and that is the
 * right way to be wrong: it captures more often than strictly necessary.
 */
function changedSpan(a: string, b: string): number {
  if (a === b) return 0
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  return Math.max(a.length, b.length) - prefix - suffix
}

function weigh(value: unknown): number {
  return typeof value === 'string' ? value.length : 1
}

/**
 * How much two payloads differ.
 *
 * Units are characters for text and one per field for everything else, which
 * mixes two scales in one number. That is a deliberate simplification: the
 * setting exists to filter out trivial edits, and "a few characters" is the
 * intuition a threshold has to serve. A uniform tweak counts as 1, so a default
 * of 8 keeps slider nudges out of the timeline while letting any real edit
 * through.
 */
export function changeSize(
  prev: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>>,
): number {
  if (prev === undefined) return Number.POSITIVE_INFINITY // the first version always counts

  let total = 0
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const a = prev[key]
    const b = next[key]
    if (a === undefined && b === undefined) continue
    if (a === undefined || b === undefined) {
      total += weigh(a ?? b)
      continue
    }
    if (typeof a === 'string' && typeof b === 'string') {
      total += changedSpan(a, b)
      continue
    }
    if (stableStringify(a) !== stableStringify(b)) total += 1
  }
  return total
}

/** Is this candidate worth a version, under the current policy? */
export function shouldCapture(
  prev: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>>,
  policy: CapturePolicy = capturePolicy(),
): boolean {
  const size = changeSize(prev, next)
  if (size === 0) return false // nothing changed; the store would drop it anyway
  return !policy.minChangeEnabled || size >= policy.minChange
}

/**
 * Has a session accumulated enough changes for a mid-session checkpoint?
 *
 * The caller owns the counter and resets it after each capture, because only it
 * knows what counts as a change for its subject.
 */
export function shouldCheckpoint(
  changesSinceCapture: number,
  policy: CapturePolicy = capturePolicy(),
): boolean {
  return policy.everyNChanges > 0 && changesSinceCapture >= policy.everyNChanges
}
