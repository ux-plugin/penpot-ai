/**
 * The version store on its own — no commit pipeline, no scopes.
 *
 * What these pin is the behaviour the focus-mode boundary now depends on:
 * captures that changed nothing leave no trace, position is found by content
 * rather than a stored pointer, and going back then editing forks the chain
 * instead of truncating it.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useVersionStore } from '../../../../src/lib/history/versions/version-store'

const S = 'shader-material:rect'
const store = () => useVersionStore.getState()

beforeEach(() => {
  useVersionStore.getState().clear()
})

describe('version store', () => {
  it('captures a chain, each version pointing at the one before', () => {
    const v0 = store().capture(S, { src: 'a' }, { at: 1 })!
    const v1 = store().capture(S, { src: 'b' }, { at: 2 })!

    expect(v0.prev).toBeUndefined()
    expect(v1.prev).toBe(v0.id)
    expect(store().chain(S).map((v) => v.id)).toEqual([v0.id, v1.id])
    expect(store().head(S)?.id).toBe(v1.id)
  })

  it('ignores a capture identical to what it was built on', () => {
    const v0 = store().capture(S, { src: 'a' }, { at: 1 })!
    // Entering and leaving a stage without touching anything.
    expect(store().capture(S, { src: 'a' }, { at: 2 })).toBeUndefined()
    expect(store().chain(S)).toHaveLength(1)
    expect(store().head(S)?.id).toBe(v0.id)
  })

  it('digests by value, not key order', () => {
    store().capture(S, { a: 1, b: 2 }, { at: 1 })
    expect(store().capture(S, { b: 2, a: 1 }, { at: 2 })).toBeUndefined()
  })

  it('treats a distinct payload as a new version even when it repeats an old one', () => {
    const v0 = store().capture(S, { src: 'a' }, { at: 1 })!
    const v1 = store().capture(S, { src: 'b' }, { at: 2 })!
    // Back to an earlier value: not a no-op, because it differs from the head.
    const v2 = store().capture(S, { src: 'a' }, { at: 3 })!

    expect(v2.prev).toBe(v1.id)
    expect(v2.id).not.toBe(v0.id)
    expect(store().chain(S)).toHaveLength(3)
  })

  it('locates the current state by content, and misses when nothing matches', () => {
    store().capture(S, { src: 'a' }, { at: 1 })
    const v1 = store().capture(S, { src: 'b' }, { at: 2 })!

    expect(store().locate(S, { src: 'b' })?.id).toBe(v1.id)
    // Changed by something outside the stage — a token sync, a canvas undo.
    expect(store().locate(S, { src: 'z' })).toBeUndefined()
  })

  it('steps back and forward through the chain', () => {
    const v0 = store().capture(S, { src: 'a' }, { at: 1 })!
    const v1 = store().capture(S, { src: 'b' }, { at: 2 })!

    expect(store().prevOf(v1)?.id).toBe(v0.id)
    expect(store().prevOf(v0)).toBeUndefined()
    expect(store().nextOf(v0)?.id).toBe(v1.id)
    expect(store().nextOf(v1)).toBeUndefined()
  })

  it('forks rather than truncates when editing from an older version', () => {
    const v0 = store().capture(S, { src: 'a' }, { at: 1 })!
    const v1 = store().capture(S, { src: 'b' }, { at: 2 })!
    const v2 = store().capture(S, { src: 'c' }, { at: 3 })!

    // Back to v0, then a new edit built on it.
    const v3 = store().capture(S, { src: 'd' }, { at: 4, from: v0.id })!

    expect(v3.prev).toBe(v0.id)
    // The displaced branch is still there, still linked.
    expect(store().get(S, v1.id)?.prev).toBe(v0.id)
    expect(store().get(S, v2.id)?.prev).toBe(v1.id)
    // Forward from v0 now means the newest fork.
    expect(store().nextOf(v0)?.id).toBe(v3.id)
  })

  it('keeps subjects apart', () => {
    store().capture(S, { src: 'a' }, { at: 1 })
    store().capture('shader-material:other', { src: 'z' }, { at: 2 })

    expect(store().chain(S)).toHaveLength(1)
    expect(store().chain('shader-material:other')).toHaveLength(1)
    expect(store().head('shader-material:other')?.payload).toEqual({ src: 'z' })
  })

  it('caps a subject at the retention limit, dropping the oldest', () => {
    for (let i = 0; i < 60; i += 1) store().capture(S, { src: `v${i}` }, { at: i })

    const chain = store().chain(S)
    expect(chain).toHaveLength(50)
    expect(chain[chain.length - 1].payload).toEqual({ src: 'v59' })
    // The oldest survivor's parent aged out; a walk back stops there.
    expect(store().prevOf(chain[0])).toBeUndefined()
  })

  it('forgets a subject on request but never on its own', () => {
    store().capture(S, { src: 'a' }, { at: 1 })
    store().forget(S)
    expect(store().chain(S)).toHaveLength(0)
  })
})
