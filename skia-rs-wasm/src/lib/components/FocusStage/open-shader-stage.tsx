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

/** Per-open session counter — each focus session is its own undo group. */
let SHADER_SESSION_SEQ = 0

export function openShaderStage(nodeId: string, material: Material): void {
  // The session owns its scope tag: its commits are tagged with it, its own
  // lens reads them back step by step, and it labels the single collapsed entry
  // left on the canvas on exit. A fresh tag per open is what makes re-entering
  // start clean — no lens queries a closed session's tag.
  const groupId = `shader-material:${(SHADER_SESSION_SEQ += 1)}`
  // Open the stage first so a replaced session's `onExit` (collapsing its
  // scope) runs BEFORE we enter the fresh one below.
  openFocusStage({
    id: 'shader-material',
    title: 'Custom shader',
    center: <ShaderMaterialStage nodeId={nodeId} initialMaterial={material} groupId={groupId} />,
    right: <ShaderUniformsRail />,
    bottom: <ShaderConsole />,
    onExit: exitScope,
  })
  enterScope(groupId)
}
