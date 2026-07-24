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

/**
 * A focus stage's ephemeral sub-history. While one is open, finalized frames
 * land here (a cursor model) instead of the global undo stack, and the canvas
 * reader (`undo`/`redo`) is disabled — Cmd+Z steps the cursor. On stage close
 * the live prefix folds into ONE frame on the undo stack (see `endFocusBuffer`)
 * and the buffer is discarded: there is no persistent per-session history. This
 * mirrors Penpot's path-editor sub-undo (`path/undo.cljs`). See
 * [[project_undo_model]].
 */
export interface FocusBuffer {
  /** Frames committed while the stage is open, oldest→newest. */
  frames: CommitFrame[]
  /** Count of frames currently applied. Focus undo decrements, redo increments. */
  index: number
  /** Carried onto the single folded frame pushed to the undo stack on exit. */
  label: string
}

/**
 * Fold a session's live frames into ONE frame — same invariant as the
 * transaction merge in {@link HistoryState.pushCommitFrame}: redo concatenated
 * forward (oldest→newest); undo concatenated newest-first (reverse the frame
 * order — each frame's own undo vector is already newest-first). Doc-meta arms
 * mirror it. A single canvas undo of the result reverts the whole session.
 */
function foldFrames(frames: CommitFrame[], label: string): CommitFrame {
  const rev = [...frames].reverse()
  const docRedo = frames.flatMap((f) => f.docMetaRedoChanges ?? [])
  const docUndo = rev.flatMap((f) => f.docMetaUndoChanges ?? [])
  return {
    redoChanges: frames.flatMap((f) => f.redoChanges),
    undoChanges: rev.flatMap((f) => f.undoChanges),
    docMetaRedoChanges: docRedo.length > 0 ? docRedo : undefined,
    docMetaUndoChanges: docUndo.length > 0 ? docUndo : undefined,
    groupId: label,
  }
}

/**
 * Land a finalized frame: into the open focus buffer (truncating any
 * cursor-forward frames first — a fresh edit clears the session's redo) if one
 * is open, else onto the global undo stack, clearing the global redo stack. The
 * single place that decides buffer-vs-stack, so every path agrees.
 */
function landFrame(s: HistoryState, frame: CommitFrame): Partial<HistoryState> {
  if (s.focusBuffer) {
    const kept = s.focusBuffer.frames.slice(0, s.focusBuffer.index)
    return {
      focusBuffer: { ...s.focusBuffer, frames: [...kept, frame], index: kept.length + 1 },
    }
  }
  return { undoStack: [...s.undoStack, frame].slice(-MAX_UNDO), redoStack: [] }
}

/**
 * Fold the open buffer's live prefix onto the undo stack (or just clear it when
 * nothing survives). Shared by {@link HistoryState.endFocusBuffer} and the
 * defensive re-open path in {@link HistoryState.beginFocusBuffer}.
 */
function foldBufferInto(s: HistoryState): Partial<HistoryState> {
  const buf = s.focusBuffer
  if (!buf) return {}
  const live = buf.frames.slice(0, buf.index)
  if (live.length === 0) return { focusBuffer: null }
  return {
    focusBuffer: null,
    undoStack: [...s.undoStack, foldFrames(live, buf.label)].slice(-MAX_UNDO),
    redoStack: [],
  }
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
  /**
   * The open focus stage's ephemeral sub-history, or null in the normal shell.
   * While set, finalized frames land here instead of `undoStack` and canvas
   * undo/redo are disabled. See {@link FocusBuffer}.
   */
  focusBuffer: FocusBuffer | null
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
   * Open a focus sub-history buffer. Any in-flight transaction is landed first,
   * and a still-open prior buffer is defensively folded into history (sessions
   * are single-slot, like the focus stage itself). Subsequent commits land in
   * the buffer until {@link endFocusBuffer}.
   */
  beginFocusBuffer: (label: string) => void
  /**
   * Close the buffer, folding its live prefix into ONE frame on the undo stack
   * (nothing pushed if the prefix is empty). Any in-flight transaction is landed
   * into the buffer first so a gesture mid-exit isn't lost.
   */
  endFocusBuffer: () => void
  /** Move the focus cursor by `delta`, clamped to `[0, frames.length]`. */
  moveFocusCursor: (delta: number) => void
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
  focusBuffer: null,

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
            // Grouping is orthogonal to transactions; keep a groupId if either
            // the buffer or the incoming frame carries one.
            groupId: s.transaction.groupId ?? frame.groupId,
          },
          redoStack: [],
        }
      }
      return landFrame(s, frame)
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
      return { transactionHolders: holders, transaction: null, ...landFrame(s, tx) }
    })
  },

  flushTransactions: () => {
    clearAllTransactionTimers()
    set((s) => {
      const tx = s.transaction
      if (!tx || isCommitFrameEmpty(tx)) {
        return { transaction: null, transactionHolders: new Set<string>() }
      }
      return { transaction: null, transactionHolders: new Set<string>(), ...landFrame(s, tx) }
    })
  },

  beginFocusBuffer: (label) => {
    get().flushTransactions()
    set((s) => ({ ...foldBufferInto(s), focusBuffer: { frames: [], index: 0, label } }))
  },

  endFocusBuffer: () => {
    get().flushTransactions()
    set((s) => foldBufferInto(s))
  },

  moveFocusCursor: (delta) => {
    set((s) => {
      if (!s.focusBuffer) return {}
      const index = Math.max(0, Math.min(s.focusBuffer.frames.length, s.focusBuffer.index + delta))
      return { focusBuffer: { ...s.focusBuffer, index } }
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
      focusBuffer: null,
    })
  },
}))

/**
 * Open a focus sub-history for the stage that's opening. Pair with
 * {@link endFocusBuffer} (typically the session's `onExit`). While open, canvas
 * undo/redo are disabled and Cmd+Z steps the buffer (see focus-undo.ts).
 */
export function beginFocusBuffer(label: string): void {
  useHistoryStore.getState().beginFocusBuffer(label)
}

/** Close the focus sub-history, folding its live prefix into one undo entry. */
export function endFocusBuffer(): void {
  useHistoryStore.getState().endFocusBuffer()
}

/** True while a focus sub-history buffer is open (canvas undo/redo suspended). */
export function isFocusBufferOpen(): boolean {
  return useHistoryStore.getState().focusBuffer != null
}

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
