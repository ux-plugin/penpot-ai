/**
 * Commit record for Penpot-shaped pipeline (redo/undo change vectors).
 */

import type { Change } from 'penpot-exporter/types'
import type { DocMetaChange } from './doc-meta-change'

/**
 * One undo/redo frame: forward edit and its inverse, across both page-scoped
 * changes (mutate `docProxy.pageMap`) and doc-meta changes (mutate
 * `docProxy.meta` — paint styles, text styles). A library-sync commit holds
 * both: the style edit in the doc-meta arm, the cascading shape rewrites in the
 * page arm. A single undo reverts the whole frame atomically.
 */
export interface CommitFrame {
  redoChanges: Change[]
  undoChanges: Change[]
  docMetaRedoChanges?: DocMetaChange[]
  docMetaUndoChanges?: DocMetaChange[]
  /**
   * Write-time tag: the focus session that produced this frame. Canvas undo
   * collapses a run of consecutive same-`groupId` frames into ONE step (so a
   * shader session's idle-coalesced chunks undo together), while focus undo
   * still reverts them one chunk at a time. See [[project_undo_model]].
   */
  groupId?: string
  /**
   * A selective revert-by-append frame (a focus undo of an interleaved edit).
   * Canvas group-undo sweeps it (it carries the session `groupId`); the focus
   * view skips it, so re-undoing doesn't ping-pong into a redo.
   */
  synthetic?: boolean
}

export interface CommitChangesParams {
  redoChanges: Change[]
  undoChanges?: Change[]
  /** Doc-meta variants applied to `docProxy.meta` (library CRUD). Optional. */
  docMetaRedoChanges?: DocMetaChange[]
  docMetaUndoChanges?: DocMetaChange[]
  /** Resolved with workspace `pageId` or first change carrying `pageId` when missing. */
  pageId?: string | null
  /**
   * Default: true when any undo vector (page or doc-meta) is non-empty.
   * Explicit `false` skips history even if undo is provided.
   */
  saveUndo?: boolean
  /** When true (undo/redo replay), do not push history and do not clear redo stack via push. */
  fromHistory?: boolean
  /** Skip renderer sync after local document apply (rare). */
  ignoreRendererSync?: boolean
  /** Stamp the recorded frame's `groupId` (focus-session grouping — see CommitFrame). */
  groupId?: string
  /** Mark the recorded frame `synthetic` (a focus revert-by-append — see CommitFrame). */
  synthetic?: boolean
}
