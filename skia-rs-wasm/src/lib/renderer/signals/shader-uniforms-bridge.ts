/**
 * A bridge from the shader stage's live draft to the uniforms rail.
 *
 * The shader focus stage puts the SkSL editor in the center slot and the
 * reflected-uniform controls in the *right* slot (the inspector position — the
 * "two-persona bridge": coder edits source on the left, designer turns knobs on
 * the right). Those two slots are separate React subtrees rendered by `App`, so
 * they can't share props. This signal carries what the rail needs across that
 * gap; `ShaderMaterialStage` stays authoritative and *publishes* here, the rail
 * subscribes. Null whenever no shader stage is open.
 */

import { signal } from '@preact/signals-core'
import type { Material, MaterialUniform, ReflectedUniform } from '../api/material'

export interface ShaderUniformsBridge {
  /** The current draft — read for each uniform's live value + token binding. */
  material: Material
  /** Reflected editable uniforms from the last GOOD compile (engine ones excluded). */
  uniforms: ReflectedUniform[]
  /** Whether the current source compiles — the rail shows a hint when it doesn't. */
  ok: boolean
  /**
   * Commit one whole uniform (value + optional token binding). The stage merges
   * it against its always-fresh draft ref (not the rAF-lagged snapshot the rail
   * renders from), so a rapid edit of one uniform can't clobber another; then it
   * idle-coalesces the commit.
   */
  setUniform: (u: MaterialUniform) => void
}

export const shaderUniformsBridge = signal<ShaderUniformsBridge | null>(null)
