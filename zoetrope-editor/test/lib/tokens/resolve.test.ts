/**
 * Token resolver (P2.2). Exercises the real style-dictionary + sd-transforms
 * pipeline: literal parsing per type, alias resolution, math, composite
 * typography, missing-reference + cycle errors, and mode (active-set) override.
 */

import { describe, expect, it } from 'vitest'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  type TokensLib,
  type Token,
} from '../../../src/lib/tokens/types'
import { resolveTokenMap, resolveTokens } from '../../../src/lib/tokens/resolve'

function mapOf(...tokens: Token[]): Map<string, Token> {
  return new Map(tokens.map((t) => [t.name, t]))
}

describe('literal values', () => {
  it('color resolves to a css hex string', async () => {
    const res = await resolveTokenMap(
      mapOf(createToken({ name: 'color.red', type: 'color', value: '#FF0000' })),
    )
    const t = res.get('color.red')!
    expect(t.errors).toBeUndefined()
    expect(String(t.resolvedValue).toLowerCase()).toBe('#ff0000')
  })

  it('dimension resolves to a number (px stripped)', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'space.s', type: 'dimension', value: '16' }),
        createToken({ name: 'space.px', type: 'dimension', value: '12px' }),
      ),
    )
    expect(res.get('space.s')!.resolvedValue).toBe(16)
    expect(res.get('space.px')!.resolvedValue).toBe(12)
  })

  it('opacity resolves to a 0..1 number (percent normalised)', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'o.half', type: 'opacity', value: '0.5' }),
        createToken({ name: 'o.pct', type: 'opacity', value: '50%' }),
      ),
    )
    expect(res.get('o.half')!.resolvedValue).toBe(0.5)
    expect(res.get('o.pct')!.resolvedValue).toBe(0.5)
  })
})

describe('aliases + math', () => {
  it('resolves a {alias} to the referenced value', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'color.base', type: 'color', value: '#00FF00' }),
        createToken({ name: 'color.fg', type: 'color', value: '{color.base}' }),
      ),
    )
    expect(res.get('color.fg')!.errors).toBeUndefined()
    expect(res.get('color.fg')!.resolvedValue).toBe(res.get('color.base')!.resolvedValue)
  })

  it('resolves a chained alias', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'a', type: 'dimension', value: '8' }),
        createToken({ name: 'b', type: 'dimension', value: '{a}' }),
        createToken({ name: 'c', type: 'dimension', value: '{b}' }),
      ),
    )
    expect(res.get('c')!.resolvedValue).toBe(8)
  })

  it('evaluates math expressions over references', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'spacing.base', type: 'dimension', value: '4' }),
        createToken({ name: 'spacing.double', type: 'dimension', value: '{spacing.base} * 2' }),
      ),
    )
    expect(res.get('spacing.double')!.resolvedValue).toBe(8)
  })
})

describe('composite typography', () => {
  it('stays a map and resolves nested references', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'size.lg', type: 'dimension', value: '24' }),
        createToken({
          name: 'type.heading',
          type: 'typography',
          value: { fontFamily: 'Inter', fontSize: '{size.lg}', fontWeight: '700' },
        }),
      ),
    )
    const t = res.get('type.heading')!
    expect(t.errors).toBeUndefined()
    expect(typeof t.resolvedValue).toBe('object')
    const v = t.resolvedValue as Record<string, string>
    expect(v.fontFamily).toBe('Inter')
    expect(v.fontWeight).toBe('700')
    // Nested ref resolved (24, possibly "24px"); assert it carries the number 24.
    expect(v.fontSize).toMatch(/24/)
  })
})

describe('errors', () => {
  it('flags a missing reference', async () => {
    const res = await resolveTokenMap(
      mapOf(createToken({ name: 'x', type: 'color', value: '{does.not.exist}' })),
    )
    const t = res.get('x')!
    expect(t.resolvedValue).toBeNull()
    expect(t.errors?.[0]).toMatch(/missing-reference/)
  })

  it('flags a reference cycle on both tokens', async () => {
    const res = await resolveTokenMap(
      mapOf(
        createToken({ name: 'a', type: 'dimension', value: '{b}' }),
        createToken({ name: 'b', type: 'dimension', value: '{a}' }),
      ),
    )
    expect(res.get('a')!.errors).toContain('cyclic-reference')
    expect(res.get('b')!.errors).toContain('cyclic-reference')
  })
})

describe('modes (active-set override)', () => {
  function lib(activeThemeId: string): TokensLib {
    const base = createTokenSet({
      id: 's-base',
      name: 'base',
      tokens: [
        createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' }),
        createToken({ name: 'color.fg', type: 'color', value: '#000000' }),
      ],
    })
    const dark = createTokenSet({
      id: 's-dark',
      name: 'dark',
      tokens: [createToken({ name: 'color.bg', type: 'color', value: '#111111' })],
    })
    return {
      sets: [base, dark],
      themes: [
        createTokenTheme({ id: 'th-light', name: 'light', group: 'mode', sets: ['base'] }),
        createTokenTheme({ id: 'th-dark', name: 'dark', group: 'mode', sets: ['base', 'dark'] }),
      ],
      activeThemes: [activeThemeId],
    }
  }

  it('light theme resolves bg to white', async () => {
    const res = await resolveTokens(lib('th-light'))
    expect(String(res.get('color.bg')!.resolvedValue).toLowerCase()).toBe('#ffffff')
  })

  it('dark theme overrides bg via the later active set', async () => {
    const res = await resolveTokens(lib('th-dark'))
    expect(String(res.get('color.bg')!.resolvedValue).toLowerCase()).toBe('#111111')
    expect(String(res.get('color.fg')!.resolvedValue).toLowerCase()).toBe('#000000')
  })
})

describe('empty', () => {
  it('an empty lib resolves to an empty map', async () => {
    const res = await resolveTokens({ sets: [], themes: [], activeThemes: [] })
    expect(res.size).toBe(0)
  })
})
