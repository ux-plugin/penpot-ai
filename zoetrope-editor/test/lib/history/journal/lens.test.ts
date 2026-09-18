/**
 * Lens tests — Phase 1 slice 3 of `docs/history-redesign-plan.md`.
 *
 * These work on plain `Txn[]` rather than the store, because `pickUndo` and
 * `pickRedo` are pure queries and the interesting cases are shapes of log that
 * are tedious to reach through the store's API.
 *
 * The property at the end is the one that matters: an undo is itself an
 * undoable transaction, so the liveness rule has to stay coherent through
 * arbitrarily deep undo/redo alternation. A flag written on the row could not
 * do this — undoing an undo would have to rewrite an append-only log.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Txn } from '../../../../src/lib/history/journal/journal-store'
import { CANVAS_SCOPE, LOCAL_ACTOR } from '../../../../src/lib/history/journal/journal-store'
import type { Op } from '../../../../src/lib/history/journal/op'
import {
  canvasLens,
  chainDepth,
  liveness,
  localCtx,
  pickRedo,
  pickUndo,
  scopeLens,
} from '../../../../src/lib/history/journal/lens'

const op = (entity: string): Op => ({ t: 'set', entity, field: 'fill', val: 1, was: 0 })

/** Build a log entry; `seq` is its index in the array plus one. */
function txn(seq: number, over: Partial<Txn> = {}): Txn {
  return {
    seq,
    actor: LOCAL_ACTOR,
    parentSeq: seq - 1,
    scope: CANVAS_SCOPE,
    ops: [op(`e${seq}`)],
    ...over,
  }
}

/** Append the transaction an undo (or redo) of `target` would write. */
function revert(log: Txn[], target: Txn): Txn[] {
  return [...log, txn(log.length + 1, { undoes: target.seq, scope: target.scope })]
}

const ctx = localCtx()

describe('lens — picking a target', () => {
  it('nothing to undo in an empty log', () => {
    expect(pickUndo([], canvasLens, ctx)).toBeUndefined()
    expect(pickRedo([], canvasLens, ctx)).toBeUndefined()
  })

  it('undo targets the newest edit; redo has nothing to reach for yet', () => {
    const log = [txn(1), txn(2)]
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(2)
    expect(pickRedo(log, canvasLens, ctx)).toBeUndefined()
  })

  it('after an undo, the next undo skips past the one already reverted', () => {
    let log = [txn(1), txn(2)]
    log = revert(log, pickUndo(log, canvasLens, ctx)!)
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(1)
  })

  it('redo reaches the undo itself, following the back-pointer', () => {
    let log = [txn(1), txn(2)]
    log = revert(log, pickUndo(log, canvasLens, ctx)!)
    const redoTarget = pickRedo(log, canvasLens, ctx)
    expect(redoTarget?.seq).toBe(3)
    expect(redoTarget?.undoes).toBe(2)
  })

  it('undoing the undo brings the original edit back to life', () => {
    let log = [txn(1), txn(2)]
    log = revert(log, pickUndo(log, canvasLens, ctx)!) // undo 2
    log = revert(log, pickRedo(log, canvasLens, ctx)!) // redo 2
    const live = liveness(log)
    expect(live.get(2)).toBe(true)
    expect(live.get(3)).toBe(false)
    // Nothing left to redo; the newest assertion is the redo itself.
    expect(pickRedo(log, canvasLens, ctx)).toBeUndefined()
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(4)
  })
})

describe('lens — visibility', () => {
  it('canvas does not see focus-scoped work', () => {
    const log = [txn(1), txn(2, { scope: 'shader:s1' })]
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(1)
    expect(pickUndo(log, scopeLens('shader:s1'), ctx)?.seq).toBe(2)
  })

  it('canvas undo steps over interleaved focus work', () => {
    let log = [txn(1), txn(2, { scope: 'shader:s1' }), txn(3)]
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(3)
    log = revert(log, pickUndo(log, canvasLens, ctx)!)
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(1)
  })

  it('another actor\'s work is invisible', () => {
    const log = [txn(1), txn(2, { actor: 'someone-else' })]
    expect(pickUndo(log, canvasLens, ctx)?.seq).toBe(1)
  })

  it('a scope lens ignores a sibling scope', () => {
    const log = [txn(1, { scope: 'shader:s1' }), txn(2, { scope: 'shader:s2' })]
    expect(pickUndo(log, scopeLens('shader:s1'), ctx)?.seq).toBe(1)
  })
})

describe('lens — chain depth', () => {
  it('counts hops back to the original edit', () => {
    let log = [txn(1)]
    log = revert(log, log[0]) // undo
    log = revert(log, log[1]) // redo
    log = revert(log, log[2]) // undo again
    expect(chainDepth(log, log[0])).toBe(0)
    expect(chainDepth(log, log[1])).toBe(1)
    expect(chainDepth(log, log[2])).toBe(2)
    expect(chainDepth(log, log[3])).toBe(3)
  })

  it('stops at a pointer whose target has been evicted', () => {
    const orphan = txn(2, { undoes: 1 })
    expect(chainDepth([orphan], orphan)).toBe(0)
  })
})

describe('lens — deep alternation stays coherent', () => {
  it('N undos exhaust the log, and N redos restore it, in the right order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (n) => {
        let log: Txn[] = Array.from({ length: n }, (_, i) => txn(i + 1))

        const undone: number[] = []
        for (let i = 0; i < n; i += 1) {
          const t = pickUndo(log, canvasLens, ctx)
          expect(t).toBeDefined()
          undone.push(t!.seq)
          log = revert(log, t!)
        }
        // Everything of mine is reverted.
        expect(pickUndo(log, canvasLens, ctx)).toBeUndefined()
        // Undo walked backwards through the edits.
        expect(undone).toEqual(Array.from({ length: n }, (_, i) => n - i))

        for (let i = 0; i < n; i += 1) {
          const t = pickRedo(log, canvasLens, ctx)
          expect(t).toBeDefined()
          log = revert(log, t!)
        }
        expect(pickRedo(log, canvasLens, ctx)).toBeUndefined()

        // Every original edit is live again.
        const live = liveness(log)
        for (let seq = 1; seq <= n; seq += 1) expect(live.get(seq)).toBe(true)
      }),
    )
  })
})
