/**
 * `Change[]` ⇄ `Op[]` — the bridge between the commit pipeline and the journal.
 * Phase 1 slice 1 of `docs/history-redesign-plan.md`.
 *
 * The pipeline speaks `Change`, a page-scoped union the worker's
 * `processChanges` applies. The journal speaks {@link Op}, which is field-level
 * and carries before-values. Neither can be replaced by the other, so this
 * translates.
 *
 * **Where before-values come from.** The redesign says never to store inverses
 * at record time — but every commit already arrives at `recordHistoryFrame`
 * with a hand-built `undoChanges` vector beside its `redoChanges`. That pair is
 * exactly the before-state, so {@link toOps} consumes it as *input* rather than
 * treating it as the thing undo replays. The inverse itself is still derived at
 * undo time by `invert()` and rebased. This is what keeps all 16 `commitChanges`
 * call sites untouched in Phase 1.
 *
 * **Pairing.** `changes-builder` appends each redo and *prepends* each undo, so
 * the two vectors are positional mirrors: `redo[i]` pairs with
 * `undo[len - 1 - i]`. Hand-built bundles elsewhere in the codebase do not all
 * honour that, so the mirror is treated as a hint and validated by id; on a miss
 * we search. A pair that cannot be found is not an error — it means the commit
 * recorded no before-state, and the resulting op simply carries `undefined`.
 */

import type {
  AddObjChange,
  Change,
  DelObjChange,
  ModObjChange,
  MovObjectsChange,
  Operation,
  ReorderChildrenChange,
} from 'penpot-exporter/types'
import type { DocMetaChange } from '../../changes/doc-meta-change'
import type { Op, SetOp } from './op'
import { DOC_ENTITY } from './op'

/** The `Change` variants this module models structurally; anything else is boxed. */
const MODELLED = new Set<string>([
  'add-obj',
  'del-obj',
  'mod-obj',
  'mov-objects',
  'reorder-children',
])

/** Positions are opaque to `rebase`. Phase 1 derives them from the array index. */
const posOf = (index: number | null | undefined): string => String(index ?? -1)
const indexOf = (pos: string): number | null => {
  const n = Number(pos)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ------------------------------------------------------------------ doc-meta

/**
 * Identity of a doc-meta record, so two edits to the same token collide on one
 * key. Every variant carries something addressable; `set-active-themes` is a
 * single document-wide slot and keys on its own name.
 */
export function docMetaField(change: DocMetaChange): string {
  switch (change.type) {
    case 'add-token':
    case 'mod-token':
      return `token:${change.setId}/${change.token.id}`
    case 'del-token':
      return `token:${change.setId}/${change.tokenId}`
    case 'add-token-set':
      return `set:${change.set.id}`
    case 'mod-token-set':
    case 'del-token-set':
      return `set:${change.setId}`
    case 'add-theme':
      return `theme:${change.theme.id}`
    case 'mod-theme':
    case 'del-theme':
      return `theme:${change.id}`
    case 'set-active-themes':
      return 'active-themes'
    // Whole-material granularity: two edits to one material collide, edits to
    // two materials commute. Splitting further — a key per function, per uniform
    // — is what makes two edits *inside* one shader commute, and it arrives with
    // the function-map storage rather than here.
    case 'add-material':
    case 'mod-material':
    case 'del-material':
      return `material:${change.materialId}`
  }
}

/**
 * Doc-meta records ride as boxed `set` ops: the forward change in `val`, its
 * counterpart in `was`. `invert()` swaps the two, which is precisely the right
 * inverse without this module knowing anything about tokens. Modelling tokens
 * as real field ops is worthwhile later; it is not needed to move the log.
 *
 * Paired POSITIONALLY, not by identity. `appendDocMetaPair` mirrors the page
 * arm — redo appended, undo prepended — so `redo[i]` pairs with
 * `undo[len-1-i]`. Pairing by {@link docMetaField} instead looks tempting but is
 * wrong whenever one commit emits several changes sharing an identity:
 * `reorderSet` emits `del-token-set` + `add-token-set` for the SAME set, and
 * identity pairing collapsed them into a duplicate `add` with the `del` lost.
 * The field is still the conflict key — just not the pairing key.
 */
function docMetaOps(
  redo: readonly DocMetaChange[],
  undo: readonly DocMetaChange[],
): SetOp[] {
  return redo.map((c, i) => ({
    t: 'set',
    entity: DOC_ENTITY,
    field: docMetaField(c),
    val: c,
    was: undo[undo.length - 1 - i],
    arm: 'meta',
  }))
}

/**
 * Carry a `Change` the switch below does not model — today `set-page-interactions`,
 * which is a local extension to the exporter's union. Boxed verbatim so it
 * round-trips exactly, keyed by page so two interaction edits to one page still
 * collide. Dropping unknown variants instead is silent data loss: undo simply
 * fails to revert them.
 */
function boxedPageOp(change: Change, undo: Change | undefined): SetOp {
  const c = change as { pageId?: string; type: string }
  return {
    t: 'set',
    entity: c.pageId ?? 'page',
    page: c.pageId,
    field: `page:${c.type}`,
    val: change,
    was: undo,
    arm: 'page',
  }
}

// ------------------------------------------------------------------ pairing

/** Does `undo` look like the inverse of `redo`? */
function isCounterpart(redo: Change, undo: Change): boolean {
  // A variant we do not model (a local extension) pairs with the same variant
  // on the same page — the shape of every such change in this codebase.
  if (!MODELLED.has(redo.type)) {
    return (
      undo.type === redo.type &&
      (undo as { pageId?: string }).pageId === (redo as { pageId?: string }).pageId
    )
  }
  switch (redo.type) {
    case 'add-obj':
      return undo.type === 'del-obj' && undo.id === redo.id
    case 'del-obj':
      return undo.type === 'add-obj' && undo.id === redo.id
    case 'mod-obj':
      return undo.type === 'mod-obj' && undo.id === redo.id
    case 'mov-objects':
      return undo.type === 'mov-objects' && undo.shapes.some((s) => redo.shapes.includes(s))
    case 'reorder-children':
      return undo.type === 'reorder-children' && undo.parentId === redo.parentId
  }
}

/**
 * Find the undo change matching `redo`. Tries the positional mirror first
 * (correct for anything built by `changes-builder`) and falls back to a scan.
 */
function counterpart(redo: Change, undos: readonly Change[], i: number): Change | undefined {
  const mirror = undos[undos.length - 1 - i]
  if (mirror && isCounterpart(redo, mirror)) return mirror
  return undos.find((u) => isCounterpart(redo, u))
}

// ------------------------------------------------------------------ to ops

/** Flatten a `mod-obj`'s operations into `field -> value`, in application order. */
function assignments(change: ModObjChange): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const op of change.operations as Operation[]) {
    switch (op.type) {
      case 'assign':
        for (const [k, v] of Object.entries(op.value)) out.set(k, v)
        break
      case 'set':
        out.set(op.attr, op.val)
        break
      case 'set-touched':
        out.set('touched', op.touched)
        break
      case 'set-remote-synced':
        out.set('remoteSynced', op.remoteSynced)
        break
    }
  }
  return out
}

function movOps(
  change: MovObjectsChange | ReorderChildrenChange,
  undo: Change | undefined,
  via: 'mov-objects' | 'reorder-children',
): Op[] {
  const parent = change.parentId
  const base = change.type === 'mov-objects' ? (change.index ?? 0) : 0
  // A `reorder-children` restates the whole sibling order, so each shape's
  // position is its slot in the list; `mov-objects` inserts a run at one index.
  const prior =
    undo && (undo.type === 'mov-objects' || undo.type === 'reorder-children') ? undo : undefined
  const priorBase = prior?.type === 'mov-objects' ? (prior.index ?? 0) : 0

  return change.shapes.map((entity, i): Op => {
    const priorSlot = prior ? prior.shapes.indexOf(entity) : -1
    return {
      t: 'mov',
      entity,
      page: change.pageId,
      parent,
      pos: posOf(base + i),
      wasParent: prior?.parentId ?? parent,
      wasPos: posOf(priorSlot >= 0 ? priorBase + priorSlot : -1),
      via,
    }
  })
}

/**
 * Normalize one commit into journal ops, newest last.
 *
 * A `mod-obj` becomes one {@link SetOp} per field — the whole point, since the
 * multiplayer design needs `(entity, field)` to be the unit that commutes and a
 * whole-value `assign` clobbers instead.
 *
 * Note a field absent from the undo vector yields `was: undefined`, and
 * assigning `undefined` is a no-op in the apply layer — so such a field cannot
 * be un-set, only overwritten. That limitation is inherited from the existing
 * hand-built inverses rather than introduced here, which is why round-tripping
 * against them still holds.
 */
export function toOps(params: {
  redoChanges: readonly Change[]
  undoChanges?: readonly Change[]
  docMetaRedoChanges?: readonly DocMetaChange[]
  docMetaUndoChanges?: readonly DocMetaChange[]
}): Op[] {
  const undos = params.undoChanges ?? []
  const ops: Op[] = []

  params.redoChanges.forEach((change, i) => {
    const undo = counterpart(change, undos, i)
    if (!MODELLED.has(change.type)) {
      ops.push(boxedPageOp(change, undo))
      return
    }
    switch (change.type) {
      case 'add-obj':
        ops.push({
          t: 'add',
          entity: change.id,
          page: change.pageId,
          node: change.obj,
          parent: change.parentId ?? change.frameId,
          frame: change.frameId,
          pos: posOf(change.index),
        })
        break

      case 'del-obj': {
        // The before-state lives in the paired `add-obj`; without it we can
        // record the deletion but never invert it.
        const prior = undo?.type === 'add-obj' ? undo : undefined
        ops.push({
          t: 'del',
          entity: change.id,
          page: change.pageId,
          node: prior?.obj,
          parent: prior?.parentId ?? prior?.frameId ?? '',
          frame: prior?.frameId,
          pos: posOf(prior?.index),
        })
        break
      }

      case 'mod-obj': {
        const before = undo?.type === 'mod-obj' ? assignments(undo) : new Map<string, unknown>()
        for (const [field, val] of assignments(change)) {
          ops.push({ t: 'set', entity: change.id, page: change.pageId, field, val, was: before.get(field) })
        }
        break
      }

      case 'mov-objects':
        ops.push(...movOps(change, undo, 'mov-objects'))
        break

      case 'reorder-children':
        ops.push(...movOps(change, undo, 'reorder-children'))
        break
    }
  })

  ops.push(...docMetaOps(params.docMetaRedoChanges ?? [], params.docMetaUndoChanges ?? []))
  return ops
}

// --------------------------------------------------------------- to changes

/**
 * Rebuild a commit from journal ops — what undo feeds back into
 * `commitChanges`. Consecutive ops that belong together are recombined (a run
 * of `set`s on one entity becomes one `mod-obj`; a run of `mov`s sharing a
 * parent becomes one `mov-objects` or `reorder-children`), so the output is the
 * shape the apply layer already handles rather than one change per field.
 */
export function toChanges(ops: readonly Op[]): {
  changes: Change[]
  docMetaChanges: DocMetaChange[]
} {
  const changes: Change[] = []
  const docMetaChanges: DocMetaChange[] = []

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]

    if (op.t === 'set' && op.arm !== undefined) {
      // `val` holds the change for this direction; `invert` already swapped it.
      // An absent `val` means the commit recorded no counterpart, so there is
      // nothing to emit in this direction.
      if (op.val !== undefined) {
        if (op.arm === 'meta') docMetaChanges.push(op.val as DocMetaChange)
        else changes.push(op.val as Change)
      }
      continue
    }

    switch (op.t) {
      case 'add': {
        const change: AddObjChange = {
          type: 'add-obj',
          id: op.entity,
          obj: op.node as AddObjChange['obj'],
          frameId: op.frame ?? op.parent,
          parentId: op.parent,
          index: indexOf(op.pos),
        }
        changes.push(op.page ? { ...change, pageId: op.page } : change)
        break
      }

      case 'del': {
        const change: DelObjChange = { type: 'del-obj', id: op.entity }
        changes.push(op.page ? { ...change, pageId: op.page } : change)
        break
      }

      case 'set': {
        // Absorb the whole run of sets on this entity into one assign.
        const value: Record<string, unknown> = {}
        let j = i
        while (j < ops.length) {
          const next = ops[j]
          if (next.t !== 'set' || next.entity !== op.entity || next.arm !== undefined) break
          value[next.field] = next.val
          j += 1
        }
        i = j - 1
        const change: ModObjChange = {
          type: 'mod-obj',
          id: op.entity,
          operations: [{ type: 'assign', value }],
        }
        changes.push(op.page ? { ...change, pageId: op.page } : change)
        break
      }

      case 'mov': {
        const run: typeof op[] = []
        let j = i
        while (j < ops.length) {
          const next = ops[j]
          if (next.t !== 'mov' || next.parent !== op.parent || next.via !== op.via) break
          run.push(next)
          j += 1
        }
        i = j - 1
        const shapes = [...run]
          .sort((a, b) => (indexOf(a.pos) ?? 0) - (indexOf(b.pos) ?? 0))
          .map((m) => m.entity)
        const change: MovObjectsChange | ReorderChildrenChange =
          op.via === 'mov-objects'
            ? { type: 'mov-objects', parentId: op.parent, shapes, index: indexOf(op.pos) }
            : { type: 'reorder-children', parentId: op.parent, shapes }
        changes.push(op.page ? { ...change, pageId: op.page } : change)
        break
      }
    }
  }

  return { changes, docMetaChanges }
}
