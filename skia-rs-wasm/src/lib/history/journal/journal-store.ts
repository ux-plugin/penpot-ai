/**
 * The journal — one append-only log of transactions per document. Phase 1
 * slice 2 of `docs/history-redesign-plan.md`.
 *
 * This replaces `undoStack`/`redoStack`. Two structural consequences worth
 * stating plainly, because they are what the rest of the design rests on:
 *
 * - **There is no redo stack.** An undo is an ordinary transaction that happens
 *   to carry an `undoes` back-pointer, so redo is a query over the log rather
 *   than a second pile of frames. Nothing here pops.
 * - **Nothing is ever removed.** `append` is the only way in. Compaction behind
 *   a covering snapshot (Phase 2) is the sole exception, and it is not this
 *   module's concern.
 *
 * Sequencing is solo (D13): with no server, the client is its own sequencer and
 * `seq` is simply `head + 1`. `parentSeq` records what the committer saw, which
 * is the input `rebase()` needs and the hook Phase 4 hangs the real sequencer
 * on. The `pending` table in the plan's schema has no counterpart here on
 * purpose — nothing is unacked when there is nobody to ack.
 *
 * The transaction machinery (refcounted holders, watchdog, idle coalescing) is
 * ported from `history-store` rather than redesigned: it is orthogonal to how
 * entries are stored, it is already proven, and its semantics are pinned by
 * tests. The one difference is that it now accumulates {@link Op}s instead of
 * `Change` vectors, so merging is a plain concat — the prepend-undo invariant
 * the old buffer had to maintain is gone, because inverses are derived rather
 * than carried.
 */

import { create } from 'zustand'
import type { Op } from './op'

/** Who wrote a transaction. One local actor until Phase 4 brings collaborators. */
export type ActorId = string

/**
 * Where a transaction was written — `'canvas'`, or a mode's own tag such as
 * `path-edit:<id>`. A lens filters on this; it is never a separate log.
 */
export type ScopeTag = string

export const CANVAS_SCOPE: ScopeTag = 'canvas'

/** The single local actor. Phase 4 replaces this with real identity. */
export const LOCAL_ACTOR: ActorId = 'local'

/** A transaction left open this long is force-committed (leak guard). */
const TRANSACTION_TIMEOUT_MS = 20_000

/** Default idle window for {@link markJournalInteraction}. */
const INTERACTION_IDLE_MS = 350

/**
 * Retained transaction count. A blunt cap for Phase 1 — the plan replaces it
 * with per-scope budgets and tiered retention in Phase 2, so that a focus
 * mode's 500 drags evict only its own history and never the canvas's.
 */
const MAX_TXNS = 500

export interface Txn {
  /** Total order. Solo: `head + 1`. Server-assigned once there is a server. */
  seq: number
  actor: ActorId
  /** Head the committer observed. The gap `rebase()` maps through. */
  parentSeq: number
  scope: ScopeTag
  /** Focus session that produced this, when any. */
  groupId?: string
  /** Set when this transaction reverts another — the back-pointer redo follows. */
  undoes?: number
  /**
   * Set on the entry written when a focus scope closes. Its `ops` restate what
   * the transactions in `(from, to]` already applied, so one canvas undo reverts
   * the whole session — but they are a *restatement*, not new work. Anything
   * replaying the log forward (Phase 2 snapshots) must skip either this entry or
   * the range it covers, or the session lands twice.
   */
  collapses?: { from: number; to: number }
  ops: Op[]
}

/** An open scope and the head it opened at, so its range is known on exit. */
export interface ScopeFrame {
  tag: ScopeTag
  fromSeq: number
}

/** What a caller supplies; the store owns `seq` and `parentSeq`. */
export interface TxnInput {
  ops: Op[]
  scope?: ScopeTag
  groupId?: string
  undoes?: number
  collapses?: { from: number; to: number }
  actor?: ActorId
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(id)
  }
}

function clearAllTimers(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
}

export interface JournalState {
  /** The log, oldest first. Append-only. */
  txns: Txn[]
  /** Open transaction: ops accumulate here instead of landing as entries. */
  pending: TxnInput | null
  /** Holder ids keeping the open transaction alive; the last release lands it. */
  holders: ReadonlySet<string>
  /**
   * Scope stack. The top is stamped onto every appended transaction, so a focus
   * mode marks its work simply by pushing — no parallel buffer, no branching in
   * the commit path. Slice 5 wires the stages to it.
   */
  scopes: ScopeFrame[]

  /** Append ops as one transaction (or merge into the open one). Returns the entry, if any. */
  append: (input: TxnInput) => Txn | undefined
  /** Everything strictly after `seq`, oldest first — the gap for `rebase()`. */
  since: (seq: number) => Txn[]
  /** Look up one entry by `seq`. */
  at: (seq: number) => Txn | undefined
  /** Highest assigned `seq`, or 0 when empty. */
  head: () => number

  /** Open or join the coalescing transaction; refcounted by `id`. */
  begin: (id: string, timeoutMs?: number) => void
  /** Release one holder; the last release appends the accumulated entry. */
  commit: (id: string) => void
  /** Force-append any open transaction regardless of holders. */
  flush: () => void
  /** Drop the open transaction without recording (document must already be restored). */
  discard: () => void

  /** Enter a scope; subsequent entries are stamped with it. */
  pushScope: (scope: ScopeTag) => void
  /** Leave the current scope, returning the frame that closed. */
  popScope: () => ScopeFrame | undefined
  /** The scope entries are currently stamped with. */
  currentScope: () => ScopeTag
  /** The open scope frame, or undefined in the canvas. */
  currentScopeFrame: () => ScopeFrame | undefined

  clear: () => void
}

/** Merge `b` into `a`. Ops concatenate forward; tags survive from either side. */
function mergeInput(a: TxnInput, b: TxnInput): TxnInput {
  return {
    ops: [...a.ops, ...b.ops],
    scope: a.scope ?? b.scope,
    groupId: a.groupId ?? b.groupId,
    undoes: a.undoes ?? b.undoes,
    collapses: a.collapses ?? b.collapses,
    actor: a.actor ?? b.actor,
  }
}

export const useJournalStore = create<JournalState>()((set, get) => ({
  txns: [],
  pending: null,
  holders: new Set<string>(),
  scopes: [],

  append: (input) => {
    // An undo whose ops all dropped (the target's effect was already gone)
    // still has to be recorded, or the target stays live and the next undo
    // picks it again — forever. Such an entry is a tombstone: it applies
    // nothing and exists only to mark its target reverted.
    if (input.ops.length === 0 && input.undoes === undefined) return undefined

    if (get().pending) {
      set((s) => ({ pending: s.pending ? mergeInput(s.pending, input) : input }))
      return undefined
    }

    const s = get()
    const parentSeq = s.head()
    const txn: Txn = {
      seq: parentSeq + 1,
      actor: input.actor ?? LOCAL_ACTOR,
      parentSeq,
      scope: input.scope ?? s.currentScope(),
      groupId: input.groupId,
      undoes: input.undoes,
      collapses: input.collapses,
      ops: input.ops,
    }
    set({ txns: [...s.txns, txn].slice(-MAX_TXNS) })
    return txn
  },

  since: (seq) => get().txns.filter((t) => t.seq > seq),

  at: (seq) => get().txns.find((t) => t.seq === seq),

  head: () => {
    const { txns } = get()
    return txns.length === 0 ? 0 : txns[txns.length - 1].seq
  },

  begin: (id, timeoutMs = TRANSACTION_TIMEOUT_MS) => {
    set((s) => ({
      pending: s.pending ?? { ops: [] },
      holders: new Set([...s.holders, id]),
    }))
    clearTimer(id)
    if (timeoutMs > 0) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          console.warn(`[journal] transaction "${id}" open for ${timeoutMs}ms — force-committing`)
          get().commit(id)
        }, timeoutMs),
      )
    }
  },

  commit: (id) => {
    clearTimer(id)
    const s = get()
    if (!s.holders.has(id)) return
    const holders = new Set(s.holders)
    holders.delete(id)
    if (holders.size > 0) {
      set({ holders })
      return
    }
    const buffered = s.pending
    // Clear first, so `append` below lands as an entry instead of re-merging.
    set({ holders, pending: null })
    if (buffered && buffered.ops.length > 0) get().append(buffered)
  },

  flush: () => {
    clearAllTimers()
    const buffered = get().pending
    set({ pending: null, holders: new Set<string>() })
    if (buffered && buffered.ops.length > 0) get().append(buffered)
  },

  discard: () => {
    clearAllTimers()
    set({ pending: null, holders: new Set<string>() })
  },

  pushScope: (scope) => {
    // An in-flight gesture belongs to the scope it started in.
    get().flush()
    set((s) => ({ scopes: [...s.scopes, { tag: scope, fromSeq: s.head() }] }))
  },

  popScope: () => {
    // Land any in-flight gesture INSIDE the scope, before leaving it.
    get().flush()
    const frame = get().currentScopeFrame()
    set((s) => ({ scopes: s.scopes.slice(0, -1) }))
    return frame
  },

  currentScope: () => {
    const { scopes } = get()
    return scopes.length === 0 ? CANVAS_SCOPE : scopes[scopes.length - 1].tag
  },

  currentScopeFrame: () => {
    const { scopes } = get()
    return scopes.length === 0 ? undefined : scopes[scopes.length - 1]
  },

  clear: () => {
    clearAllTimers()
    set({ txns: [], pending: null, holders: new Set<string>(), scopes: [] })
  },
}))

/** Append ops as one transaction. See {@link JournalState.append}. */
export function appendTxn(input: TxnInput): Txn | undefined {
  return useJournalStore.getState().append(input)
}

/**
 * Begin or join the coalescing transaction: every `append` while it is open
 * merges into ONE entry, written when the last holder releases. Use around
 * multi-commit interactions (drags, scrubbing) so one Cmd+Z reverts the gesture.
 */
export function beginJournalTransaction(id: string, timeoutMs?: number): void {
  useJournalStore.getState().begin(id, timeoutMs)
}

/** Release one holder of the coalescing transaction. */
export function commitJournalTransaction(id: string): void {
  useJournalStore.getState().commit(id)
}

/** Drop the open transaction without recording (the document must already be restored). */
export function discardJournalTransaction(): void {
  useJournalStore.getState().discard()
}

/**
 * Coalesce a burst of commits into one entry via an idle watchdog. Call
 * immediately before each commit of a continuous interaction; the first call
 * opens a transaction and each subsequent call within `idleMs` re-arms it.
 *
 * Unlike begin/commit pairs this needs no start/end plumbing and cannot race a
 * trailing async commit — the watchdog fires long after it settles.
 */
export function markJournalInteraction(id = 'interaction', idleMs = INTERACTION_IDLE_MS): void {
  useJournalStore.getState().begin(id, idleMs)
}
