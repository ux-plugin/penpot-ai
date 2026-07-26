/**
 * Focus scopes over the journal — Phase 1 step B of
 * `docs/history-redesign-plan.md`.
 *
 * Replaces `FocusBuffer`. A focus stage no longer diverts commits into a
 * parallel buffer; it pushes a scope tag, its commits land in the one log
 * carrying that tag, and its own lens reads them back at full granularity. The
 * commit path gains no branch at all.
 *
 * On exit the session still collapses to ONE canvas step, which is what today's
 * `foldFrames` does — but the mechanism differs in a way that matters. The
 * children are not discarded; they stay in the log (it is append-only, nothing
 * can be removed) and simply become unreachable, because re-entering a stage
 * mints a fresh scope tag and no lens queries the old one. That is
 * behaviour-identical to discarding them, and it leaves the sub-history in
 * place for the Phase 3 history tab to surface later.
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

  // Only transactions that ASSERT an effect and are still standing.
  //
  // Both halves are load-bearing. Liveness alone is not enough: undoing inside
  // a session appends revert transactions, which are themselves live, and
  // concatenating those with the edits yields the session's net *state* rather
  // than its net *change* — inverting it would then replay the session instead
  // of reverting it. Filtering to even chain depth (the same parity rule undo
  // uses) keeps the edits and drops the reverts, so a session fully undone from
  // inside collapses to nothing at all.
  const ops = state.txns
    .filter(
      (t) =>
        t.seq > frame.fromSeq &&
        t.scope === frame.tag &&
        live.get(t.seq) === true &&
        chainDepth(state.txns, t) % 2 === 0,
    )
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
