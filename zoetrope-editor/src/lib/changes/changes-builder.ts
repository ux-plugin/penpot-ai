/**
 * A bundle: the changes one gesture commits together, plus the doc-meta arm.
 * No undo vectors — the reducer returns inverses.
 */
import type { LocalChange, Node } from '../doc'
import { mod } from '../doc'
import type { DocMetaChange } from './doc-meta-change'
import type { CommitParams } from '../doc/commit'

export interface ChangesBuilder {
  changes: LocalChange[]
  docMeta?: DocMetaChange[]
  docMetaUndo?: DocMetaChange[]
  origin?: string
}

export function emptyChangesBuilder(options?: { origin?: string }): ChangesBuilder {
  return { changes: [], origin: options?.origin }
}

export function appendChange(builder: ChangesBuilder, ...changes: LocalChange[]): ChangesBuilder {
  return { ...builder, changes: [...builder.changes, ...changes] }
}

/** A `mod` of one node. */
export function appendMod(builder: ChangesBuilder, id: string, set: Partial<Node>): ChangesBuilder {
  return appendChange(builder, mod('node', id, set))
}

/** A doc-meta redo with the undo the caller worked out. */
export function appendDocMetaPair(
  builder: ChangesBuilder,
  pair: { redo: DocMetaChange; undo: DocMetaChange },
): ChangesBuilder {
  return {
    ...builder,
    docMeta: [...(builder.docMeta ?? []), pair.redo],
    docMetaUndo: [pair.undo, ...(builder.docMetaUndo ?? [])],
  }
}

export function mergeBundle(a: ChangesBuilder, b: ChangesBuilder): ChangesBuilder {
  const docMeta = [...(a.docMeta ?? []), ...(b.docMeta ?? [])]
  const docMetaUndo = [...(b.docMetaUndo ?? []), ...(a.docMetaUndo ?? [])]
  return {
    changes: [...a.changes, ...b.changes],
    docMeta: docMeta.length ? docMeta : undefined,
    docMetaUndo: docMetaUndo.length ? docMetaUndo : undefined,
    origin: a.origin ?? b.origin,
  }
}

export function toCommitBundle(builder: ChangesBuilder): CommitParams {
  return {
    changes: builder.changes,
    docMeta: builder.docMeta,
    docMetaUndo: builder.docMetaUndo,
    label: builder.origin,
  }
}
