/**
 * Open the shader-authoring focus stage on a node's material. Shared by every
 * entry point (the effects panel's `</>`, the preset modal, the Assets panel) so
 * the session wiring — the stage + uniforms rail + console slots and the focus
 * undo scope — lives in exactly one place.
 */

import { openFocusStage } from '../../renderer/signals/focus-stage'
import { enterScope, exitScope } from '../../history/journal/scope'
import type { Material } from '../../renderer/api/material'
import { ShaderMaterialStage } from './ShaderMaterialStage'
import { ShaderUniformsRail } from './ShaderUniformsRail'
import { ShaderConsole } from './ShaderConsole'

export function openShaderStage(nodeId: string, material: Material): void {
  // The scope tag names the SUBJECT, not the visit — so re-opening this shape's
  // shader resumes its history rather than starting blank, and undo/redo carry
  // on where they left off. Its commits are tagged with it, its own lens reads
  // them back step by step, and it labels the collapsed entry left on the
  // canvas on exit.
  const scope = `shader-material:${nodeId}`
  // Open the stage first so a replaced session's `onExit` (collapsing its
  // scope) runs BEFORE we enter the fresh one below.
  openFocusStage({
    id: 'shader-material',
    title: 'Custom shader',
    center: <ShaderMaterialStage nodeId={nodeId} initialMaterial={material} />,
    right: <ShaderUniformsRail />,
    bottom: <ShaderConsole />,
    onExit: exitScope,
  })
  enterScope(scope)
}
