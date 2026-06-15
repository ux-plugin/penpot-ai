import { describe, expect, it } from 'vitest'
import {
  clampRound,
  formatNumber,
  parseNumericInput,
  roundTo,
  stepMultiplier,
  stepValue,
} from '../../../../src/lib/components/RightSidePanel/numeric-field-logic'

describe('roundTo', () => {
  it('rounds to 2 decimals by default and strips float noise', () => {
    expect(roundTo(0.1 + 0.2)).toBe(0.3)
    expect(roundTo(12.345)).toBe(12.35)
    expect(roundTo(12)).toBe(12)
  })
  it('honors an explicit precision', () => {
    expect(roundTo(1.23456, 3)).toBe(1.235)
    expect(roundTo(1.5, 0)).toBe(2)
  })
})

describe('clampRound', () => {
  it('clamps to min/max then rounds', () => {
    expect(clampRound(150, { min: 0, max: 100 })).toBe(100)
    expect(clampRound(-5, { min: 0, max: 100 })).toBe(0)
    expect(clampRound(42.349, { min: 0, max: 100 })).toBe(42.35)
  })
  it('allows open-ended bounds', () => {
    expect(clampRound(-999, { min: -999, max: 999 })).toBe(-999)
    expect(clampRound(5, {})).toBe(5)
  })
})

describe('parseNumericInput', () => {
  it('returns null for non-committable partials', () => {
    for (const raw of ['', '   ', '-', '.', '-.', 'abc', '#']) {
      expect(parseNumericInput(raw)).toBeNull()
    }
  })
  it('parses numbers, including trailing-dot partials and negatives', () => {
    expect(parseNumericInput('12')).toBe(12)
    expect(parseNumericInput('12.')).toBe(12)
    expect(parseNumericInput('12.5')).toBe(12.5)
    expect(parseNumericInput('-3.25')).toBe(-3.25)
    expect(parseNumericInput('  7 ')).toBe(7)
  })
})

describe('stepMultiplier', () => {
  it('applies Shift=10x, Alt=0.1x, else 1x', () => {
    expect(stepMultiplier()).toBe(1)
    expect(stepMultiplier({ shift: true })).toBe(10)
    expect(stepMultiplier({ alt: true })).toBe(0.1)
    // Shift wins when both are held.
    expect(stepMultiplier({ shift: true, alt: true })).toBe(10)
  })
})

describe('stepValue', () => {
  it('steps up/down by step × multiplier', () => {
    expect(stepValue(10, 1, 1)).toBe(11)
    expect(stepValue(10, 1, -1)).toBe(9)
    expect(stepValue(10, 1, 1, { shift: true })).toBe(20)
    expect(stepValue(10, 0.1, 1, { alt: true })).toBeCloseTo(10.01)
    expect(stepValue(10, 5, -1, { shift: true })).toBe(-40)
  })
})

describe('formatNumber', () => {
  it('shows at most precision decimals with no trailing zeros', () => {
    expect(formatNumber(12.5)).toBe('12.5')
    expect(formatNumber(12.0)).toBe('12')
    expect(formatNumber(12.456)).toBe('12.46')
    expect(formatNumber(0)).toBe('0')
  })
})
