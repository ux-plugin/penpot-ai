/**
 * Undo/redo bundle builder: paired `mod-obj` redo/undo changes (Penpot changes-builder analogue).
 *
 * **Undo order**: `appendModObjPair` appends each redo to the end of `redoChanges` and **prepends**
 * each undo to `undoChanges`. When the user undoes, we apply `undoChanges` in array order with
 * `processChanges`, which reverses the order of individual shape inverses relative to the redo pass
 * (last touched shape undoes first). That matches “reverse order of operations” for a batch.
 */

import type { Change, ModObjChange, PenpotNode } from 'penpot-exporter/types'
import type { DocMetaChange } from './doc-meta-change'

const GEOMETRY_UNDO_KEYS = [
  'selrect',
  'points',
  'transform',
  'transformInverse',
  'x',
  'y',
  'width',
  'height',
] as const satisfies readonly (keyof PenpotNode)[]

export interface ChangesBuilder {
  redoChanges: Change[]
  undoChanges: Change[]
  /** Optional doc-meta arm — populated by appendDocMetaPair for library CRUD. */
  docMetaRedoChanges?: DocMetaChange[]
  docMetaUndoChanges?: DocMetaChange[]
  pageId?: string
  origin?: string
}

export function emptyChangesBuilder(options?: { pageId?: string; origin?: string }): ChangesBuilder {
  return {
    redoChanges: [],
    undoChanges: [],
    pageId: options?.pageId,
    origin: options?.origin,
  }
}

/**
 * Append a paired doc-meta redo/undo. Follows the same prepend-undo invariant
 * as {@link appendModObjPair}: redos go to the end, undos to the front, so
 * undo replays in array order match "reverse order of operations".
 *
 * The undo of `add-*` is `del-*`; `del-*` is `add-*` (carrying the prior style
 * value); `mod-*` is `mod-*` (carrying the prior style value). Construction is
 * the caller's job — this just appends.
 */
export function appendDocMetaPair(
  builder: ChangesBuilder,
  pair: { redo: DocMetaChange; undo: DocMetaChange }
): ChangesBuilder {
  return {
    ...builder,
    docMetaRedoChanges: [...(builder.docMetaRedoChanges ?? []), pair.redo],
    docMetaUndoChanges: [pair.undo, ...(builder.docMetaUndoChanges ?? [])],
  }
}

/** Deep snapshot of geometry fields present on `node` (for undo assign). */
export function snapshotGeometryForUndo(node: PenpotNode): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const k of GEOMETRY_UNDO_KEYS) {
    const v = node[k]
    if (v !== undefined) {
      snap[k] =
        v !== null && typeof v === 'object' ? structuredClone(v as object) : v
    }
  }
  return snap
}

function modObj(
  pageId: string | undefined,
  id: string,
  assign: Record<string, unknown>
): ModObjChange {
  const base: ModObjChange = {
    type: 'mod-obj',
    id,
    operations: [{ type: 'assign', value: assign }],
  }
  return pageId ? { ...base, pageId } : base
}

export function appendModObjPair(
  builder: ChangesBuilder,
  pageId: string | undefined,
  id: string,
  pair: { redoAssign: Record<string, unknown>; undoAssign: Record<string, unknown> }
): ChangesBuilder {
  const pid = pageId ?? builder.pageId
  const redo = modObj(pid, id, pair.redoAssign)
  const undo = modObj(pid, id, pair.undoAssign)
  return {
    ...builder,
    redoChanges: [...builder.redoChanges, redo],
    undoChanges: [undo, ...builder.undoChanges],
  }
}

export function buildTransformModObjPair(
  pageId: string | undefined,
  id: string,
  nodeBefore: PenpotNode,
  partialAfter: Record<string, unknown>
): { redo: ModObjChange; undo: ModObjChange } {
  const undoAssign = snapshotGeometryForUndo(nodeBefore)
  const redo = modObj(pageId, id, partialAfter)
  const undo = modObj(pageId, id, undoAssign)
  return { redo, undo }
}

export function mergeBundle(a: ChangesBuilder, b: ChangesBuilder): ChangesBuilder {
  const aDocRedo = a.docMetaRedoChanges ?? []
  const bDocRedo = b.docMetaRedoChanges ?? []
  const aDocUndo = a.docMetaUndoChanges ?? []
  const bDocUndo = b.docMetaUndoChanges ?? []
  return {
    redoChanges: [...a.redoChanges, ...b.redoChanges],
    undoChanges: [...b.undoChanges, ...a.undoChanges],
    docMetaRedoChanges: aDocRedo.length + bDocRedo.length > 0
      ? [...aDocRedo, ...bDocRedo]
      : undefined,
    docMetaUndoChanges: aDocUndo.length + bDocUndo.length > 0
      ? [...bDocUndo, ...aDocUndo]
      : undefined,
    pageId: a.pageId ?? b.pageId,
    origin: a.origin ?? b.origin,
  }
}

export function toCommitBundle(builder: ChangesBuilder): {
  redoChanges: Change[]
  undoChanges: Change[]
  docMetaRedoChanges?: DocMetaChange[]
  docMetaUndoChanges?: DocMetaChange[]
  pageId?: string
} {
  return {
    redoChanges: builder.redoChanges,
    undoChanges: builder.undoChanges,
    docMetaRedoChanges: builder.docMetaRedoChanges,
    docMetaUndoChanges: builder.docMetaUndoChanges,
    pageId: builder.pageId,
  }
}
