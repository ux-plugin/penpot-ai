/**
 * Design-token data model — the single source of truth behind both "styles"
 * and "variables" (see docs/tokens-styles-port-plan.md).
 *
 * Mirrors Penpot's tokens-lib (common/types/{token,tokens-lib}.cljc):
 *   - A `Token` is { id, name, type, value, description } where `name` is a
 *     dot-separated group path ("color.brand.primary") and `value` is a literal,
 *     an alias "{other.token}", or — for composite typography — a sub-property map.
 *   - Tokens live in named `TokenSet`s. A `TokenTheme` enables a subset of sets;
 *     `activeThemes` selects which themes are live (= Figma "modes").
 *
 * The shape-side contract (`appliedTokens: { attr -> token-name }`) reuses the
 * vendored exporter `TokenProperties` keys verbatim, so the renderer and the
 * eventual round-trip stay consistent. Value/alias *resolution* (the alias graph
 * + active-set merge via style-dictionary) is P2.2; this module is pure data plus
 * the attr↔type table that apply/detach (P2.4) keys off.
 *
 * Type naming follows the DTCG / exporter camelCase convention (`borderRadius`,
 * `fontSizes`, …) rather than Penpot's internal kebab keywords, so it lines up
 * with the exporter's own `TokenType` and with style-dictionary input.
 */

import type { TokenProperties, Uuid } from 'penpot-exporter/types'

export type { TokenProperties, Uuid }

// ── Token types ──────────────────────────────────────────────────────────────

/**
 * Full Penpot token-type universe (DTCG names). Only the v1 subset
 * (`SupportedTokenType`) is wired into the attr table / apply path; the rest are
 * declared for forward-compat so imported tokens of other types still type-check.
 */
export type TokenType =
  | 'color'
  | 'typography' // composite
  | 'dimension'
  | 'spacing'
  | 'sizing'
  | 'borderRadius'
  | 'borderWidth' // Penpot :stroke-width
  | 'opacity'
  | 'number'
  | 'rotation'
  | 'fontFamilies'
  | 'fontSizes'
  | 'fontWeights'
  | 'letterSpacing'
  | 'textCase'
  | 'textDecoration'
  | 'shadow'
  | 'boolean'
  | 'string'
  | 'other'

/** Token types fully supported in v1 (have an attr mapping + an apply path). */
export const SUPPORTED_TOKEN_TYPES = [
  'color',
  'typography',
  'dimension',
  'spacing',
  'sizing',
  'borderRadius',
  'opacity',
] as const

export type SupportedTokenType = (typeof SUPPORTED_TOKEN_TYPES)[number]

export function isSupportedTokenType(type: TokenType): type is SupportedTokenType {
  return (SUPPORTED_TOKEN_TYPES as readonly string[]).includes(type)
}

// ── Token value ──────────────────────────────────────────────────────────────

/**
 * Composite typography value — each sub-property is a literal or an alias.
 * Decomposed into per-span font props on apply (P2.4) / propagation (P2.5).
 */
export interface TypographyTokenValue {
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
  textCase?: string
  textDecoration?: string
}

/**
 * A token's authored value. Scalars (color/dimension/opacity/…) are stored as
 * strings — literal ("#FF0000", "16", "0.5") or alias ("{color.blue.500}").
 * Composite typography uses the sub-property map.
 */
export type TokenValue = string | TypographyTokenValue

// ── Token / set / theme / lib ────────────────────────────────────────────────

export interface Token {
  id: Uuid
  /** Dot-separated group path; the identity used by aliases. */
  name: string
  type: TokenType
  value: TokenValue
  description?: string
  modifiedAt?: string
}

export interface TokenSet {
  id: Uuid
  /** Slash-separated group path (e.g. "core/colors"); identity for themes. */
  name: string
  /**
   * Ordered token list. Duplicate names are allowed; the FIRST occurrence wins
   * for resolution and the rest are flagged as duplicates in the UI.
   */
  tokens: Token[]
}

export interface TokenTheme {
  id: Uuid
  name: string
  /** Theme group (e.g. "mode" → light/dark); "" when ungrouped. */
  group: string
  /** Names of the sets this theme enables. */
  sets: string[]
}

export interface TokensLib {
  /** Ordered; among active sets a later one overrides an earlier on name clash. */
  sets: TokenSet[]
  themes: TokenTheme[]
  /** Ids of the themes currently active (= the live "modes"). */
  activeThemes: Uuid[]
}

/** Shape-side applied-token map: attr → token name. */
export type AppliedTokens = Partial<Record<TokenProperties, string>>

// ── Attr ↔ token-type table ──────────────────────────────────────────────────
//
// Authoritative mapping, ported from Penpot `token-properties`
// (frontend/.../tokens/application.cljs) + the `*-keys` schemas in
// common/types/token.cljc. For each supported token type, the set of shape
// attrs it may be applied to. `dimension` is the broad length type (the union
// of sizing + spacing + border-radius + axis + stroke-width).

const COLOR_ATTRS: TokenProperties[] = ['fill', 'strokeColor']
const BORDER_RADIUS_ATTRS: TokenProperties[] = ['r1', 'r2', 'r3', 'r4']
const SIZING_ATTRS: TokenProperties[] = [
  'width',
  'height',
  'layoutItemMinW',
  'layoutItemMaxW',
  'layoutItemMinH',
  'layoutItemMaxH',
]
const SPACING_ATTRS: TokenProperties[] = [
  'rowGap',
  'columnGap',
  'p1',
  'p2',
  'p3',
  'p4',
  'm1',
  'm2',
  'm3',
  'm4',
]
const AXIS_ATTRS: TokenProperties[] = ['x', 'y']
const STROKE_WIDTH_ATTRS: TokenProperties[] = ['strokeWidth']
const OPACITY_ATTRS: TokenProperties[] = ['opacity']
const TYPOGRAPHY_ATTRS: TokenProperties[] = ['typography']

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}

const DIMENSION_ATTRS: TokenProperties[] = uniq([
  ...SIZING_ATTRS,
  ...SPACING_ATTRS,
  ...BORDER_RADIUS_ATTRS,
  ...AXIS_ATTRS,
  ...STROKE_WIDTH_ATTRS,
])

export const TOKEN_TYPE_ATTRS: Record<SupportedTokenType, TokenProperties[]> = {
  color: COLOR_ATTRS,
  typography: TYPOGRAPHY_ATTRS,
  dimension: DIMENSION_ATTRS,
  spacing: SPACING_ATTRS,
  sizing: SIZING_ATTRS,
  borderRadius: BORDER_RADIUS_ATTRS,
  opacity: OPACITY_ATTRS,
}

/** Inverse table: shape attr → token types that may fill it (built once). */
const ATTR_TOKEN_TYPES: Partial<Record<TokenProperties, SupportedTokenType[]>> = (() => {
  const acc: Partial<Record<TokenProperties, SupportedTokenType[]>> = {}
  for (const type of SUPPORTED_TOKEN_TYPES) {
    for (const attr of TOKEN_TYPE_ATTRS[type]) {
      ;(acc[attr] ??= []).push(type)
    }
  }
  return acc
})()

/** Attrs a token of this type may be applied to. */
export function attrsForTokenType(type: SupportedTokenType): TokenProperties[] {
  return TOKEN_TYPE_ATTRS[type]
}

/** Token types that may be applied to this attr (e.g. `r1` → [borderRadius, dimension]). */
export function tokenTypesForAttr(attr: TokenProperties): SupportedTokenType[] {
  return ATTR_TOKEN_TYPES[attr] ?? []
}

/** Whether a token of `type` may be applied to `attr`. */
export function canApplyTokenType(type: SupportedTokenType, attr: TokenProperties): boolean {
  return TOKEN_TYPE_ATTRS[type].includes(attr)
}

// ── Alias helpers ────────────────────────────────────────────────────────────
//
// A whole-string `{token.name}` is an alias. References embedded in math
// expressions ("{a} * 2") are the resolver's concern (P2.2); here we only
// recognise the simple whole-value form.

const ALIAS_RE = /^\{([^}]+)\}$/

export function isTokenAlias(value: TokenValue): value is string {
  return typeof value === 'string' && ALIAS_RE.test(value)
}

/** Inner token name of a whole-string alias, else null. */
export function tokenAliasName(value: TokenValue): string | null {
  if (typeof value !== 'string') return null
  const m = ALIAS_RE.exec(value)
  return m ? m[1] : null
}

// ── Active-set / theme accessors ─────────────────────────────────────────────
//
// Pure pre-resolution helpers. They decide *which* tokens are live; turning
// values + aliases into concrete output is the resolver's job (P2.2).

export function activeThemeObjects(lib: TokensLib): TokenTheme[] {
  const active = new Set(lib.activeThemes)
  return lib.themes.filter((t) => active.has(t.id))
}

/** Set names enabled by any active theme. */
export function activeSetNames(lib: TokensLib): Set<string> {
  const names = new Set<string>()
  for (const theme of activeThemeObjects(lib)) {
    for (const setName of theme.sets) names.add(setName)
  }
  return names
}

/** Active sets in lib order (so override precedence is deterministic). */
export function activeSets(lib: TokensLib): TokenSet[] {
  const names = activeSetNames(lib)
  return lib.sets.filter((s) => names.has(s.name))
}

/**
 * Flatten all tokens from the active sets into a single name→token map. When the
 * same name appears in more than one active set, the later set (in lib order)
 * wins — that is how modes override a base set.
 */
export function collectActiveTokens(lib: TokensLib): Map<string, Token> {
  const out = new Map<string, Token>()
  for (const set of activeSets(lib)) {
    const seen = new Set<string>()
    for (const token of set.tokens) {
      if (seen.has(token.name)) continue // first occurrence wins within a set
      seen.add(token.name)
      out.set(token.name, token) // a later active set overrides an earlier one
    }
  }
  return out
}

/**
 * Active sets, falling back to ALL sets when no theme is active — a file with
 * tokens but no themes yet behaves as a single implicit mode (everything on).
 * This is what apply/resolve key off so tokens are usable before any mode exists.
 */
export function effectiveActiveSets(lib: TokensLib): TokenSet[] {
  return lib.activeThemes.length > 0 ? activeSets(lib) : lib.sets
}

/** Like `collectActiveTokens` but over `effectiveActiveSets` (no-theme ⇒ all sets). */
export function effectiveActiveTokens(lib: TokensLib): Map<string, Token> {
  const out = new Map<string, Token>()
  for (const set of effectiveActiveSets(lib)) {
    const seen = new Set<string>()
    for (const token of set.tokens) {
      if (seen.has(token.name)) continue
      seen.add(token.name)
      out.set(token.name, token)
    }
  }
  return out
}

/** First token with a given name in a set (the resolver's winner). */
export function findToken(set: TokenSet, name: string): Token | undefined {
  return set.tokens.find((t) => t.name === name)
}

/** Names that appear more than once in a set (flagged as duplicates in the UI). */
export function duplicateNames(set: TokenSet): Set<string> {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const t of set.tokens) {
    if (seen.has(t.name)) dups.add(t.name)
    else seen.add(t.name)
  }
  return dups
}

// ── Factories ────────────────────────────────────────────────────────────────

function newId(): Uuid {
  return globalThis.crypto.randomUUID()
}

export interface CreateTokenInput {
  id?: Uuid
  name: string
  type: TokenType
  value: TokenValue
  description?: string
  modifiedAt?: string
}

export function createToken(input: CreateTokenInput): Token {
  return {
    id: input.id ?? newId(),
    name: input.name,
    type: input.type,
    value: input.value,
    description: input.description,
    modifiedAt: input.modifiedAt ?? new Date().toISOString(),
  }
}

export interface CreateTokenSetInput {
  id?: Uuid
  name: string
  tokens?: Token[]
}

export function createTokenSet(input: CreateTokenSetInput): TokenSet {
  return {
    id: input.id ?? newId(),
    name: input.name,
    tokens: input.tokens ?? [],
  }
}

export interface CreateTokenThemeInput {
  id?: Uuid
  name: string
  group?: string
  sets?: string[]
}

export function createTokenTheme(input: CreateTokenThemeInput): TokenTheme {
  return {
    id: input.id ?? newId(),
    name: input.name,
    group: input.group ?? '',
    sets: input.sets ?? [],
  }
}

export function emptyTokensLib(): TokensLib {
  return { sets: [], themes: [], activeThemes: [] }
}
