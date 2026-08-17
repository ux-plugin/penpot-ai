/**
 * Alias graph (editor read-model) — pins the reverse "used by" index and the
 * cycle guard the reference picker relies on.
 */

import { describe, expect, it } from 'vitest'
import {
  buildAliasIndex,
  createsCycle,
  reaches,
  usedByNames,
} from '../../../src/lib/tokens/graph'
import { createToken, createTokenSet, type TokensLib } from '../../../src/lib/tokens/types'

/** Lib with a single set of the given (name → value) tokens. */
function libOf(pairs: [string, string][]): TokensLib {
  const set = createTokenSet({ name: 'core' })
  set.tokens = pairs.map(([name, value]) => createToken({ name, type: 'color', value }))
  return { sets: [set], themes: [], activeThemes: [] }
}

describe('buildAliasIndex', () => {
  it('maps a token to the name it aliases', () => {
    const lib = libOf([
      ['blue.500', '#3B82F6'],
      ['action', '{blue.500}'],
    ])
    const idx = buildAliasIndex(lib)
    expect(idx.targetOf.get('action')).toBe('blue.500')
    expect(idx.targetOf.has('blue.500')).toBe(false)
  })

  it('builds a reverse used-by index (deduped, sorted)', () => {
    const lib = libOf([
      ['blue.500', '#3B82F6'],
      ['action', '{blue.500}'],
      ['link', '{blue.500}'],
    ])
    const idx = buildAliasIndex(lib)
    expect(usedByNames(idx, 'blue.500')).toEqual(['action', 'link'])
    expect(usedByNames(idx, 'action')).toEqual([])
  })

  it('takes the first occurrence of a duplicated name', () => {
    const set = createTokenSet({ name: 'core' })
    set.tokens = [
      createToken({ name: 'a', type: 'color', value: '{first}' }),
      createToken({ name: 'a', type: 'color', value: '{second}' }),
    ]
    const idx = buildAliasIndex({ sets: [set], themes: [], activeThemes: [] })
    expect(idx.targetOf.get('a')).toBe('first')
  })
})

describe('reaches / createsCycle', () => {
  const lib = libOf([
    ['a', '{b}'],
    ['b', '{c}'],
    ['c', '#000000'],
  ])
  const { targetOf } = buildAliasIndex(lib)

  it('follows the alias chain transitively', () => {
    expect(reaches(targetOf, 'a', 'c')).toBe(true)
    expect(reaches(targetOf, 'c', 'a')).toBe(false)
  })

  it('flags a self-reference as a cycle', () => {
    expect(createsCycle(targetOf, 'x', 'x')).toBe(true)
  })

  it('flags a target that reaches back to the token', () => {
    // Pointing c → a would loop (a → b → c → a).
    expect(createsCycle(targetOf, 'c', 'a')).toBe(true)
  })

  it('allows a target that does not loop back', () => {
    expect(createsCycle(targetOf, 'a', 'c')).toBe(false)
  })

  it('terminates on a pre-existing cycle in the data', () => {
    const cyc = buildAliasIndex(libOf([
      ['p', '{q}'],
      ['q', '{p}'],
    ])).targetOf
    expect(reaches(cyc, 'p', 'zzz')).toBe(false)
  })
})
