/**
 * `commitChanges`: the only writer of the document.
 *
 *   expand bulk → cascade deletes → effects → apply → derived → undo frame → emit
 *
 * Effects (component sync, aspects, …) see the document as it stands before
 * apply and return more changes for the same frame. They are skipped on
 * undo/redo replay, whose frames already carry them.
 *
 * Subscribers of `changes-applied` (renderer, hit index, selection, 3D) run
 * after apply, in registration order, and are awaited.
 */
import { applyChange, touchedOf, inversesOf, type Applied } from './apply'
import { expand, type Change, type LocalChange } from './changes'
import { descendants, updateDerived } from './derived'
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
  /** Subtrees this commit duplicates (source id → new id), for effects that follow copies. */
  copies?: ReadonlyArray<ReadonlyMap<string, string>>
}

export interface EffectContext {
  copies: ReadonlyArray<ReadonlyMap<string, string>>
}

export type Effect = (changes: readonly Change[], ctx: EffectContext) => readonly LocalChange[]

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

/**
 * What a delete takes with it as the document stands now: descendants, a
 * page's nodes. Deepest first. Effects read this before apply; the reducer
 * loop recomputes it at apply time, after the changes before it have landed.
 */
function withCascade(changes: readonly Change[]): Change[] {
  let out: Change[] | null = null
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]
    const owned = c.op === 'del' ? descendants(c.id) : []
    if (owned.length === 0) {
      out?.push(c)
      continue
    }
    if (!out) out = changes.slice(0, i)
    for (let j = owned.length - 1; j >= 0; j--) out.push({ op: 'del', kind: 'node', id: owned[j] })
    out.push(c)
  }
  return out ?? (changes as Change[])
}

/** Apply in order, cascading each delete against the state it meets, keeping derived state current. */
function applyWithCascade(changes: readonly Change[]): Applied[] {
  const applied: Applied[] = []
  const one = (c: Change): void => {
    const a = applyChange(tables, c)
    if (!a) return
    applied.push(a)
    updateDerived([a])
  }
  for (const c of changes) {
    if (c.op === 'del') {
      const owned = descendants(c.id)
      for (let j = owned.length - 1; j >= 0; j--) one({ op: 'del', kind: 'node', id: owned[j] })
    }
    one(c)
  }
  return applied
}

export async function commitChanges(params: CommitParams): Promise<void> {
  const fromHistory = params.fromHistory ?? false
  const docMeta = params.docMeta ?? []
  let changes = expand(params.changes ?? [])

  if (!fromHistory && effects.length > 0 && changes.length > 0) {
    const ctx: EffectContext = { copies: params.copies ?? [] }
    const extra: Change[] = []
    const seen = withCascade(changes)
    for (const fx of effects) extra.push(...expand(fx(seen, ctx)))
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
    touched: touchedOf(applied),
    docMeta,
    fromHistory,
    saveUndo,
    ignoreRendererSync: params.ignoreRendererSync ?? false,
  }
  for (const h of handlers) await h(event)
}
