/**
 * Value-entry rules for scalar tokens: the type hint shown in FRONT of the input
 * ("value type in front of the value") and the per-type numeric bounds a value
 * is tested against ("below / above a certain number").
 *
 * Kept separate from resolution (resolve.ts) — this is authoring-time input
 * validation, not alias/graph resolution. Aliases ("{a.b}") always pass here;
 * their concrete value is range-checked by the resolver once it's known.
 */

import type { SupportedTokenType } from './types'
import { isTokenAlias } from './types'

/** Inclusive numeric bounds a scalar value of this type must satisfy. */
export interface ValueBounds {
  min?: number
  max?: number
}

/**
 * Per-type range a value is tested against on entry. Opacity is a 0–1 fraction;
 * the length types can't be negative. Types without an entry are unbounded.
 */
export const TOKEN_VALUE_BOUNDS: Partial<Record<SupportedTokenType, ValueBounds>> = {
  opacity: { min: 0, max: 1 },
  borderRadius: { min: 0 },
  dimension: { min: 0 },
  sizing: { min: 0 },
  spacing: { min: 0 },
}

/**
 * Short prefix rendered in front of the value input to signal the value's type.
 * A unit/range hint (the designer-tool convention): '#' for hex, '0–1' for the
 * opacity fraction, 'px' for lengths. Empty for composite typography.
 */
export function tokenValuePrefix(type: SupportedTokenType): string {
  switch (type) {
    case 'color':
      return '#'
    case 'opacity':
      return '0–1'
    case 'borderRadius':
    case 'dimension':
    case 'sizing':
    case 'spacing':
      return 'px'
    case 'typography':
      return ''
    default:
      return ''
  }
}

export interface ValueCheck {
  /** True when the value is valid and saveable. */
  ok: boolean
  /** Human message when invalid; '' when ok or merely incomplete. */
  error: string
  /** Empty/partial input — not an error to surface, but not saveable either. */
  incomplete: boolean
}

const OK: ValueCheck = { ok: true, error: '', incomplete: false }
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/
const NUMBER_RE = /^-?\d*\.?\d+$/

/** Trim + format a bound for a message ("≥ 0", "≤ 1"). */
function boundMsg(bounds: ValueBounds, n: number): string | null {
  if (bounds.min != null && n < bounds.min) return `Must be ≥ ${bounds.min}`
  if (bounds.max != null && n > bounds.max) return `Must be ≤ ${bounds.max}`
  return null
}

/**
 * Validate a scalar token value string for its type. Aliases pass unconditionally;
 * an empty string is `incomplete` (blocks save without shouting). Colors must be
 * hex; every other scalar type must be a number inside `TOKEN_VALUE_BOUNDS[type]`.
 * Composite typography has no single-string value, so it always passes here.
 */
export function checkTokenValue(type: SupportedTokenType, raw: string): ValueCheck {
  const s = raw.trim()
  if (s === '') return { ok: false, error: '', incomplete: true }
  if (isTokenAlias(s)) return OK
  if (type === 'typography') return OK

  if (type === 'color') {
    return HEX_RE.test(s)
      ? OK
      : { ok: false, error: 'Enter a hex color (#RGB…#RRGGBBAA) or a {alias}.', incomplete: false }
  }

  if (!NUMBER_RE.test(s)) {
    return { ok: false, error: 'Enter a number or a {alias}.', incomplete: false }
  }
  const n = parseFloat(s)
  const bounds = TOKEN_VALUE_BOUNDS[type]
  const msg = bounds ? boundMsg(bounds, n) : null
  return msg ? { ok: false, error: `${msg} (got ${n}).`, incomplete: false } : OK
}
