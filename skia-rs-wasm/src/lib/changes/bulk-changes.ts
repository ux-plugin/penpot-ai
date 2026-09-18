/**
 * Bulk page changes — one change carrying many shape ids.
 *
 * Fan-out edits (a component main syncing into its copies, a token value
 * resolving into every shape that references it) apply the *same* operations to
 * many shapes. Written as one `mod-obj` per shape, a single edit to a component
 * used in 200 places produces 200 changes in the redo vector and 200 more in the
 * undo vector, and the undo stack keeps them for the rest of the session. That
 * is the measured cost of token propagation today (~5MB frames at 10k shapes).
 *
 * `mod-objs` is the compressed form: the ids that receive an identical set of
 * operations, listed once.
 *
 * **It never reaches a consumer.** `commitChanges` expands bulk changes into
 * ordinary `mod-obj` changes before applying them and before the
 * `changes-applied` event, so the reducer, renderer sync, the worker, the 3D
 * sync and the shader stage all keep seeing exactly what they see today. Only
 * the *history frame* keeps the compressed form — which is precisely where the
 * memory is retained. Undo and redo re-expand on the way back through.
 */
import type { Change, ModObjChange, Operation } from 'penpot-exporter/types'

export interface ModObjsChange {
  type: 'mod-objs'
  /** Shapes receiving `operations`, verbatim and identically. */
  ids: string[]
  pageId?: string
  operations: Operation[]
}

/** The page-change union as the editor writes it: upstream changes plus bulk. */
export type LocalChange = Change | ModObjsChange

export function isBulkChange(change: LocalChange): change is ModObjsChange {
  return (change as { type?: string }).type === 'mod-objs'
}

/** One `mod-obj` per id, in list order. Ordinary changes pass through untouched. */
export function expandBulkChanges(changes: readonly LocalChange[]): Change[] {
  // Fast path: the overwhelming majority of commits carry no bulk change at all,
  // and should not pay for a copy of the array.
  let hasBulk = false
  for (const change of changes) {
    if (isBulkChange(change)) {
      hasBulk = true
      break
    }
  }
  if (!hasBulk) return changes as Change[]

  const out: Change[] = []
  for (const change of changes) {
    if (!isBulkChange(change)) {
      out.push(change)
      continue
    }
    for (const id of change.ids) {
      const expanded: ModObjChange = {
        type: 'mod-obj',
        id,
        operations: change.operations,
      }
      if (change.pageId != null) expanded.pageId = change.pageId
      out.push(expanded)
    }
  }
  return out
}

/** How many shape-level edits a vector represents, counting bulk ids individually. */
export function countShapeEdits(changes: readonly LocalChange[]): number {
  let total = 0
  for (const change of changes) total += isBulkChange(change) ? change.ids.length : 1
  return total
}

export interface BulkAssignOptions {
  /**
   * Marks the write as system-generated, so component override tracking does not
   * treat it as the user editing a copy. Upstream's flag, same meaning.
   */
  ignoreTouched?: boolean
}

/** A bulk `assign` of the same values across many shapes. */
export function bulkAssign(
  pageId: string,
  ids: readonly string[],
  assign: Record<string, unknown>,
  options?: BulkAssignOptions,
): ModObjsChange {
  return {
    type: 'mod-objs',
    ids: [...ids],
    pageId,
    operations: [
      options?.ignoreTouched
        ? { type: 'assign', value: assign, ignoreTouched: true }
        : { type: 'assign', value: assign },
    ],
  }
}

/**
 * Group shapes by the values they are reverting *to*, then emit one bulk change
 * per distinct group.
 *
 * The redo side of a fan-out is naturally uniform — every target receives the
 * same new value — but the undo side only is when the targets were in sync to
 * begin with. Grouping keeps the compression lossless either way: shapes that
 * shared a previous value share a change, and an odd one out gets its own.
 */
export function bulkAssignByValue(
  pageId: string,
  entries: ReadonlyArray<{ id: string; assign: Record<string, unknown> }>,
  options?: BulkAssignOptions,
): ModObjsChange[] {
  const groups = new Map<string, { assign: Record<string, unknown>; ids: string[] }>()
  for (const entry of entries) {
    const key = JSON.stringify(entry.assign)
    const group = groups.get(key)
    if (group) group.ids.push(entry.id)
    else groups.set(key, { assign: entry.assign, ids: [entry.id] })
  }
  return Array.from(groups.values(), (group) =>
    bulkAssign(pageId, group.ids, group.assign, options),
  )
}
