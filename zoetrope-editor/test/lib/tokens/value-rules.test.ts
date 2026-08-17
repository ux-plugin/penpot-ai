/**
 * Value-entry rules (P2.7 authoring): the type prefix shown in front of a value
 * input and the per-type range test a scalar value must pass before it saves.
 */

import { describe, expect, it } from 'vitest'
import {
  TOKEN_VALUE_BOUNDS,
  checkTokenValue,
  tokenValuePrefix,
} from '../../../src/lib/tokens/token-value-rules'

describe('tokenValuePrefix', () => {
  it('signals the value type in front of the input', () => {
    expect(tokenValuePrefix('color')).toBe('#')
    expect(tokenValuePrefix('opacity')).toBe('0–1')
    expect(tokenValuePrefix('borderRadius')).toBe('px')
    expect(tokenValuePrefix('dimension')).toBe('px')
    expect(tokenValuePrefix('typography')).toBe('')
  })
})

describe('checkTokenValue — aliases & empties', () => {
  it('an empty string is incomplete, not an error', () => {
    const r = checkTokenValue('opacity', '   ')
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBe(true)
    expect(r.error).toBe('')
  })

  it('a whole-string alias always passes (resolved later)', () => {
    for (const t of ['color', 'opacity', 'borderRadius'] as const) {
      expect(checkTokenValue(t, '{some.ref}').ok).toBe(true)
    }
  })

  it('composite typography passes (no single-string value)', () => {
    expect(checkTokenValue('typography', 'anything').ok).toBe(true)
  })
})

describe('checkTokenValue — color', () => {
  it('accepts hex, rejects non-hex', () => {
    expect(checkTokenValue('color', '#3B82F6').ok).toBe(true)
    expect(checkTokenValue('color', '#abc').ok).toBe(true)
    const bad = checkTokenValue('color', 'blue')
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/hex/i)
  })
})

describe('checkTokenValue — numeric range (below / above)', () => {
  it('opacity must sit within 0..1', () => {
    expect(checkTokenValue('opacity', '0').ok).toBe(true)
    expect(checkTokenValue('opacity', '0.5').ok).toBe(true)
    expect(checkTokenValue('opacity', '1').ok).toBe(true)

    const over = checkTokenValue('opacity', '1.5')
    expect(over.ok).toBe(false)
    expect(over.error).toMatch(/≤ 1/)

    const under = checkTokenValue('opacity', '-0.2')
    expect(under.ok).toBe(false)
    expect(under.error).toMatch(/≥ 0/)
  })

  it('borderRadius cannot be negative', () => {
    expect(checkTokenValue('borderRadius', '8').ok).toBe(true)
    expect(checkTokenValue('borderRadius', '0').ok).toBe(true)
    const neg = checkTokenValue('borderRadius', '-1')
    expect(neg.ok).toBe(false)
    expect(neg.error).toMatch(/≥ 0/)
  })

  it('rejects non-numeric scalar input', () => {
    const r = checkTokenValue('borderRadius', '12px')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/number/i)
  })

  it('bounds table matches the enforced ranges', () => {
    expect(TOKEN_VALUE_BOUNDS.opacity).toEqual({ min: 0, max: 1 })
    expect(TOKEN_VALUE_BOUNDS.borderRadius).toEqual({ min: 0 })
  })
})
