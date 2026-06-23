/**
 * Undo/redo stacks of commit frames. Does not import commit pipeline (avoids circular deps).
 * Orchestration: {@link undo}/{@link redo} in page-crud call commitChanges.
 */

import { create } from 'zustand'
import type { CommitFrame } from '../changes/commit-types'

const MAX_UNDO = 200

/** A transaction left open this long is force-committed (leak guard, mirrors undo.cljs). */
const TRANSACTION_TIMEOUT_MS = 20_000

/** Default idle window for {@link markHistoryInteraction}. */
const INTERACTION_IDLE_MS = 350

// Watchdog timers per holder id. Module-level — timers are not renderable state.
const transactionTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTransactionTimer(id: string): void {
  const t = transactionTimers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    transactionTimers.delete(id)
  }
}

function clearAllTransactionTimers(): void {
  for (const id of [...transactionTimers.keys()]) clearTransactionTimer(id)
}

/** A frame is empty when neither arm carries an undo vector — nothing to record. */
function isCommitFrameEmpty(frame: CommitFrame): boolean {
  const docUndo = frame.docMetaUndoChanges ?? []
  return frame.undoChanges.length === 0 && docUndo.length === 0
}

export interface HistoryState {
  undoStack: CommitFrame[]
  redoStack: CommitFrame[]
  /**
   * Open undo transaction: while set, commit frames merge here (redo appended,
   * undo prepended) instead of pushing individual history frames. Ported from
   * the frontend's `start-undo-transaction` buffer (undo.cljs).
   */
  transaction: CommitFrame | null
  /** Holder ids keeping the transaction open; the buffer is pushed when the last holder commits. */
  transactionHolders: ReadonlySet<string>
  /** New user commit: push undo frame (or accumulate into the open transaction), clear redo (Penpot-style). */
  pushCommitFrame: (frame: CommitFrame) => void
  /** Pop next undo frame (mutates undo stack). */
  popUndoFrame: () => CommitFrame | undefined
  /** Push frame onto redo stack after undo. */
  pushRedoFrame: (frame: CommitFrame) => void
  /** Pop next redo frame. */
  popRedoFrame: () => CommitFrame | undefined
  /** After redo, push frame back onto undo stack. */
  pushUndoFrame: (frame: CommitFrame) => void
  /**
   * Open (or join) the undo transaction. Refcounted by id: the accumulated
   * frame is pushed when every holder has committed. Re-beginning with the
   * same id is idempotent and resets that holder's watchdog.
   */
  beginTransaction: (id: string, timeoutMs?: number) => void
  /** Release one holder; the last release pushes the accumulated frame as ONE undo entry. */
  commitTransaction: (id: string) => void
  /**
   * Force-commit any open transaction immediately, regardless of holders.
   * Called before undo/redo so an in-flight gesture becomes undoable.
   */
  flushTransactions: () => void
  /**
   * Drop the open transaction without recording history. Does NOT revert the
   * document — callers must have already restored it (e.g. an Escape path that
   * re-committed the original state with `saveUndo: false`).
   */
  discardTransactions: () => void
  clearHistory: () => void
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  undoStack: [],
  redoStack: [],
  transaction: null,
  transactionHolders: new Set<string>(),

  pushCommitFrame: (frame) => {
    const docMetaUndo = frame.docMetaUndoChanges ?? []
    if (frame.undoChanges.length === 0 && docMetaUndo.length === 0) return
    set((s) => {
      if (s.transaction) {
        const txDocRedo = s.transaction.docMetaRedoChanges ?? []
        const txDocUndo = s.transaction.docMetaUndoChanges ?? []
        const frDocRedo = frame.docMetaRedoChanges ?? []
        const mergedDocRedo = [...txDocRedo, ...frDocRedo]
        // Prepend incoming undos so undo replays in array order — same
        // invariant as the page arm above (and changes-builder.ts).
        const mergedDocUndo = [...docMetaUndo, ...txDocUndo]
        return {
          transaction: {
            redoChanges: [...s.transaction.redoChanges, ...frame.redoChanges],
            // Prepend: undo replays in array order, newest-first — same
            // invariant as changes-builder.ts:77 and undo.cljs accumulate.
            undoChanges: [...frame.undoChanges, ...s.transaction.undoChanges],
            docMetaRedoChanges: mergedDocRedo.length > 0 ? mergedDocRedo : undefined,
            docMetaUndoChanges: mergedDocUndo.length > 0 ? mergedDocUndo : undefined,
          },
          redoStack: [],
        }
      }
      return {
        undoStack: [...s.undoStack, frame].slice(-MAX_UNDO),
        redoStack: [],
      }
    })
  },

  popUndoFrame: () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return undefined
    const frame = undoStack[undoStack.length - 1]
    set({ undoStack: undoStack.slice(0, -1) })
    return frame
  },

  pushRedoFrame: (frame) => {
    set((s) => ({ redoStack: [...s.redoStack, frame] }))
  },

  popRedoFrame: () => {
    const { redoStack } = get()
    if (redoStack.length === 0) return undefined
    const frame = redoStack[redoStack.length - 1]
    set({ redoStack: redoStack.slice(0, -1) })
    return frame
  },

  pushUndoFrame: (frame) => {
    set((s) => ({
      undoStack: [...s.undoStack, frame].slice(-MAX_UNDO),
    }))
  },

  beginTransaction: (id, timeoutMs = TRANSACTION_TIMEOUT_MS) => {
    set((s) => ({
      transaction: s.transaction ?? { redoChanges: [], undoChanges: [] },
      transactionHolders: new Set([...s.transactionHolders, id]),
    }))
    clearTransactionTimer(id)
    if (timeoutMs > 0) {
      transactionTimers.set(
        id,
        setTimeout(() => {
          transactionTimers.delete(id)
          console.warn(`[history] transaction "${id}" open for ${timeoutMs}ms — force-committing`)
          get().commitTransaction(id)
        }, timeoutMs),
      )
    }
  },

  commitTransaction: (id) => {
    clearTransactionTimer(id)
    set((s) => {
      if (!s.transactionHolders.has(id)) return s
      const holders = new Set(s.transactionHolders)
      holders.delete(id)
      if (holders.size > 0) return { transactionHolders: holders }
      const tx = s.transaction
      if (!tx || isCommitFrameEmpty(tx)) {
        return { transactionHolders: holders, transaction: null }
      }
      return {
        transactionHolders: holders,
        transaction: null,
        undoStack: [...s.undoStack, tx].slice(-MAX_UNDO),
      }
    })
  },

  flushTransactions: () => {
    clearAllTransactionTimers()
    set((s) => {
      const tx = s.transaction
      if (!tx || isCommitFrameEmpty(tx)) {
        return { transaction: null, transactionHolders: new Set<string>() }
      }
      return {
        transaction: null,
        transactionHolders: new Set<string>(),
        undoStack: [...s.undoStack, tx].slice(-MAX_UNDO),
      }
    })
  },

  discardTransactions: () => {
    clearAllTransactionTimers()
    set({ transaction: null, transactionHolders: new Set<string>() })
  },

  clearHistory: () => {
    clearAllTransactionTimers()
    set({
      undoStack: [],
      redoStack: [],
      transaction: null,
      transactionHolders: new Set<string>(),
    })
  },
}))

/**
 * Begin/join an undo transaction: every commit while it is open merges into
 * ONE history frame, pushed when the last holder calls
 * {@link commitHistoryTransaction}. Use around multi-commit interactions
 * (drag gestures, scrubbing) so a single Ctrl+Z reverts the whole gesture.
 */
export function beginHistoryTransaction(id: string, timeoutMs?: number): void {
  useHistoryStore.getState().beginTransaction(id, timeoutMs)
}

/** Release one holder of the undo transaction (see {@link beginHistoryTransaction}). */
export function commitHistoryTransaction(id: string): void {
  useHistoryStore.getState().commitTransaction(id)
}

/** Drop the open undo transaction without recording history (document must already be restored). */
export function discardHistoryTransactions(): void {
  useHistoryStore.getState().discardTransactions()
}

/**
 * Coalesce a burst of commits into ONE undo frame via an idle watchdog. Call
 * immediately before each commit of a continuous interaction (drag move,
 * color-picker change, per-keystroke edit). The first call opens an undo
 * transaction; each subsequent call within `idleMs` re-arms it; once `idleMs`
 * elapses with no further calls the accumulated frame is pushed.
 *
 * Unlike begin/commit pairs this needs no start/end plumbing and cannot race
 * the trailing async commit — the watchdog fires long after it settles. The
 * tradeoff: distinct edits less than `idleMs` apart merge into one frame, and
 * undo/redo flush the in-progress frame early (which is the desired behavior).
 */
export function markHistoryInteraction(id = 'interaction', idleMs = INTERACTION_IDLE_MS): void {
  useHistoryStore.getState().beginTransaction(id, idleMs)
}
