/**
 * SkSL language provider. Wraps the existing in-process compiler
 * (`compileMaterial` → Skia `make_for_shader`) — the real thing, not a
 * reimplementation — and adds a C-family grammar for highlighting plus a parser
 * that turns Skia's error text into structured, positioned diagnostics.
 */

import { cpp } from '@codemirror/lang-cpp'
import { compileMaterial } from '../api/material'
import { getWasmModule } from '../wasm-module'
import { DEFAULT_MATERIAL } from '../properties/panel-utils'
import type { ShaderCompletion, ShaderDiagnostic, ShaderLanguage } from './types'

/** Head of a Skia diagnostic: `error: 12: message` / `warning: 3: message`. */
const DIAG_HEAD = /^(error|warning): (\d+): (.*)$/
/** A caret line under the echoed source: leading run = column, `^`s = span. */
const CARET_LINE = /^\s*\^+\s*$/

/**
 * Parse Skia's SkSL error text into positioned diagnostics.
 *
 * The format (verified against the running compiler) is, per diagnostic:
 *
 *   error: <line>: <message>
 *   <the offending source line, echoed verbatim>
 *         ^^^^                                     ← optional caret
 *
 * repeated, then a `<n> error(s)` trailer. The line number is 1-based and maps
 * directly to editor lines (no preamble is injected before compile). The caret
 * line — when present; some errors carry none — gives the column (its leading
 * whitespace) and span (its run of `^`). Parsing is tolerant: a diagnostic with
 * no caret simply gets no column and underlines the whole line.
 */
export function parseSkslDiagnostics(raw: string): ShaderDiagnostic[] {
  const lines = raw.split('\n')
  const diagnostics: ShaderDiagnostic[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = DIAG_HEAD.exec(lines[i])
    if (!head) continue
    const [, severity, lineStr, message] = head
    const diagnostic: ShaderDiagnostic = {
      line: parseInt(lineStr, 10),
      severity: severity === 'warning' ? 'warning' : 'error',
      message,
    }
    // The caret, when present, is two lines below the head (head, source echo,
    // caret). Guard the echo line existing so a caret-less error can't misread
    // an unrelated later line.
    const echo = lines[i + 1]
    const caret = lines[i + 2]
    const echoIsHead = echo != null && DIAG_HEAD.test(echo)
    if (!echoIsHead && caret != null && CARET_LINE.test(caret)) {
      const lead = caret.length - caret.trimStart().length
      const span = caret.trim().length
      diagnostic.column = lead + 1
      diagnostic.endColumn = lead + span + 1
    }
    diagnostics.push(diagnostic)
  }
  return diagnostics
}

/** Build completion entries of one `kind` from a word list. */
const kind = (k: ShaderCompletion['kind'], detail: string, words: string[]): ShaderCompletion[] =>
  words.map((label) => ({ label, kind: k, detail }))

/**
 * Static completions: keywords, types, engine uniforms, and builtin functions.
 * The material's own reflected uniforms are merged in by the editor at edit time
 * (they're dynamic), so this list is only the language-fixed vocabulary.
 */
const SKSL_BUILTINS: readonly ShaderCompletion[] = [
  // engine-owned uniforms — always available, filled by the engine
  ...kind('variable', 'engine uniform', ['u_resolution', 'u_time', 'u_phase', 'u_scale']),
  // declaration / control-flow keywords
  ...kind('keyword', 'keyword', [
    'uniform', 'const', 'in', 'out', 'inout', 'return', 'if', 'else', 'for', 'discard',
  ]),
  // types
  ...kind('type', 'type', [
    'void', 'bool', 'int', 'float', 'half',
    'float2', 'float3', 'float4', 'half2', 'half3', 'half4', 'int2', 'int3', 'int4',
    'float2x2', 'float3x3', 'float4x4', 'shader', 'colorFilter', 'blender',
  ]),
  // builtin functions
  ...kind('function', 'builtin', [
    'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step',
    'smoothstep', 'sqrt', 'inversesqrt', 'pow', 'exp', 'log', 'exp2', 'log2',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'radians', 'degrees',
    'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'refract',
    'sample', 'unpremul', 'toLinearSrgb', 'fromLinearSrgb',
  ]),
]

/** SkSL type names, alternated for the declaration scanner. */
const TYPE_ALT = [
  'void', 'bool', 'int', 'float', 'half',
  'float2', 'float3', 'float4', 'half2', 'half3', 'half4', 'int2', 'int3', 'int4',
  'float2x2', 'float3x3', 'float4x4', 'shader', 'colorFilter', 'blender',
].join('|')

/**
 * A declaration: an optional `uniform`/`const` qualifier, a type, a name, and
 * (for functions) an opening paren. Catches uniforms, consts, locals, function
 * params, and function definitions — every identifier the author introduces.
 * `\b` before the qualifier/type keeps it from matching mid-identifier; the
 * trailing `(?=[\s;=,)])` stops constructors like `float2(…)` matching as a decl
 * (there a `(` immediately follows the type, so no name is captured anyway).
 */
const DECL = new RegExp(
  `\\b(uniform|const)?\\s*(?:${TYPE_ALT})\\s+([A-Za-z_]\\w*)\\s*(\\()?`,
  'g',
)

/**
 * Scan declared identifiers straight from the source text. Deliberately
 * lightweight (a regex, not a parse) — completion tolerates the odd miss or
 * false positive, and this runs only when the popup opens. Deduped by name,
 * first declaration wins.
 */
function scanSymbols(source: string): ShaderCompletion[] {
  const out: ShaderCompletion[] = []
  const seen = new Set<string>()
  for (const m of source.matchAll(DECL)) {
    const [, qualifier, name, paren] = m
    if (seen.has(name)) continue
    seen.add(name)
    if (qualifier === 'uniform') out.push({ label: name, kind: 'variable', detail: 'uniform' })
    else if (qualifier === 'const') out.push({ label: name, kind: 'constant', detail: 'const' })
    else if (paren) out.push({ label: name, kind: 'function', detail: 'function' })
    else out.push({ label: name, kind: 'variable', detail: 'local' })
  }
  return out
}

export const skslLanguage: ShaderLanguage = {
  id: 'sksl',
  label: 'SkSL',
  highlight: () => cpp(),
  compile(source) {
    const module = getWasmModule()
    if (!module) {
      return { ok: false, diagnostics: [], uniforms: [], inputs: [], usesTime: false }
    }
    const r = compileMaterial(module, source)
    return {
      ok: r.ok,
      diagnostics: r.ok ? [] : parseSkslDiagnostics(r.error ?? ''),
      uniforms: r.uniforms,
      inputs: r.inputs,
      usesTime: r.usesTime,
    }
  },
  // The provider owns the language's starter source; the string physically
  // lives with the model default (panel-utils, CodeMirror-free) so importing
  // `Material` doesn't drag the editor stack in.
  defaultSource: DEFAULT_MATERIAL.source,
  completions: SKSL_BUILTINS,
  symbols: scanSymbols,
}
