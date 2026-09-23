/**
 * Aspects — data keyed by node id outside the node (behaviour, timelines), told
 * about node lifecycle in the SAME commit frame as the change that caused it.
 *
 * An aspect turns a pending delete or copy into more changes; `commitChanges`
 * runs them as one effect before apply, against the document as it stands,
 * and skips them on replay.
 */
import type { NodeId } from '../doc'
import type { Effect, LocalChange } from '../doc'

export interface DeletedNodes {
  /** Every node id going away: the deleted nodes and their descendants. */
  ids: ReadonlySet<NodeId>
}

export interface CopiedNodes {
  /** source id → new id, for every node in the copied subtrees. */
  ids: ReadonlyMap<NodeId, NodeId>
}

export interface Aspect {
  key: string
  onDeleted?(ctx: DeletedNodes): readonly LocalChange[] | null
  onCopied?(ctx: CopiedNodes): readonly LocalChange[] | null
}

const aspects: Aspect[] = []

/** Register an aspect. Returns a disposer. Registration order is the order hooks run. */
export function registerAspect(aspect: Aspect): () => void {
  aspects.push(aspect)
  return () => {
    const i = aspects.indexOf(aspect)
    if (i >= 0) aspects.splice(i, 1)
  }
}

export function listAspects(): readonly Aspect[] {
  return aspects
}

/** Test helper. */
export function resetAspects(): void {
  aspects.length = 0
}

/** The effect that runs every aspect over a pending commit. */
export const aspectsEffect: Effect = (changes, ctx) => {
  if (aspects.length === 0) return []
  const ids = new Set<NodeId>()
  for (const c of changes) if (c.op === 'del' && c.kind === 'node') ids.add(c.id)
  const copied = ctx.copies.filter((m) => m.size > 0)
  if (ids.size === 0 && copied.length === 0) return []
  const out: LocalChange[] = []
  for (const a of aspects) {
    if (ids.size > 0) {
      const fx = a.onDeleted?.({ ids })
      if (fx) out.push(...fx)
    }
    for (const m of copied) {
      const fx = a.onCopied?.({ ids: m })
      if (fx) out.push(...fx)
    }
  }
  return out
}
