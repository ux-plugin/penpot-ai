/**
 * Token resolver (P2.2) — turns a `TokensLib` into concrete, ready-to-apply
 * values. Ports Penpot's `app.main.data.style-dictionary`:
 *
 *   - register `@tokens-studio/sd-transforms`, then a custom `penpot` transform
 *     group = getTransforms() (css platform, so NO typography shorthand → a
 *     typography token stays a *map*) + the color transforms;
 *   - feed the active tokens as a nested Tokens-Studio tree ({name,value,type});
 *   - `getPlatformTokens('json').allTokens` resolves `{aliases}` + runs the
 *     transforms WITHOUT touching the filesystem (so it works in the browser and
 *     in Node tests alike — unlike `buildAllPlatforms`, which writes files);
 *   - parse each resolved value per the *origin* token's type into a number
 *     (dimensions/opacity), a css color string, or a typography sub-map.
 *
 * Cycles are detected up-front (SD would otherwise throw on circular refs):
 * cyclic tokens are excluded from the SD input and reported as errors; anything
 * that transitively depends on them is left with an unresolved `{ref}`, which
 * the leftover-reference check turns into a missing-reference error.
 *
 * Resolution is the ONLY place tokens become concrete; the renderer never sees a
 * token name (see docs/tokens-styles-port-plan.md).
 */

import StyleDictionary from 'style-dictionary'
import { getTransforms, register } from '@tokens-studio/sd-transforms'
import {
  effectiveActiveTokens,
  type Token,
  type TokensLib,
  type TokenType,
  type TypographyTokenValue,
} from './types'

export interface ResolvedToken {
  name: string
  type?: TokenType
  /** Concrete value ready to write: number (dimensions/opacity), css string (color), or sub-map (typography). */
  resolvedValue: number | string | Record<string, string> | null
  unit?: string
  /** Non-empty when the token could not be resolved (missing ref, cycle, bad value). */
  errors?: string[]
}

export type ResolvedTokens = Map<string, ResolvedToken>

// ── Style Dictionary setup (once) ────────────────────────────────────────────

const PLATFORM = 'json'
const TRANSFORM_GROUP = 'penpot'

let setupPromise: Promise<void> | null = null

/** Register sd-transforms + the custom `penpot` transform group exactly once. */
function ensureSetup(): Promise<void> {
  setupPromise ??= (async () => {
    // sd-transforms register() is async; it also installs the `tokens-studio` preprocessor.
    await register(StyleDictionary as never)
    StyleDictionary.registerTransformGroup({
      name: TRANSFORM_GROUP,
      // getTransforms() (css) keeps typography as a map; add the color transforms
      // so colors resolve to a concrete css/hex string.
      transforms: [...getTransforms(), 'ts/color/css/hexrgba', 'ts/color/modifiers', 'color/css'],
    })
  })()
  return setupPromise
}

// ── Reference + cycle detection ──────────────────────────────────────────────

const REF_RE = /\{([^}]+)\}/g

/** Token names referenced inside a value (string or composite typography map). */
function referencesIn(value: Token['value']): string[] {
  const out: string[] = []
  const scan = (s: string) => {
    for (const m of s.matchAll(REF_RE)) out.push(m[1])
  }
  if (typeof value === 'string') scan(value)
  else for (const v of Object.values(value)) if (typeof v === 'string') scan(v)
  return out
}

/** Names that participate in a reference cycle among the given tokens. */
function detectCycles(tokens: Map<string, Token>): Set<string> {
  const cyclic = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (name: string) => {
    state.set(name, 'visiting')
    stack.push(name)
    const token = tokens.get(name)
    if (token) {
      for (const ref of referencesIn(token.value)) {
        if (!tokens.has(ref)) continue // missing ref, not a cycle
        const s = state.get(ref)
        if (s === 'visiting') {
          // Back-edge: everything from `ref` to the top of the stack is cyclic.
          const from = stack.lastIndexOf(ref)
          for (const n of stack.slice(from)) cyclic.add(n)
        } else if (s === undefined) {
          visit(ref)
        }
      }
    }
    stack.pop()
    state.set(name, 'done')
  }

  for (const name of tokens.keys()) if (!state.has(name)) visit(name)
  return cyclic
}

// ── Value parsing (per origin token type) ────────────────────────────────────

function missingRefs(value: string): string[] {
  return [...value.matchAll(REF_RE)].map((m) => m[1])
}

function parseColor(raw: unknown): Pick<ResolvedToken, 'resolvedValue' | 'errors'> {
  const s = String(raw)
  const refs = missingRefs(s)
  if (refs.length) return { resolvedValue: null, errors: [`missing-reference: ${refs.join(', ')}`] }
  return { resolvedValue: s }
}

const DIMENSION_RE = /^(-?\d*\.?\d+)(px|rem)?$/

function parseDimension(raw: unknown): Pick<ResolvedToken, 'resolvedValue' | 'unit' | 'errors'> {
  const s = String(raw).trim()
  const refs = missingRefs(s)
  if (refs.length) return { resolvedValue: null, errors: [`missing-reference: ${refs.join(', ')}`] }
  const m = DIMENSION_RE.exec(s)
  if (!m) return { resolvedValue: null, errors: [`invalid-dimension: ${s}`] }
  return { resolvedValue: parseFloat(m[1]), unit: m[2] }
}

function parseOpacity(raw: unknown): Pick<ResolvedToken, 'resolvedValue' | 'errors'> {
  const s = String(raw).trim()
  const refs = missingRefs(s)
  if (refs.length) return { resolvedValue: null, errors: [`missing-reference: ${refs.join(', ')}`] }
  // ts/opacity has already turned "50%" into "0.5"; guard the range regardless.
  const n = parseFloat(s)
  if (Number.isNaN(n)) return { resolvedValue: null, errors: [`invalid-opacity: ${s}`] }
  if (n < 0 || n > 1) return { resolvedValue: null, errors: [`opacity-out-of-range: ${s}`] }
  return { resolvedValue: n }
}

const TYPOGRAPHY_FIELDS: (keyof TypographyTokenValue)[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textCase',
  'textDecoration',
]

function parseTypography(raw: unknown): Pick<ResolvedToken, 'resolvedValue' | 'errors'> {
  if (raw == null || typeof raw !== 'object') {
    return { resolvedValue: null, errors: [`invalid-typography: ${String(raw)}`] }
  }
  const src = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  const errors: string[] = []
  for (const field of TYPOGRAPHY_FIELDS) {
    const v = src[field]
    if (v == null) continue
    const s = String(v)
    const refs = missingRefs(s)
    if (refs.length) errors.push(`missing-reference: ${field} → ${refs.join(', ')}`)
    else out[field] = s
  }
  return errors.length ? { resolvedValue: out, errors } : { resolvedValue: out }
}

function parseByType(type: TokenType | undefined, raw: unknown): Pick<ResolvedToken, 'resolvedValue' | 'unit' | 'errors'> {
  switch (type) {
    case 'color':
      return parseColor(raw)
    case 'opacity':
      return parseOpacity(raw)
    case 'dimension':
    case 'spacing':
    case 'sizing':
    case 'borderRadius':
    case 'borderWidth':
      return parseDimension(raw)
    case 'typography':
      return parseTypography(raw)
    default:
      // Unsupported (forward-compat) types pass through unparsed, no error.
      return { resolvedValue: typeof raw === 'object' ? (raw as Record<string, string>) : String(raw) }
  }
}

// ── DTCG / Tokens-Studio tree ────────────────────────────────────────────────

interface SdLeaf {
  name: string
  value: Token['value']
  type: TokenType
}

/** Nest tokens by dot-separated name into a Tokens-Studio tree (mirrors ctob/tokens-tree). */
function buildTree(tokens: Map<string, Token>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const token of tokens.values()) {
    const path = token.name.split('.')
    let node = root
    for (let i = 0; i < path.length - 1; i++) {
      node = (node[path[i]] ??= {}) as Record<string, unknown>
    }
    const leaf: SdLeaf = { name: token.name, value: token.value, type: token.type }
    node[path[path.length - 1]] = leaf
  }
  return root
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Resolve a flat name→token map (the active tokens) into concrete values. */
export async function resolveTokenMap(tokens: Map<string, Token>): Promise<ResolvedTokens> {
  const out: ResolvedTokens = new Map()
  if (tokens.size === 0) return out

  await ensureSetup()

  // Cyclic tokens are reported and excluded so SD doesn't throw on the cycle.
  const cyclic = detectCycles(tokens)
  for (const name of cyclic) {
    const token = tokens.get(name)
    out.set(name, { name, type: token?.type, resolvedValue: null, errors: ['cyclic-reference'] })
  }

  const resolvable = new Map<string, Token>()
  for (const [name, token] of tokens) if (!cyclic.has(name)) resolvable.set(name, token)

  if (resolvable.size > 0) {
    const sd = new StyleDictionary({
      tokens: buildTree(resolvable),
      platforms: { [PLATFORM]: { transformGroup: TRANSFORM_GROUP } },
      preprocessors: ['tokens-studio'],
      log: { verbosity: 'silent', warnings: 'silent', errors: { brokenReferences: 'console' } },
    } as never)

    const dictionary = await sd.getPlatformTokens(PLATFORM)
    for (const sdToken of dictionary.allTokens as Array<{ value: unknown; original?: { name?: string } }>) {
      const name = sdToken.original?.name
      if (!name) continue
      const origin = resolvable.get(name)
      out.set(name, { name, type: origin?.type, ...parseByType(origin?.type, sdToken.value) })
    }
  }

  return out
}

/** Resolve all tokens live in the active themes of a lib (all sets when no theme is active). */
export async function resolveTokens(lib: TokensLib): Promise<ResolvedTokens> {
  return resolveTokenMap(effectiveActiveTokens(lib))
}
