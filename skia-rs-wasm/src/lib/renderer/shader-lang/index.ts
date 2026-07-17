/**
 * Shader-language registry. Look up the provider for a material's language;
 * everything else in the editor is language-neutral. Adding GLSL is: implement
 * `glslLanguage`, add one line here, and (separately) a transpile-before-render
 * hook — nothing else moves.
 */

import type { ShaderLanguageId } from '../api/material'
import type { ShaderLanguage } from './types'
import { skslLanguage } from './sksl'

const REGISTRY: Partial<Record<ShaderLanguageId, ShaderLanguage>> = {
  sksl: skslLanguage,
  // glsl: glslLanguage,
}

export const DEFAULT_LANGUAGE: ShaderLanguageId = 'sksl'

/** The provider for `id` (default when absent or not yet registered). */
export function shaderLanguage(id: ShaderLanguageId = DEFAULT_LANGUAGE): ShaderLanguage {
  return REGISTRY[id] ?? REGISTRY[DEFAULT_LANGUAGE]!
}

export type { ShaderLanguage, ShaderDiagnostic, ShaderCompileOutput } from './types'
