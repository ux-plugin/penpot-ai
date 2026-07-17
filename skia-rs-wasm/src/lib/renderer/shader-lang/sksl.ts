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
import type { ShaderDiagnostic, ShaderLanguage } from './types'

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

/** Keywords, types, and common builtins — data for the (later) completion source. */
const SKSL_BUILTINS: readonly string[] = [
  // engine-owned uniforms
  'u_resolution', 'u_time', 'u_scale',
  // declaration keywords
  'uniform', 'const', 'in', 'out', 'inout', 'return', 'if', 'else', 'for', 'discard',
  // types
  'void', 'bool', 'int', 'float', 'half',
  'float2', 'float3', 'float4', 'half2', 'half3', 'half4', 'int2', 'int3', 'int4',
  'float2x2', 'float3x3', 'float4x4', 'shader', 'colorFilter', 'blender',
  // builtins
  'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step',
  'smoothstep', 'sqrt', 'inversesqrt', 'pow', 'exp', 'log', 'exp2', 'log2',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'radians', 'degrees',
  'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'refract',
  'sample', 'unpremul', 'toLinearSrgb', 'fromLinearSrgb',
]

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
}
