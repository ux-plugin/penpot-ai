/**
 * edit-history — "get back to where I was" without hunting the layers tree.
 *
 * Leaving a focused edit records a resumable context; `Tab` cycles the recent list
 * while editing, and a transient chip offers to resume the one you just left. Only
 * *substantial* sessions are kept (dwelled a moment OR did real work), so misclicks
 * don't pollute the list — recording intent, not events. Kept as signals (transient
 * session state), generalisable across edit kinds; only 3D scenes are wired today.
 */

import { signal } from '@preact/signals-core'

export type EditKind = 'scene3d'

export interface EditContext {
  kind: EditKind
  targetId: string
  name: string
}

const MRU_MAX = 8
export const DWELL_MS = 1500

/** Curated recent edits, most-recent first (deduped by targetId, bounded). */
export const recentEdits = signal<EditContext[]>([])

/** The edit you just left — drives the transient "resume" chip (null once resumed/dismissed). */
export const lastExited = signal<EditContext | null>(null)

export interface EditSession {
  targetId: string
  enteredAt: number
  dirty: boolean
}
let session: EditSession | null = null

/** Did a session earn a place in history — dwelled long enough OR did real work? Pure. */
export function shouldRecord(s: EditSession, now: number): boolean {
  return s.dirty || now - s.enteredAt >= DWELL_MS
}

/** Prepend `ctx` into an MRU list (dedupe by targetId, bound to MRU_MAX). Pure. */
export function pushMru(list: EditContext[], ctx: EditContext): EditContext[] {
  return [ctx, ...list.filter((c) => c.targetId !== ctx.targetId)].slice(0, MRU_MAX)
}

/** The next context to resume when cycling from `currentTargetId` by `dir` (wraps). Pure. */
export function cycleEdit(
  list: EditContext[],
  currentTargetId: string | null,
  dir: 1 | -1,
): EditContext | null {
  if (list.length === 0) return null
  const idx = list.findIndex((c) => c.targetId === currentTargetId)
  if (idx < 0) return list[dir === 1 ? 0 : list.length - 1]
  return list[(idx + dir + list.length) % list.length]
}

export function beginEditSession(targetId: string, now = Date.now()): void {
  session = { targetId, enteredAt: now, dirty: false }
}

/** Mark the current session as having done real work (so it's worth remembering). */
export function markEditDirty(): void {
  if (session) session.dirty = true
}

/** Close the current session: remember it as last-exited, and record it if substantial. */
export function endEditSession(ctx: EditContext, now = Date.now()): void {
  const s = session
  session = null
  lastExited.value = ctx
  if (s && s.targetId === ctx.targetId && shouldRecord(s, now)) {
    recentEdits.value = pushMru(recentEdits.value, ctx)
  }
}

/** Clear the transient "resume" affordance (after resuming, dismissing, or timeout). */
export function clearLastExited(): void {
  lastExited.value = null
}
