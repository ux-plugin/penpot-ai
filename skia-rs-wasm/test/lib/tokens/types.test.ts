/**
 * Token data model (P2.1) — pins the attr↔type table (apply/detach in P2.4 keys
 * off it), the alias helpers, and the active-set flattening / override order
 * (the resolver in P2.2 consumes `collectActiveTokens`).
 */

import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_TOKEN_TYPES,
  TOKEN_TYPE_ATTRS,
  activeSets,
  attrsForTokenType,
  canApplyTokenType,
  collectActiveTokens,
  createToken,
  createTokenSet,
  createTokenTheme,
  duplicateNames,
  effectiveActiveTokens,
  emptyTokensLib,
  isSupportedTokenType,
  isTokenAlias,
  themeTopSet,
  tokenAliasName,
  tokenTypesForAttr,
  type TokensLib,
} from '../../../src/lib/tokens/types'

describe('attr ↔ token-type table', () => {
  it('color applies to fill + strokeColor only', () => {
    expect(attrsForTokenType('color')).toEqual(['fill', 'strokeColor'])
  })

  it('borderRadius applies to the four corners', () => {
    expect(attrsForTokenType('borderRadius')).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('opacity applies to opacity only', () => {
    expect(attrsForTokenType('opacity')).toEqual(['opacity'])
  })

  it('typography is a single composite slot', () => {
    expect(attrsForTokenType('typography')).toEqual(['typography'])
  })

  it('sizing covers width/height + the four layout-item limits', () => {
    expect(new Set(attrsForTokenType('sizing'))).toEqual(
      new Set([
        'width',
        'height',
        'layoutItemMinW',
        'layoutItemMaxW',
        'layoutItemMinH',
        'layoutItemMaxH',
      ]),
    )
  })

  it('spacing covers gaps + padding + margin', () => {
    expect(new Set(attrsForTokenType('spacing'))).toEqual(
      new Set(['rowGap', 'columnGap', 'p1', 'p2', 'p3', 'p4', 'm1', 'm2', 'm3', 'm4']),
    )
  })

  it('dimension is the union of sizing + spacing + borderRadius + axis + strokeWidth', () => {
    const dim = new Set(attrsForTokenType('dimension'))
    // Superset of the narrower length families.
    for (const attr of [...attrsForTokenType('sizing'), ...attrsForTokenType('spacing'), 'r1', 'r4']) {
      expect(dim.has(attr as never)).toBe(true)
    }
    // Plus axis + stroke width.
    expect(dim.has('x')).toBe(true)
    expect(dim.has('y')).toBe(true)
    expect(dim.has('strokeWidth')).toBe(true)
    // But NOT color / opacity / typography slots.
    expect(dim.has('fill' as never)).toBe(false)
    expect(dim.has('opacity' as never)).toBe(false)
    expect(dim.has('typography' as never)).toBe(false)
  })

  it('has no duplicate attrs within any type list', () => {
    for (const type of SUPPORTED_TOKEN_TYPES) {
      const attrs = TOKEN_TYPE_ATTRS[type]
      expect(attrs.length).toBe(new Set(attrs).size)
    }
  })
})

describe('inverse lookup', () => {
  it('r1 can be filled by borderRadius AND dimension', () => {
    expect(new Set(tokenTypesForAttr('r1'))).toEqual(new Set(['borderRadius', 'dimension']))
  })

  it('width can be filled by sizing AND dimension', () => {
    expect(new Set(tokenTypesForAttr('width'))).toEqual(new Set(['sizing', 'dimension']))
  })

  it('fill can only be filled by color', () => {
    expect(tokenTypesForAttr('fill')).toEqual(['color'])
  })

  it('canApplyTokenType agrees with the table', () => {
    expect(canApplyTokenType('color', 'fill')).toBe(true)
    expect(canApplyTokenType('color', 'r1')).toBe(false)
    expect(canApplyTokenType('dimension', 'strokeWidth')).toBe(true)
  })
})

describe('supported-type guard', () => {
  it('accepts v1 types, rejects deferred ones', () => {
    expect(isSupportedTokenType('color')).toBe(true)
    expect(isSupportedTokenType('typography')).toBe(true)
    expect(isSupportedTokenType('shadow')).toBe(false)
    expect(isSupportedTokenType('fontWeights')).toBe(false)
  })
})

describe('alias helpers', () => {
  it('recognises a whole-string brace alias', () => {
    expect(isTokenAlias('{color.blue.500}')).toBe(true)
    expect(tokenAliasName('{color.blue.500}')).toBe('color.blue.500')
  })

  it('treats literals + composite values as non-aliases', () => {
    expect(isTokenAlias('#FF0000')).toBe(false)
    expect(isTokenAlias('16')).toBe(false)
    expect(isTokenAlias({ fontSize: '{x}' })).toBe(false)
    expect(tokenAliasName('#FF0000')).toBeNull()
    expect(tokenAliasName({ fontSize: '16' })).toBeNull()
  })

  it('does not treat math-embedded refs as whole-string aliases', () => {
    // Resolver (P2.2) handles "{a} * 2"; the simple recogniser must not.
    expect(isTokenAlias('{spacing.base} * 2')).toBe(false)
  })
})

describe('active sets + override order', () => {
  function lib(): TokensLib {
    const base = createTokenSet({
      id: 'set-base',
      name: 'base',
      tokens: [
        createToken({ id: 't1', name: 'color.bg', type: 'color', value: '#FFFFFF' }),
        createToken({ id: 't2', name: 'color.fg', type: 'color', value: '#000000' }),
      ],
    })
    const dark = createTokenSet({
      id: 'set-dark',
      name: 'dark',
      tokens: [
        // Overrides color.bg; introduces nothing else.
        createToken({ id: 't3', name: 'color.bg', type: 'color', value: '#111111' }),
      ],
    })
    const inactive = createTokenSet({
      id: 'set-extra',
      name: 'extra',
      tokens: [
        createToken({ id: 't4', name: 'color.accent', type: 'color', value: '#FF0000' }),
      ],
    })
    const lightTheme = createTokenTheme({ id: 'th-light', name: 'light', group: 'mode', sets: ['base'] })
    const darkTheme = createTokenTheme({ id: 'th-dark', name: 'dark', group: 'mode', sets: ['base', 'dark'] })
    return {
      sets: [base, dark, inactive],
      themes: [lightTheme, darkTheme],
      activeThemes: ['th-light'],
    }
  }

  it('light theme → only the base set is active', () => {
    const l = lib()
    expect(activeSets(l).map((s) => s.name)).toEqual(['base'])
    const tokens = collectActiveTokens(l)
    expect(tokens.get('color.bg')?.value).toBe('#FFFFFF')
    expect(tokens.has('color.accent')).toBe(false) // inactive set never contributes
  })

  it('dark theme → dark set overrides base on color.bg, in lib order', () => {
    const l = lib()
    l.activeThemes = ['th-dark']
    expect(activeSets(l).map((s) => s.name)).toEqual(['base', 'dark']) // lib order, not theme order
    const tokens = collectActiveTokens(l)
    expect(tokens.get('color.bg')?.value).toBe('#111111') // later active set wins
    expect(tokens.get('color.fg')?.value).toBe('#000000') // untouched base token survives
  })

  it('no active theme → no active tokens', () => {
    const l = lib()
    l.activeThemes = []
    expect(activeSets(l)).toEqual([])
    expect(collectActiveTokens(l).size).toBe(0)
  })

  // A per-mode edit must land in the set that WINS for that theme, else the new
  // value is written but silently shadowed by a later set.
  describe('themeTopSet (where a per-mode edit lands)', () => {
    it('picks the last of the theme’s sets in lib order', () => {
      const l = lib()
      const dark = l.themes.find((t) => t.id === 'th-dark')!
      expect(themeTopSet(l, dark)?.name).toBe('dark')
    })

    it('is the only set when the theme enables one', () => {
      const l = lib()
      const light = l.themes.find((t) => t.id === 'th-light')!
      expect(themeTopSet(l, light)?.name).toBe('base')
    })

    it('follows lib order, not the order listed on the theme', () => {
      const l = lib()
      const reversed = createTokenTheme({ id: 'th-r', name: 'r', sets: ['dark', 'base'] })
      expect(themeTopSet(l, reversed)?.name).toBe('dark')
    })

    it('agrees with resolution — writing to the top set wins', () => {
      const l = lib()
      l.activeThemes = ['th-dark']
      const dark = l.themes.find((t) => t.id === 'th-dark')!
      const top = themeTopSet(l, dark)!
      // color.bg resolves to the dark set's token, which lives in the top set.
      expect(collectActiveTokens(l).get('color.bg')?.value).toBe('#111111')
      expect(top.tokens.some((t) => t.name === 'color.bg')).toBe(true)
    })

    it('is undefined for a theme with no sets, or only unknown ones', () => {
      const l = lib()
      expect(themeTopSet(l, createTokenTheme({ name: 'empty', sets: [] }))).toBeUndefined()
      expect(themeTopSet(l, createTokenTheme({ name: 'ghost', sets: ['nope'] }))).toBeUndefined()
    })
  })
})

describe('factories', () => {
  it('createToken fills id + modifiedAt when omitted', () => {
    const t = createToken({ name: 'color.x', type: 'color', value: '#fff' })
    expect(t.id).toBeTruthy()
    expect(t.modifiedAt).toBeTruthy()
  })

  it('emptyTokensLib is a valid empty lib', () => {
    expect(emptyTokensLib()).toEqual({ sets: [], themes: [], activeThemes: [] })
  })
})

describe('duplicate names within a set', () => {
  it('first occurrence wins for resolution; duplicateNames flags the name', () => {
    const set = createTokenSet({
      name: 'core',
      tokens: [
        createToken({ id: 'd1', name: 'color.bg', type: 'color', value: '#FFFFFF' }),
        createToken({ id: 'd2', name: 'color.bg', type: 'color', value: '#000000' }),
      ],
    })
    const lib: TokensLib = { sets: [set], themes: [], activeThemes: [] }
    expect(effectiveActiveTokens(lib).get('color.bg')?.value).toBe('#FFFFFF')
    expect([...duplicateNames(set)]).toEqual(['color.bg'])
  })
})
