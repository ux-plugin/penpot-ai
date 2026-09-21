/**
 * Aspects — side tables keyed by node id, told about node lifecycle in the
 * SAME commit frame as the change that caused it.
 *
 * Interactions, timelines, bindings and (later) 3D all hold data keyed by node
 * id outside the shape itself. When a node is deleted or copied, that data has
 * to follow: be dropped, or be duplicated under the new id. An aspect
 * registers hooks that turn a pending commit into extra changes, which
 * `commitChanges` appends to the frame — so one undo reverts the node and its
 * aspect data together. Same mechanism as component sync, generalised.
 *
 * Hooks run BEFORE the commit applies, against the document as it stands, and
 * are skipped on history replay (the recorded frame already carries them).
 * Registration is centralised in renderer/store/commit.ts.
 */

import type { Change, DelObjChange } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../worker/types'

export interface AspectEffects {
  redoChanges: Change[]
  undoChanges: Change[]
}

export interface DeletedNodes {
  pageId: string
  /** The page before the deletion applies. */
  page: IndexedPage
  /** Every id going away: the deleted nodes and all their descendants. */
  ids: ReadonlySet<string>
}

export interface CopiedNodes {
  pageId: string
  page: IndexedPage
  /** source id → new id, for every node in the copied subtrees. */
  ids: ReadonlyMap<string, string>
}

export interface Aspect {
  key: string
  onDeleted?(ctx: DeletedNodes): AspectEffects | null
  onCopied?(ctx: CopiedNodes): AspectEffects | null
}

const aspects: Aspect[] = []

/** Register an aspect. Returns a disposer. Order of registration is the order hooks run. */
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

function descendants(objects: Record<string, IndexedShape>, id: string, out: Set<string>): void {
  for (const child of objects[id]?.shapes ?? []) {
    if (out.has(child)) continue
    out.add(child)
    descendants(objects, child, out)
  }
}

/** Group the `del-obj` changes of a commit into per-page deleted-id sets, descendants included. */
export function collectDeleted(
  changes: readonly Change[],
  fallbackPageId: string | null | undefined,
  getPage: (pageId: string) => IndexedPage | undefined,
): DeletedNodes[] {
  const byPage = new Map<string, Set<string>>()
  for (const c of changes) {
    if (c.type !== 'del-obj') continue
    const pageId = (c as DelObjChange).pageId ?? fallbackPageId
    if (!pageId) continue
    let ids = byPage.get(pageId)
    if (!ids) byPage.set(pageId, (ids = new Set()))
    ids.add(c.id)
  }
  const out: DeletedNodes[] = []
  for (const [pageId, roots] of byPage) {
    const page = getPage(pageId)
    if (!page) continue
    const ids = new Set(roots)
    for (const id of roots) descendants(page.objects, id, ids)
    out.push({ pageId, page, ids })
  }
  return out
}

export interface AspectInput {
  changes: readonly Change[]
  fallbackPageId: string | null | undefined
  getPage: (pageId: string) => IndexedPage | undefined
  /** Copies made by this commit, when the caller knows them (component copies, duplicate). */
  copies?: ReadonlyArray<{ pageId: string; ids: ReadonlyMap<string, string> }>
}

const EMPTY: AspectEffects = { redoChanges: [], undoChanges: [] }

/**
 * Run every aspect over a pending commit. Redo effects are appended after the
 * triggering changes; undo effects are prepended so they revert first.
 */
export function collectAspectEffects(input: AspectInput): AspectEffects {
  if (aspects.length === 0) return EMPTY
  const deleted = collectDeleted(input.changes, input.fallbackPageId, input.getPage)
  const copied: CopiedNodes[] = []
  for (const c of input.copies ?? []) {
    const page = input.getPage(c.pageId)
    if (page && c.ids.size > 0) copied.push({ pageId: c.pageId, page, ids: c.ids })
  }
  if (deleted.length === 0 && copied.length === 0) return EMPTY

  const redo: Change[] = []
  const undo: Change[] = []
  for (const a of aspects) {
    for (const d of deleted) {
      const fx = a.onDeleted?.(d)
      if (fx) {
        redo.push(...fx.redoChanges)
        undo.unshift(...fx.undoChanges)
      }
    }
    for (const c of copied) {
      const fx = a.onCopied?.(c)
      if (fx) {
        redo.push(...fx.redoChanges)
        undo.unshift(...fx.undoChanges)
      }
    }
  }
  return redo.length === 0 && undo.length === 0 ? EMPTY : { redoChanges: redo, undoChanges: undo }
}
