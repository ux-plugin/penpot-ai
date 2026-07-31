/**
 * Per-subject version history — state, where the journal keeps changes.
 *
 * A focus mode's undo is bounded to the visit that's open (see `scope.ts`), so
 * reaching an *earlier* visit is not something Cmd+Z does. This is what does it:
 * every visit leaves a snapshot of its subject, and the shape's history panel
 * lets you go back to one.
 *
 * Two properties are worth stating because everything else follows from them.
 *
 * **Snapshots, not inverses.** A version is the subject's state, so restoring is
 * absolute and idempotent — there is no rebasing, no liveness to derive, and no
 * way for two representations to disagree about what stands. That disagreement
 * is precisely what produced the patches this replaces. It also suits the
 * subjects we have: a shader is a string plus uniforms and a 3D scene is one
 * opaque blob, both of which the op-level encoding stored twice per edit.
 *
 * **Nothing about this reaches the document format.** Versions live here, keyed
 * by subject id, and a node never learns they exist. So a shape carries no new
 * field, nothing is exported, and there is no encoding decision to make before
 * Phase 2 persists it.
 *
 * Restoring is deliberately *not* a special write path — the caller applies the
 * payload through the ordinary commit pipeline (slice 3), which means a restore
 * is an ordinary canvas step that can itself be undone, and component `touched`
 * marking, token bindings and motion sync all behave exactly as for a hand edit.
 */

import { create } from 'zustand'

/** Which thing has a history: the scope tag, e.g. `shader-material:<shapeId>`. */
export type SubjectId = string

export type VersionId = string

export interface Version {
  id: VersionId
  subject: SubjectId
  /**
   * The version this one was made from, or undefined for a subject's first.
   *
   * Editing after going back to an older version forks the chain rather than
   * truncating it: the abandoned versions keep their `prev` and stay in the
   * table, reachable from the panel even though no keypress leads to them.
   */
  prev: VersionId | undefined
  /** Wall-clock ms. Passed in so tests are deterministic. */
  at: number
  /** What the panel shows, e.g. "shader edit". */
  label?: string
  /** The subject's own fields — never the whole document. */
  payload: Readonly<Record<string, unknown>>
  /** Content digest of `payload`, used to skip captures that changed nothing. */
  digest: string
}

/**
 * Retained versions per subject. Older ones are dropped from the front, which
 * can orphan a `prev` pointer — walks stop there, which is the correct answer
 * once the target is gone.
 */
const MAX_PER_SUBJECT = 50

/** Subjects retained before the least recently captured is dropped whole. */
const MAX_SUBJECTS = 200

/**
 * Stable JSON: object keys sorted at every level, so two payloads that differ
 * only in insertion order digest identically. Without this, re-entering a stage
 * would appear to change the subject whenever a field happened to be rebuilt in
 * a different order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * 64-bit digest as two independent FNV-1a passes over the same string, differing
 * in offset basis. One 32-bit pass collides often enough to worry about across a
 * few thousand versions, and a collision here silently discards a capture; two
 * make that vanishingly unlikely without retaining the serialized form, which
 * for a 3D scene would double the memory the payload already costs.
 */
function digestOf(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

interface VersionState {
  /** Per subject, in creation order. */
  bySubject: Map<SubjectId, Version[]>
  /** Monotonic, so ids stay unique even when two payloads digest the same. */
  nextOrdinal: number

  capture: (
    subject: SubjectId,
    payload: Record<string, unknown>,
    opts?: { at?: number; label?: string; from?: VersionId },
  ) => Version | undefined
  chain: (subject: SubjectId) => readonly Version[]
  head: (subject: SubjectId) => Version | undefined
  get: (subject: SubjectId, id: VersionId) => Version | undefined
  /** The version a "go back" step lands on. */
  prevOf: (v: Version) => Version | undefined
  /** The version a "go forward" step lands on: the newest fork from `v`. */
  nextOf: (v: Version) => Version | undefined
  /** Where the given state sits in the chain, by content rather than a pointer. */
  locate: (subject: SubjectId, payload: Record<string, unknown>) => Version | undefined
  forget: (subject: SubjectId) => void
  clear: () => void
}

export const useVersionStore = create<VersionState>((set, get) => ({
  bySubject: new Map(),
  nextOrdinal: 1,

  capture(subject, payload, opts) {
    const state = get()
    const list = state.bySubject.get(subject) ?? []
    const digest = digestOf(stableStringify(payload))

    // `from` names the version being built on when the caller knows it — which
    // is how a fork is recorded after going back. Otherwise it is the head.
    const parent = opts?.from !== undefined ? list.find((v) => v.id === opts.from) : list.at(-1)

    // A capture identical to what it was made from is not a version. Entering
    // and leaving a stage without touching anything must leave no trace.
    if (parent?.digest === digest) return undefined

    const version: Version = {
      id: `${subject}#${state.nextOrdinal}`,
      subject,
      prev: parent?.id,
      at: opts?.at ?? Date.now(),
      label: opts?.label,
      payload,
      digest,
    }

    const next = new Map(state.bySubject)
    next.set(subject, [...list, version].slice(-MAX_PER_SUBJECT))

    // Least-recently-captured subject goes first. Insertion order in a Map is
    // stable, and re-setting a key does not move it, so a subject is deleted and
    // re-added above to keep the order meaningful.
    if (next.size > MAX_SUBJECTS) {
      const oldest = next.keys().next().value
      if (oldest !== undefined && oldest !== subject) next.delete(oldest)
    }

    set({ bySubject: next, nextOrdinal: state.nextOrdinal + 1 })
    return version
  },

  chain: (subject) => get().bySubject.get(subject) ?? [],
  head: (subject) => get().bySubject.get(subject)?.at(-1),
  get: (subject, id) => get().bySubject.get(subject)?.find((v) => v.id === id),

  prevOf: (v) => (v.prev === undefined ? undefined : get().get(v.subject, v.prev)),

  // Newest fork wins, which is what makes a branched chain behave like ordinary
  // linear redo: a new edit made at an older version becomes the way forward,
  // and the branch it displaced stays in the table for the panel to offer.
  nextOf: (v) => {
    const list = get().bySubject.get(v.subject) ?? []
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].prev === v.id) return list[i]
    return undefined
  },

  // Position is derived from content, so nothing has to be kept in sync. A miss
  // means the subject was changed by something other than its own stage — a
  // token propagation, a component sync, an undo of the canvas step — and the
  // caller's answer is to capture the current state rather than guess.
  locate(subject, payload) {
    const digest = digestOf(stableStringify(payload))
    const list = get().bySubject.get(subject) ?? []
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].digest === digest) return list[i]
    return undefined
  },

  forget(subject) {
    const next = new Map(get().bySubject)
    next.delete(subject)
    set({ bySubject: next })
  },

  clear: () => set({ bySubject: new Map(), nextOrdinal: 1 }),
}))

/**
 * Deliberately absent: anything that drops a subject when its shape is deleted.
 * Deletion is itself undoable, so collecting on delete would destroy exactly the
 * history the next Cmd+Z needs. A restored shape keeps its id, so its chain
 * reattaches with no cooperation; unreachable subjects age out through
 * {@link MAX_SUBJECTS} instead.
 */
export const VERSION_RETENTION = { MAX_PER_SUBJECT, MAX_SUBJECTS } as const
