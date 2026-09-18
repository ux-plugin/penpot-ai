/**
 * `rebase()` — map a set of operations through everything that landed after the
 * point they were written against. See `docs/history-redesign-plan.md`.
 *
 * This is the shared dependency of three features, which is why the plan builds
 * it before anything else:
 *
 * - **Undo** rebases a derived inverse over the transactions after its target,
 *   then commits the result forward as an ordinary transaction. Undo is never a
 *   stack pop.
 * - **Sync** rebases unacked local transactions over the server's gap when a
 *   push is rejected — literally git rebase.
 * - **Offline** reconnect is the same operation over a much larger gap.
 *
 * Rebasing cannot always succeed, and pretending otherwise is how selective
 * undo systems go wrong. So this returns a {@link Disposition} per input op
 * rather than a bare op list: `ok` ops are safe to commit, `dropped` ops have
 * become meaningless (the thing they addressed is gone), and `conflict` ops are
 * ambiguous and belong to the lens's `ConflictPolicy` to resolve — refuse,
 * cascade, or apply anyway. Deciding that here would bake one mode's policy
 * into every mode.
 *
 * **Positions are never rewritten.** No index shifting happens anywhere in this
 * file. That is not an omission — it is the property that opaque ordered keys
 * (fractional indexing) buy us, and the "never rewrites a position" test pins
 * it down.
 */

import type { ActorId, Txn } from './journal-store'
import { LOCAL_ACTOR } from './journal-store'
import type { EntityId, Op } from './op'
import { opKey } from './op'

/** The target no longer means anything; committing it would be a no-op at best. */
export type DropReason = 'entity-deleted'

/** The target is ambiguous. The lens's conflict policy decides. */
export type ConflictReason =
  /** Another write to the same `(entity, field)` landed since — our before-value is stale. */
  | 'field-overwritten'
  /** The entity was created again since; re-creating it would duplicate. */
  | 'entity-exists'
  /** The parent this op places the entity under was deleted since. */
  | 'parent-gone'
  /** The entity was moved since, so our recorded origin is stale. */
  | 'moved-since'

export type Disposition =
  | { kind: 'ok'; op: Op }
  | { kind: 'dropped'; op: Op; reason: DropReason }
  | {
      kind: 'conflict'
      op: Op
      reason: ConflictReason
      /**
       * Who wrote the conflicting work in the gap. This is why the gap arrives
       * as transactions rather than bare ops: a conflict against your own later
       * edit is recoverable and expected, while clobbering a collaborator's
       * concurrent write destroys something they can see and you may not know
       * exists. Same mechanics, very different blast radius — so the policy has
       * to be able to tell them apart, and actor identity only survives on the
       * transaction.
       */
      by: ActorId
    }

/** Whether an entity survives the ops in the gap, and whether it was disturbed. */
interface EntityFate {
  /** Last structural op won: true if the entity does not exist at the end of the gap. */
  deleted: boolean
  /** A structural op touched it at all (add or mov). */
  moved: boolean
  /** True once any structural op mentions the entity. */
  seen: boolean
  /** Actor behind the most recent structural op. */
  by: ActorId
}

/**
 * Fold the gap into per-entity fates and the set of `(entity, field)` keys
 * written in it. One pass, so `rebase` is O(gap + ops) rather than quadratic —
 * the gap can be an entire offline session.
 */
function summarize(over: readonly Txn[]): {
  fates: Map<EntityId, EntityFate>
  written: Map<string, ActorId>
} {
  const fates = new Map<EntityId, EntityFate>()
  const written = new Map<string, ActorId>()

  const fateOf = (entity: EntityId, by: ActorId): EntityFate => {
    let f = fates.get(entity)
    if (!f) {
      f = { deleted: false, moved: false, seen: false, by }
      fates.set(entity, f)
    }
    return f
  }

  for (const txn of over) {
    for (const op of txn.ops) {
      if (op.t === 'set') {
        // Last writer of this key is the one a conflict is against.
        written.set(opKey(op), txn.actor)
        continue
      }
      const f = fateOf(op.entity, txn.actor)
      f.seen = true
      // Last structural op wins — an entity deleted then re-added exists again.
      f.deleted = op.t === 'del'
      f.by = txn.actor
      if (op.t === 'mov') f.moved = true
    }
  }

  return { fates, written }
}

/** True when the entity is absent at the end of the gap. */
function isDeleted(fates: Map<EntityId, EntityFate>, entity: EntityId): boolean {
  return fates.get(entity)?.deleted === true
}

/**
 * True when the entity is known to exist at the end of the gap. Note this is
 * *known*, not *assumed*: an entity the gap never mentions returns false,
 * because the gap alone cannot tell us about the base document. Only used where
 * a false negative is safe (see the `add` case).
 */
function existsInGap(fates: Map<EntityId, EntityFate>, entity: EntityId): boolean {
  const f = fates.get(entity)
  return f !== undefined && f.seen && !f.deleted
}

/**
 * Classify each of `ops` against the gap `over`, both in log order.
 *
 * `over` is everything that landed after the point `ops` were written against —
 * for undo, `log.since(target)`; for sync, the server's gap. The result is
 * positionally aligned with `ops`, so a caller can report per-op outcomes
 * without re-deriving them.
 */
export function rebase(ops: readonly Op[], over: readonly Txn[]): Disposition[] {
  if (over.length === 0) return ops.map((op) => ({ kind: 'ok', op }))

  const { fates, written } = summarize(over)
  const blame = (entity: EntityId): ActorId => fates.get(entity)?.by ?? LOCAL_ACTOR

  return ops.map((op): Disposition => {
    switch (op.t) {
      case 'set': {
        // The entity is gone, so restoring one of its fields is meaningless.
        if (isDeleted(fates, op.entity)) return { kind: 'dropped', op, reason: 'entity-deleted' }
        // Someone overwrote this exact field after us. Our `was` is stale, and
        // blindly applying it would resurrect a value the later writer replaced
        // — the precise failure the plan's "do not store inverses" rule is
        // about. Surface it; the lens decides.
        const by = written.get(opKey(op))
        if (by !== undefined) return { kind: 'conflict', op, reason: 'field-overwritten', by }
        return { kind: 'ok', op }
      }

      case 'add': {
        // Re-creating something that already exists again would duplicate it.
        if (existsInGap(fates, op.entity)) {
          return { kind: 'conflict', op, reason: 'entity-exists', by: blame(op.entity) }
        }
        // Restore must clamp to a surviving ancestor rather than resurrect an
        // orphan; that clamping is the policy's job, not ours.
        if (isDeleted(fates, op.parent)) {
          return { kind: 'conflict', op, reason: 'parent-gone', by: blame(op.parent) }
        }
        return { kind: 'ok', op }
      }

      case 'del': {
        // Already gone. Deleting twice is a no-op, not a conflict.
        if (isDeleted(fates, op.entity)) return { kind: 'dropped', op, reason: 'entity-deleted' }
        // Deliberately tolerant of intervening edits: deleting a shape someone
        // else recoloured still means what it said.
        return { kind: 'ok', op }
      }

      case 'mov': {
        if (isDeleted(fates, op.entity)) return { kind: 'dropped', op, reason: 'entity-deleted' }
        if (isDeleted(fates, op.parent)) {
          return { kind: 'conflict', op, reason: 'parent-gone', by: blame(op.parent) }
        }
        // Our `wasParent`/`wasPos` describe a placement that no longer holds.
        if (fates.get(op.entity)?.moved === true) {
          return { kind: 'conflict', op, reason: 'moved-since', by: blame(op.entity) }
        }
        return { kind: 'ok', op }
      }
    }
  })
}

/** The ops safe to commit unconditionally — everything the rebase left `ok`. */
export function rebased(dispositions: readonly Disposition[]): Op[] {
  return dispositions.filter((d) => d.kind === 'ok').map((d) => d.op)
}

/** True when any op needs the lens's conflict policy before it can be committed. */
export function hasConflict(dispositions: readonly Disposition[]): boolean {
  return dispositions.some((d) => d.kind === 'conflict')
}

/**
 * True when a conflict is against work someone else wrote — the case that
 * warrants refusing rather than clobbering. A conflict against your own later
 * edit is visible, yours, and recoverable through your own redo.
 */
export function isForeignConflict(d: Disposition, me: ActorId): boolean {
  return d.kind === 'conflict' && d.by !== me
}

/**
 * Apply a lens's conflict policy, yielding the ops to commit. `dropped` ops are
 * always discarded — they address something that no longer exists, so there is
 * nothing for a policy to decide.
 */
export function resolve(
  dispositions: readonly Disposition[],
  policy: 'refuse' | 'apply',
  me: ActorId,
): { ops: Op[]; refused: Disposition[] } {
  const ops: Op[] = []
  const refused: Disposition[] = []
  for (const d of dispositions) {
    if (d.kind === 'ok') ops.push(d.op)
    else if (d.kind === 'conflict') {
      // `refuse` only holds back FOREIGN conflicts; refusing your own later
      // edit would make undo silently do nothing in ordinary single-user work.
      if (policy === 'refuse' && isForeignConflict(d, me)) refused.push(d)
      else ops.push(d.op)
    }
  }
  return { ops, refused }
}
