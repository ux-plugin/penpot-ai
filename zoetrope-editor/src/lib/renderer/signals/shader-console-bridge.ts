/**
 * A bridge from the shader stage's compile output to the console strip.
 *
 * The console lives in the focus stage's bottom slot — a separate React subtree
 * from the editor — so, like the uniforms rail, it can't read the compile via
 * props. The stage publishes the latest diagnostics here (and a `reveal` that
 * drives the editor's CodeMirror view for jump-to-line); the console subscribes.
 * Null whenever no shader stage is open.
 *
 * Diagnostics are the LATEST compile's, not the last good one — the console's
 * whole job is to show the errors on a broken shader.
 */

import { signal } from '@preact/signals-core'
import type { ShaderDiagnostic } from '../shader-lang'

export type ShaderConsoleStatus = 'compiling' | 'ok' | 'error'

export interface ShaderConsoleBridge {
  diagnostics: ShaderDiagnostic[]
  status: ShaderConsoleStatus
  /** Move the editor caret to (1-based) line/column and scroll it into view. */
  reveal: (line: number, column?: number) => void
}

export const shaderConsoleBridge = signal<ShaderConsoleBridge | null>(null)
