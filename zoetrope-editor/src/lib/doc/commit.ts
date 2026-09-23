/**
 * `commitChanges`: the only writer of the document.
 *
 *   expand bulk → effects → apply (cascading deletes) → derived → undo frame → emit
 *
 * Effects (component sync, 3D crop resize) see the document as it stands before
 * apply and return more changes for the same frame. They are skipped on
 * undo/redo replay, whose frames already carry them.
 *
 * Subscribers of `changes-applied` (renderer, hit index, selection, 3D) run
 * after apply, in registration order, and are awaited.
 */
import { applyChange, touchedOf, inversesOf, type Applied } from './apply'
import { expand, type Change, type LocalChange } from './changes'
import { ownedBy, updateDerived } from './derived'
import { meta } from './meta'
import type { Kind } from './schema'
import { tables } from './store'
import { pushFrame } from './undo'
import { processDocMetaChanges, type DocMetaChange } from '../changes/doc-meta-change'

export interface CommitParams {
  changes?: readonly LocalChange[]
  docMeta?: readonly DocMetaChange[]
  /** Until meta is records, its inverse is the caller's. */
  docMetaUndo?: readonly DocMetaChange[]
  label?: string
  /** `false` keeps the commit out of history (transient state). */
  saveUndo?: boolean
  /** Undo/redo replay: no frame, no effects. */
  fromHistory?: boolean
  ignoreRendererSync?: boolean
}

export type Effect = (changes: readonly Change[]) => readonly LocalChange[]

const effects: Effect[] = []

/** Register an effect. Returns a disposer. Registration order is application order. */
export function registerEffect(fx: Effect): () => void {
  effects.push(fx)
  return () => {
    const i = effects.indexOf(fx)
    if (i >= 0) effects.splice(i, 1)
  }
}

export function resetEffects(): void {
  effects.length = 0
}

export interface ChangesAppliedEvent {
  applied: readonly Applied[]
  label?: string
  touched: Record<Kind, Set<string>>
  docMeta: readonly DocMetaChange[]
  fromHistory: boolean
  saveUndo: boolean
  ignoreRendererSync: boolean
}

type Handler = (event: ChangesAppliedEvent) => void | Promise<void>

const handlers: Handler[] = []

export function onChangesApplied(handler: Handler): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i >= 0) handlers.splice(i, 1)
  }
}

export function resetSubscribers(): void {
  handlers.length = 0
}

/** The deletes that `c` takes with it, deepest first, as the document stands now. */
function cascadeOf(c: Change): Change[] {
  if (c.op !== 'del') return []
  return ownedBy(c.kind, c.id).map((o) => ({ op: 'del', kind: o.kind, id: o.id }) as Change)
}

/** `changes` with each delete preceded by what it takes with it, for effects to read before apply. */
function withCascade(changes: readonly Change[]): Change[] {
  if (!changes.some((c) => c.op === 'del')) return changes as Change[]
  return changes.flatMap((c) => [...cascadeOf(c), c])
}

/**
 * Apply in order, keeping derived state current after each change so a
 * delete cascades against the state it meets, not the state before the batch.
 */
function applyWithCascade(changes: readonly Change[]): Applied[] {
  const applied: Applied[] = []
  const one = (c: Change): void => {
    const a = applyChange(tables, c)
    if (!a) return
    applied.push(a)
    updateDerived([a])
  }
  for (const c of changes) {
    for (const owned of cascadeOf(c)) one(owned)
    one(c)
  }
  return applied
}

export async function commitChanges(params: CommitParams): Promise<void> {
  const fromHistory = params.fromHistory ?? false
  const docMeta = params.docMeta ?? []
  let changes = expand(params.changes ?? [])

  if (!fromHistory && effects.length > 0 && changes.length > 0) {
    const extra: Change[] = []
    const seen = withCascade(changes)
    for (const fx of effects) extra.push(...expand(fx(seen)))
    if (extra.length > 0) changes = [...changes, ...extra]
  }

  if (changes.length === 0 && docMeta.length === 0) return

  if (docMeta.length > 0 && meta.peek()) {
    meta.value = processDocMetaChanges(meta.peek()!, docMeta)
  }

  const applied = applyWithCascade(changes)
  if (applied.length === 0 && docMeta.length === 0) return

  const saveUndo = params.saveUndo ?? true
  if (saveUndo && !fromHistory) {
    pushFrame({
      label: params.label,
      inverse: inversesOf(applied),
      redo: applied.map((a) => a.change),
      docMetaUndo: [...(params.docMetaUndo ?? [])],
      docMetaRedo: [...docMeta],
    })
  }

  const event: ChangesAppliedEvent = {
    applied,
    label: params.label,
    touched: touchedOf(applied),
    docMeta,
    fromHistory,
    saveUndo,
    ignoreRendererSync: params.ignoreRendererSync ?? false,
  }
  for (const h of handlers) await h(event)
}
