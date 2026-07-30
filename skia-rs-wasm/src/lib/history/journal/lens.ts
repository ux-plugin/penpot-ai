/**
 * History lenses — Phase 1 slice 3 of `docs/history-redesign-plan.md`.
 *
 * A mode does not own a history. It owns a *query* over the one log. Canvas,
 * path edit, shader and 3D differ only in which transactions they can see and
 * which one they reach for next; none of them gets a stack, and adding a fifth
 * mode adds a predicate rather than another parallel buffer.
 *
 * ## Liveness, and why it is not a boolean on the row
 *
 * An undo is an ordinary transaction carrying an `undoes` back-pointer, so an
 * undo can itself be undone — that *is* redo. Which means "has this been undone
 * already?" cannot be a flag written at undo time: undoing the undo would have
 * to go back and rewrite it, and the log is append-only.
 *
 * It is instead derived, by one backward pass. An undoer always has a higher
 * `seq` than its target, so walking newest-to-oldest means every undoer's own
 * liveness is already known by the time its target is examined:
 *
 *     live(X)  ⇔  no live transaction undoes X
 *
 * The newest entry is unconditionally live (nothing exists that could revert
 * it), which grounds the recursion. A chain T ← U ← R then falls out correctly:
 * R is live, so U is dead, so T is live again — the redo.
 *
 * ## Doing versus undoing
 *
 * Follow `undoes` to the original edit and count the hops. Even depth means a
 * transaction that *asserts* an effect (an original edit, or a redo); odd depth
 * means one that *retracts* one. So the two verbs are the same query with
 * opposite parity, which is why there is no separate redo bookkeeping:
 *
 * - **undo** targets the most recent live transaction at even depth
 * - **redo** targets the most recent live transaction at odd depth
 */

import type { ActorId, ScopeTag, Txn } from './journal-store'
import { CANVAS_SCOPE, LOCAL_ACTOR, useJournalStore } from './journal-store'

/** What a lens resolves its predicate against. */
export interface LensCtx {
  actor: ActorId
}

/**
 * How a lens wants `rebase` conflicts handled. Consumed in slice 4; carried
 * here because it belongs to the mode's identity, not to the undo call.
 */
export type ConflictPolicy = 'refuse' | 'apply'

export interface HistoryLens {
  id: string
  /** Which transactions this lens can see. */
  filter: (txn: Txn, ctx: LensCtx) => boolean
  conflict: ConflictPolicy
}

/**
 * The main editor's view: my own work on the canvas. Focus-scoped entries are
 * deliberately invisible — a focus session reaches the canvas as the single
 * collapsed entry written on exit (slice 5), not as its individual steps.
 */
export const canvasLens: HistoryLens = {
  id: 'canvas',
  filter: (txn, ctx) => txn.actor === ctx.actor && txn.scope === CANVAS_SCOPE,
  conflict: 'refuse',
}

/** A mode's view: my own work inside one scope, at that scope's own granularity. */
export function scopeLens(scope: ScopeTag, conflict: ConflictPolicy = 'refuse'): HistoryLens {
  return {
    id: scope,
    filter: (txn, ctx) => txn.actor === ctx.actor && txn.scope === scope,
    conflict,
  }
}

/**
 * The one canvas entry a focus session is allowed to reach: the undo of *its
 * own* collapse.
 *
 * Exiting a session, undoing it from the canvas, then stepping back in leaves
 * the session's own entries dead — correctly, the edits really were reverted —
 * so the scope lens has nothing to redo, and the only transaction that can
 * restore the work is canvas-scoped. Falling back to the whole `canvasLens` for
 * that is far too wide: it picks the newest live undo from *any* subject, so a
 * redo pressed inside a shader stage can resurrect a rename on an unrelated
 * shape. This narrows the reach to undos whose target is a collapse tagged with
 * this scope — which is precisely the session coming back.
 *
 * It needs the log to resolve `undoes` back to a collapse, so it is a factory
 * over `txns` rather than a constant. Building the seq set once keeps the
 * filter O(1) per entry.
 */
export function collapseRedoLens(tag: ScopeTag, txns: readonly Txn[]): HistoryLens {
  const mine = new Set(
    txns.filter((t) => t.collapses !== undefined && t.groupId === tag).map((t) => t.seq),
  )
  return {
    id: `${tag}→canvas`,
    filter: (txn, ctx) =>
      txn.actor === ctx.actor &&
      txn.scope === CANVAS_SCOPE &&
      txn.undoes !== undefined &&
      mine.has(txn.undoes),
    conflict: 'refuse',
  }
}

/**
 * Derive liveness for every transaction in one backward pass. See the module
 * header — a transaction is live unless something live undoes it, and undoers
 * always sit later in the log, so newest-first resolves without recursion.
 */
export function liveness(txns: readonly Txn[]): Map<number, boolean> {
  const undoersOf = new Map<number, Txn[]>()
  for (const t of txns) {
    if (t.undoes === undefined) continue
    const list = undoersOf.get(t.undoes)
    if (list) list.push(t)
    else undoersOf.set(t.undoes, [t])
  }

  const live = new Map<number, boolean>()
  for (let i = txns.length - 1; i >= 0; i -= 1) {
    const t = txns[i]
    const undoers = undoersOf.get(t.seq) ?? []
    live.set(t.seq, !undoers.some((u) => live.get(u.seq) === true))
  }

  // A collapse entry restates what its children already applied, so the two
  // representations must not disagree about what stands. Reverting the collapse
  // reverts the children's effect, but nothing points at the children — so
  // without this they stay "live" while the document no longer reflects them,
  // and a scope lens reading them concludes work is present that is actually
  // gone. Newest-first so a collapse inside a collapse settles before its own
  // range is considered.
  for (let i = txns.length - 1; i >= 0; i -= 1) {
    const c = txns[i]
    if (!c.collapses || live.get(c.seq) === true) continue
    for (const t of txns) {
      if (t.seq > c.collapses.from && t.seq <= c.collapses.to) live.set(t.seq, false)
    }
  }
  return live
}

/**
 * Hops from `txn` back to the original edit. Even means it asserts an effect
 * (an edit, or a redo); odd means it retracts one.
 *
 * A pointer to a transaction that has been evicted by the retention cap stops
 * the walk — the depth is then relative to the oldest entry we still hold,
 * which is the best available answer and never worse than treating it as an
 * original edit.
 */
export function chainDepth(txns: readonly Txn[], txn: Txn): number {
  const bySeq = new Map(txns.map((t) => [t.seq, t]))
  let depth = 0
  let cur: Txn | undefined = txn
  const seen = new Set<number>()
  while (cur?.undoes !== undefined) {
    if (seen.has(cur.seq)) break // defensive: a cycle cannot occur, but never hang
    seen.add(cur.seq)
    const next: Txn | undefined = bySeq.get(cur.undoes)
    if (!next) break
    depth += 1
    cur = next
  }
  return depth
}

/** Shared walk: newest visible, live transaction whose chain parity matches. */
function pick(
  txns: readonly Txn[],
  lens: HistoryLens,
  ctx: LensCtx,
  parity: 0 | 1,
): Txn | undefined {
  const live = liveness(txns)
  for (let i = txns.length - 1; i >= 0; i -= 1) {
    const t = txns[i]
    if (!lens.filter(t, ctx)) continue
    if (live.get(t.seq) !== true) continue
    if (chainDepth(txns, t) % 2 === parity) return t
  }
  return undefined
}

/** The transaction an undo through this lens would revert, if any. */
export function pickUndo(
  txns: readonly Txn[],
  lens: HistoryLens,
  ctx: LensCtx,
): Txn | undefined {
  return pick(txns, lens, ctx, 0)
}

/**
 * The undo this lens would reverse — redo, found by parity rather than a stack.
 *
 * With no redo stack there is nothing to clear, so the rule that a fresh edit
 * discards the redo branch has to be expressed here instead: walking
 * newest-first, an original edit (depth 0) encountered before any undo means
 * the user has done new work on top and redo is gone. Without this, redo
 * reaches straight past new work and resurrects what was undone — which is not
 * what any editor does.
 *
 * A *redo* (even depth, but not 0) does not invalidate anything, so the walk
 * steps over it and keeps looking; that is what lets a run of undos be redone
 * one after another.
 *
 * The check sits inside the lens filter deliberately: another actor's edit must
 * not discard my redo branch.
 */
export function pickRedo(
  txns: readonly Txn[],
  lens: HistoryLens,
  ctx: LensCtx,
): Txn | undefined {
  const live = liveness(txns)
  for (let i = txns.length - 1; i >= 0; i -= 1) {
    const t = txns[i]
    if (!lens.filter(t, ctx)) continue
    if (live.get(t.seq) !== true) continue
    const depth = chainDepth(txns, t)
    if (depth % 2 === 1) return t
    if (depth === 0) return undefined // fresh work on top — the branch is gone
  }
  return undefined
}

/** Default context — the single local actor, until Phase 4. */
export function localCtx(): LensCtx {
  return { actor: LOCAL_ACTOR }
}

/** Live-store convenience: can this lens undo right now? (Button state.) */
export function canUndo(lens: HistoryLens, ctx: LensCtx = localCtx()): boolean {
  return pickUndo(useJournalStore.getState().txns, lens, ctx) !== undefined
}

/** Live-store convenience: can this lens redo right now? */
export function canRedo(lens: HistoryLens, ctx: LensCtx = localCtx()): boolean {
  return pickRedo(useJournalStore.getState().txns, lens, ctx) !== undefined
}
