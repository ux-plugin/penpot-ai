/**
 * Focus scopes over the journal — Phase 1 step B of
 * `docs/history-redesign-plan.md`.
 *
 * Replaces `FocusBuffer`. A focus stage no longer diverts commits into a
 * parallel buffer; it pushes a scope tag, its commits land in the one log
 * carrying that tag, and its own lens reads them back at full granularity. The
 * commit path gains no branch at all.
 *
 * On exit the session collapses to ONE canvas step. The children are not
 * discarded, though: they stay in the log (it is append-only) and remain
 * reachable, because **a scope tag names the SUBJECT, not the visit** —
 * `shader-material:<shapeId>`, not a session counter. Re-entering a shape's
 * shader resumes its history, so undo and redo continue where they left off
 * instead of facing an empty session.
 *
 * That is a deliberate departure from the old `FocusBuffer`, which discarded
 * its contents on exit and started blank on re-entry. The old behaviour meant
 * exiting, undoing from the canvas, and stepping back in left redo with nothing
 * to reach — the entry to redo was canvas-scoped and invisible from inside.
 * Per-subject tags fix that, and match what the Phase 3 tab wants anyway: a
 * shape's shader has *a* history, not one per visit.
 *
 * The collapse entry restates its children's ops rather than referencing them,
 * so a single canvas undo inverts the whole session with no special casing in
 * the reader. It carries `collapses: {from, to}` to mark that restatement —
 * anything replaying the log forward must skip either the entry or its range,
 * or the session lands twice. Nothing replays in Phase 1; Phase 2 will.
 */

import { CANVAS_SCOPE, useJournalStore, type ScopeTag, type Txn } from './journal-store'
import { chainDepth, liveness } from './lens'

/**
 * Enter a focus scope. Every commit until {@link exitScope} is tagged with it,
 * invisible to the canvas lens and visible to that scope's own.
 */
export function enterScope(tag: ScopeTag): void {
  useJournalStore.getState().pushScope(tag)
}

/**
 * Leave the current scope, folding the session's surviving work into one
 * canvas-visible entry. Returns that entry, or undefined when the session left
 * nothing standing — a session fully undone from inside records nothing, which
 * is exactly today's behaviour.
 */
export function exitScope(): Txn | undefined {
  const frame = useJournalStore.getState().popScope()
  if (!frame) return undefined

  const state = useJournalStore.getState()
  const to = state.head()
  const live = liveness(state.txns)

  // What the session NET changed — which is not simply "everything still live".
  //
  // Undoing inside a session appends revert transactions that are themselves
  // live, so concatenating all live entries yields the session's net *state*
  // rather than its net *change*; inverting that would replay the session
  // instead of reverting it. An edit and the undo that cancelled it must both
  // drop out.
  //
  // Parity alone handles that, but not a session that reverts a PREVIOUS
  // session's work — possible since scope tags are per subject and re-entering
  // resumes the same tag. Such a revert is odd-depth, yet its target sits
  // before this session began, so nothing here cancels it and its effect is
  // real. Hence: keep a live entry when it asserts an effect, OR when it
  // retracts something from outside this session's range.
  const inRange = (seq: number): boolean => seq > frame.fromSeq
  const ops = state.txns
    .filter((t) => {
      if (!inRange(t.seq) || t.scope !== frame.tag || live.get(t.seq) !== true) return false
      if (chainDepth(state.txns, t) % 2 === 0) return true
      return t.undoes !== undefined && !inRange(t.undoes)
    })
    .flatMap((t) => t.ops)

  if (ops.length === 0) return undefined

  return state.append({
    ops,
    scope: CANVAS_SCOPE,
    groupId: frame.tag,
    collapses: { from: frame.fromSeq, to },
  })
}

/** True while a focus scope is open — the canvas is not the active lens. */
export function inScope(): boolean {
  return useJournalStore.getState().currentScopeFrame() !== undefined
}

/** The open scope's tag, or undefined in the canvas. */
export function activeScope(): ScopeTag | undefined {
  return useJournalStore.getState().currentScopeFrame()?.tag
}
