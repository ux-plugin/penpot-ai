/**
 * Open the shader-authoring focus stage on a node's material. Shared by every
 * entry point (the effects panel's `</>`, the preset modal, the Assets panel) so
 * the session wiring — the stage + uniforms rail + console slots and the focus
 * sub-history buffer — lives in exactly one place.
 */

import { openFocusStage } from '../../renderer/signals/focus-stage'
import { beginFocusBuffer, endFocusBuffer } from '../../history/history-store'
import type { Material } from '../../renderer/api/material'
import { ShaderMaterialStage } from './ShaderMaterialStage'
import { ShaderUniformsRail } from './ShaderUniformsRail'
import { ShaderConsole } from './ShaderConsole'

/** Per-open session counter — each focus session is its own undo group. */
let SHADER_SESSION_SEQ = 0

export function openShaderStage(nodeId: string, material: Material): void {
  // The session owns its undo `groupId`: the stage's commits carry it, and it
  // labels the single folded entry the buffer leaves on the canvas history.
  const groupId = `shader-material:${(SHADER_SESSION_SEQ += 1)}`
  // Open the stage first so a replaced session's `onExit` (folding its buffer)
  // runs BEFORE we open the fresh buffer below.
  openFocusStage({
    id: 'shader-material',
    title: 'Custom shader',
    center: <ShaderMaterialStage nodeId={nodeId} initialMaterial={material} groupId={groupId} />,
    right: <ShaderUniformsRail />,
    bottom: <ShaderConsole />,
    onExit: endFocusBuffer,
  })
  beginFocusBuffer(groupId)
}
