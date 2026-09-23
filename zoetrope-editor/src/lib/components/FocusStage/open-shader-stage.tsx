/**
 * Open the shader-authoring focus stage on a node's material. Shared by every
 * entry point (the effects panel's `</>`, the preset modal, the Assets panel) so
 * the session wiring — the stage + uniforms rail + console slots and the focus
 * undo branch — lives in exactly one place.
 */

import { openFocusStage } from '../../renderer/signals/focus-stage'
import { fork, merge } from '../../doc'
import type { Material } from '../../renderer/api/material'
import { ShaderMaterialStage } from './ShaderMaterialStage'
import { ShaderUniformsRail } from './ShaderUniformsRail'
import { ShaderConsole } from './ShaderConsole'

export function openShaderStage(nodeId: string, material: Material): void {
  // Labels the squashed entry left on the canvas on exit.
  const label = `shader-material:${nodeId}`
  // Open the stage first so a replaced session's `onExit` (merging its
  // branch) runs BEFORE we fork the fresh one below.
  openFocusStage({
    id: 'shader-material',
    title: 'Custom shader',
    center: <ShaderMaterialStage nodeId={nodeId} initialMaterial={material} />,
    right: <ShaderUniformsRail />,
    bottom: <ShaderConsole />,
    onExit: () => merge(label),
  })
  fork()
}
