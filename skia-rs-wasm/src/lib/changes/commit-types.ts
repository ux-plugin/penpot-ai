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
}
