/**
 * The shader-language seam. Everything that differs between SkSL and (later)
 * GLSL lives behind `ShaderLanguage`; the editor, uniform controls, transport,
 * clock, and preview surface are all language-neutral and consume only the
 * types here.
 *
 * Exactly three things vary per language — the grammar, the compile→diagnostics
 * path, and the default source + builtins — so the interface has exactly those.
 * Nothing gets abstracted that doesn't actually differ.
 */

import type { Extension } from '@codemirror/state'
import type { ReflectedUniform, ShaderLanguageId } from '../api/material'

export type { ShaderLanguageId }

/**
 * A compile diagnostic, language-neutral. `line` is 1-based; `column`/
 * `endColumn` are 1-based and optional (some errors carry no position). The
 * editor maps these to character offsets against the live document.
 */
export interface ShaderDiagnostic {
  line: number
  column?: number
  endColumn?: number
  severity: 'error' | 'warning'
  message: string
}

/**
 * The result the editor and stage consume — identical shape for every language.
 * Reflection (`uniforms`/`inputs`/`usesTime`) and diagnostics come from one
 * compile so the two can't disagree.
 */
export interface ShaderCompileOutput {
  ok: boolean
  /** Editor underlines / gutter. Empty when `ok`. */
  diagnostics: ShaderDiagnostic[]
  /** Reflected editable uniforms (engine-owned ones excluded). */
  uniforms: ReflectedUniform[]
  /** `uniform shader` child input names (e.g. backdrop/field/content). */
  inputs: string[]
  /** Source declares `u_time` ⇒ clock-driven (drives transport). */
  usesTime: boolean
}

export interface ShaderLanguage {
  id: ShaderLanguageId
  label: string
  /** CodeMirror grammar for highlighting. */
  highlight(): Extension
  /**
   * Compile/validate source → diagnostics + reflection. Synchronous for SkSL
   * (an in-process wasm call); the interface stays sync because the caller
   * already debounces. A future GLSL path transpiles first but returns the
   * same shape.
   */
  compile(source: string): ShaderCompileOutput
  /** Starter source for a new material in this language. */
  defaultSource: string
  /** Keywords + builtins for autocomplete (data now; completion wired later). */
  completions: readonly string[]
}
