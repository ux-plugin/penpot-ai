/**
 * Journal store tests — Phase 1 slice 2 of `docs/history-redesign-plan.md`.
 *
 * Two groups. The first pins what is *new*: monotonic sequencing, `parentSeq`
 * recording what the committer saw, gap queries, scope stamping, and the
 * append-only invariant. The second re-states the transaction semantics the
 * existing `history-store` tests already pin, because that machinery is being
 * carried across rather than redesigned — if these diverge from the originals,
 * the swap in slice 4 would change behaviour silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op } from '../../../../src/lib/history/journal/op'
import {
  CANVAS_SCOPE,
  LOCAL_ACTOR,
  useJournalStore,
  markJournalInteraction,
} from '../../../../src/lib/history/journal/journal-store'

/** A minimal distinguishable op. */
function op(entity: string, val: unknown = 1): Op {
  return { t: 'set', entity, field: 'fill', val, was: 0 }
}

const store = () => useJournalStore.getState()
const seqs = () => store().txns.map((t) => t.seq)
const entities = () => store().txns.flatMap((t) => t.ops.map((o) => o.entity))

beforeEach(() => {
  store().clear()
})

describe('journal — the log', () => {
  it('assigns seq monotonically and records the observed head as parentSeq', () => {
    const a = store().append({ ops: [op('a')] })
    const b = store().append({ ops: [op('b')] })
    expect([a?.seq, b?.seq]).toEqual([1, 2])
    expect([a?.parentSeq, b?.parentSeq]).toEqual([0, 1])
  })

  it('ignores an empty op list', () => {
    expect(store().append({ ops: [] })).toBeUndefined()
    expect(store().txns).toHaveLength(0)
  })

  it('stamps the local actor and the canvas scope by default', () => {
    const t = store().append({ ops: [op('a')] })
    expect(t?.actor).toBe(LOCAL_ACTOR)
    expect(t?.scope).toBe(CANVAS_SCOPE)
  })

  it('since() returns exactly the gap after a seq', () => {
    store().append({ ops: [op('a')] })
    const mid = store().append({ ops: [op('b')] })
    store().append({ ops: [op('c')] })
    expect(store().since(mid!.seq).map((t) => t.ops[0].entity)).toEqual(['c'])
    expect(store().since(0)).toHaveLength(3)
    expect(store().since(store().head())).toHaveLength(0)
  })

  it('never rewrites an existing entry', () => {
    const first = store().append({ ops: [op('a')] })
    const snapshot = structuredClone(first)
    store().append({ ops: [op('b')] })
    store().append({ ops: [op('c')], undoes: first!.seq })
    expect(store().at(first!.seq)).toEqual(snapshot)
  })

  it('carries the undoes back-pointer, so redo needs no second stack', () => {
    const target = store().append({ ops: [op('a')] })
    const undo = store().append({ ops: [op('a', 0)], undoes: target!.seq })
    expect(undo?.undoes).toBe(target!.seq)
    expect(store().at(undo!.undoes!)).toEqual(target)
  })

  it('evicting old entries does not reuse a seq', () => {
    // Cap is 500; push past it and confirm seq keeps climbing.
    for (let i = 0; i < 520; i += 1) store().append({ ops: [op(`e${i}`)] })
    expect(store().txns).toHaveLength(500)
    expect(store().head()).toBe(520)
    expect(seqs()[0]).toBe(21)
  })
})

describe('journal — scopes', () => {
  it('stamps the innermost pushed scope, and restores on pop', () => {
    store().append({ ops: [op('a')] })
    store().pushScope('path-edit:p1')
    store().append({ ops: [op('b')] })
    store().pushScope('shader:s1')
    store().append({ ops: [op('c')] })
    store().popScope()
    store().append({ ops: [op('d')] })
    store().popScope()
    store().append({ ops: [op('e')] })
    expect(store().txns.map((t) => t.scope)).toEqual([
      CANVAS_SCOPE,
      'path-edit:p1',
      'shader:s1',
      'path-edit:p1',
      CANVAS_SCOPE,
    ])
  })

  it('an in-flight gesture lands before the scope changes under it', () => {
    store().begin('drag', 0)
    store().append({ ops: [op('a')] })
    store().pushScope('shader:s1')
    // The gesture belongs to the canvas, where it started.
    expect(store().txns).toHaveLength(1)
    expect(store().txns[0].scope).toBe(CANVAS_SCOPE)
  })
})

describe('journal — coalescing transactions', () => {
  it('merges appends into one entry, ops in forward order', () => {
    store().begin('t', 0)
    store().append({ ops: [op('a')] })
    store().append({ ops: [op('b')] })
    expect(store().txns).toHaveLength(0)
    store().commit('t')
    expect(store().txns).toHaveLength(1)
    expect(entities()).toEqual(['a', 'b'])
  })

  it('is refcounted — the last holder lands the entry', () => {
    store().begin('outer', 0)
    store().begin('inner', 0)
    store().append({ ops: [op('a')] })
    store().commit('inner')
    expect(store().txns).toHaveLength(0)
    store().commit('outer')
    expect(store().txns).toHaveLength(1)
  })

  it('commit by an unknown holder is a no-op', () => {
    store().begin('t', 0)
    store().append({ ops: [op('a')] })
    store().commit('nobody')
    expect(store().txns).toHaveLength(0)
    expect(store().holders.has('t')).toBe(true)
  })

  it('flush lands an in-flight gesture; discard drops it', () => {
    store().begin('t', 0)
    store().append({ ops: [op('a')] })
    store().flush()
    expect(store().txns).toHaveLength(1)

    store().begin('t2', 0)
    store().append({ ops: [op('b')] })
    store().discard()
    expect(store().txns).toHaveLength(1)
    expect(store().pending).toBeNull()
  })

  it('an empty transaction records nothing', () => {
    store().begin('t', 0)
    store().commit('t')
    expect(store().txns).toHaveLength(0)
  })

  describe('watchdog', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('force-commits a leaked transaction', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      store().begin('leaked', 1000)
      store().append({ ops: [op('a')] })
      expect(store().txns).toHaveLength(0)
      vi.advanceTimersByTime(1000)
      expect(store().txns).toHaveLength(1)
    })

    it('markJournalInteraction re-arms, coalescing a burst into one entry', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      markJournalInteraction('scrub', 350)
      store().append({ ops: [op('a')] })
      vi.advanceTimersByTime(200)
      markJournalInteraction('scrub', 350)
      store().append({ ops: [op('b')] })
      vi.advanceTimersByTime(200)
      // Still inside the re-armed window.
      expect(store().txns).toHaveLength(0)
      vi.advanceTimersByTime(350)
      expect(store().txns).toHaveLength(1)
      expect(entities()).toEqual(['a', 'b'])
    })
  })
})
