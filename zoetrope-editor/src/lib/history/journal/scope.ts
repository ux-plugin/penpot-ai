/**
 * Focus scopes over the journal — Phase 1 step B of
 * `docs/history-redesign-plan.md`.
 *
 * Replaces `FocusBuffer`. A focus stage no longer diverts commits into a
 * parallel buffer; it pushes a scope tag, its commits land in the one log
 * carrying that tag, and its own lens reads them back at full granularity. The
 * commit path gains no branch at all.
 *
 * On exit the session collapses to ONE canvas step. The children stay in the
 * log (it is append-only) and a tag still names the SUBJECT rather than the
 * visit — `shader-material:<shapeId>`, not a session counter — so a shape's
 * shader accumulates one ordered history across every visit, which is what the
 * Phase 3 tab reads.
 *
 * Undo and redo do **not** cross a session boundary, though. The lens is bounded
 * to the current visit, so re-entering a stage starts with nothing to undo even
 * though earlier entries are right there under the same tag. Earlier states of a
 * subject are reached through its version list instead.
 *
 * That boundary is what keeps this module small. Letting Cmd+Z reach back into a
 * finished session meant the collapse entry and its children could disagree
 * about what stands, which cost a liveness rule, an extra clause in the collapse
 * filter, and a fallback lens — three derived rules holding up one idea, each
 * one found by a bug. None of them is needed once undo stays inside the visit.
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
  // drop out, which is what the parity check does.
  //
  // Every entry considered is from this visit alone. A visit cannot revert an
  // earlier visit's work — the lens is bounded by `fromSeq` — so an odd-depth
  // entry in range always cancels an even-depth one in range, and dropping both
  // is exactly right.
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
