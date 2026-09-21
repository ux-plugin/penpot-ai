/**
 * Commit record for Penpot-shaped pipeline (redo/undo change vectors).
 */

import type { LocalChange } from './bulk-changes'
import type { DocMetaChange } from './doc-meta-change'

export interface CommitChangesParams {
  redoChanges: LocalChange[]
  undoChanges?: LocalChange[]
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
  /**
   * Subtrees this commit duplicates (source id → new id), so aspects keyed by
   * node id can follow the copy in the same frame. See changes/aspects.ts.
   */
  copies?: ReadonlyArray<{ pageId: string; ids: ReadonlyMap<string, string> }>
}
