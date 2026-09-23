import { afterEach, describe, expect, it } from 'vitest'
import { aspectsEffect, registerAspect, resetAspects, type Aspect } from '../../../src/lib/changes/aspects'
import { del, mod, type Change } from '../../../src/lib/doc'

const ctx = { copies: [] as ReadonlyMap<string, string>[] }

describe('aspects', () => {
  afterEach(() => resetAspects())

  it('no aspects → no effects', () => {
    expect(aspectsEffect([del('node', 'a')], ctx)).toEqual([])
  })

  it('hooks see every deleted node id and run in registration order', () => {
    const mk = (key: string): Aspect => ({
      key,
      onDeleted: ({ ids }) => [mod('page', `${key}:${[...ids].sort().join('')}`, {})],
    })
    registerAspect(mk('one'))
    registerAspect(mk('two'))
    const fx = aspectsEffect([del('node', 'a'), del('node', 'b'), mod('node', 'c', {})], ctx) as Change[]
    expect(fx.map((c) => (c.op === 'mod' ? c.id : ''))).toEqual(['one:ab', 'two:ab'])
  })

  it('a hook returning null contributes nothing', () => {
    registerAspect({ key: 'quiet', onDeleted: () => null })
    expect(aspectsEffect([del('node', 'a')], ctx)).toEqual([])
  })

  it('copies reach onCopied', () => {
    let seen: Array<[string, string]> = []
    registerAspect({
      key: 'copy',
      onCopied: ({ ids }) => {
        seen = [...ids.entries()]
        return null
      },
    })
    aspectsEffect([], { copies: [new Map([['a', 'a2']])] })
    expect(seen).toEqual([['a', 'a2']])
  })

  it('a disposer unregisters', () => {
    const dispose = registerAspect({ key: 'x', onDeleted: () => [del('node', 'never')] })
    dispose()
    expect(aspectsEffect([del('node', 'a')], ctx)).toEqual([])
  })
})
