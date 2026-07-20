/**
 * Open the shader-authoring focus stage on a node's material. Shared by every
 * entry point (the effects panel's `</>`, the preset modal, the Assets panel) so
 * the session wiring — the stage + uniforms rail + console slots and the undo
 * `groupId`/`undoScope` — lives in exactly one place.
 */

import { openFocusStage } from '../../renderer/signals/focus-stage'
import type { Material } from '../../renderer/api/material'
import { ShaderMaterialStage } from './ShaderMaterialStage'
import { ShaderUniformsRail } from './ShaderUniformsRail'
import { ShaderConsole } from './ShaderConsole'

/** Per-open session counter — each focus session is its own undo group. */
let SHADER_SESSION_SEQ = 0

export function openShaderStage(nodeId: string, material: Material): void {
  // The session owns its undo `groupId`: the stage's commits carry it (so canvas
  // group-undo collapses the whole session), and `undoScope` re-uses it so the
  // focus reader's revert-by-append frames are swept by that same group-undo.
  const groupId = `shader-material:${(SHADER_SESSION_SEQ += 1)}`
  openFocusStage({
    id: 'shader-material',
    title: 'Custom shader',
    center: <ShaderMaterialStage nodeId={nodeId} initialMaterial={material} groupId={groupId} />,
    right: <ShaderUniformsRail />,
    bottom: <ShaderConsole />,
    undoScope: { nodeIds: [nodeId], attrs: ['material'], groupId },
  })
}
