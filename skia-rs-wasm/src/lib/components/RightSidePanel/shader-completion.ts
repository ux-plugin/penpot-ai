/**
 * The pure mapping from language-neutral completions (+ a material's own
 * reflected uniforms) to CodeMirror completion options. Kept out of the editor
 * component so it's testable without importing the CodeMirror React stack — both
 * imports here are type-only and erase at runtime.
 */

import type { Completion } from '@codemirror/autocomplete'
import type { ShaderCompletion } from '../../renderer/shader-lang'

/** CodeMirror completion `type` (drives the icon) for each neutral kind. */
export const CM_TYPE: Record<ShaderCompletion['kind'], string> = {
  keyword: 'keyword',
  type: 'type',
  function: 'function',
  variable: 'variable',
  constant: 'constant',
}

/**
 * Build the CodeMirror option list: identifiers declared in the source first
 * (most relevant — the author's own uniforms, consts, locals), then the
 * language's fixed vocabulary. De-duplicates by label so a declared name that
 * shadows a builtin (e.g. a custom `u_time`) shows once, as the author's.
 */
export function buildCompletionOptions(
  declared: readonly ShaderCompletion[],
  builtins: readonly ShaderCompletion[],
): Completion[] {
  const seen = new Set<string>()
  const options: Completion[] = []
  for (const c of [...declared, ...builtins]) {
    if (seen.has(c.label)) continue
    seen.add(c.label)
    options.push({ label: c.label, type: CM_TYPE[c.kind], detail: c.detail })
  }
  return options
}
