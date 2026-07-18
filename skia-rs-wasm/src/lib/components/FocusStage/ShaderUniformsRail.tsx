/**
 * ShaderUniformsRail — the shader stage's right rail (it overrides the inspector
 * while a shader is being authored). It renders the material's reflected-uniform
 * controls, reading everything from `shaderUniformsBridge`: the stage owns the
 * draft + compile and publishes here, so this rail is a thin subscriber. See the
 * bridge module for why the two live in separate focus-stage slots.
 */

import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { shaderUniformsBridge } from '../../renderer/signals/shader-uniforms-bridge'
import { MaterialUniformControls } from '../RightSidePanel/MaterialUniformControls'

export function ShaderUniformsRail() {
  const bridge = useSignalCoalesced(shaderUniformsBridge)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 px-4 py-3">
        <h2 className="text-sm font-semibold">Uniforms</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {!bridge ? null : bridge.uniforms.length > 0 ? (
          <MaterialUniformControls
            uniforms={bridge.uniforms}
            material={bridge.material}
            onChangeUniform={bridge.setUniform}
          />
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {bridge.ok
              ? 'This shader declares no editable uniforms. Add one — e.g. ' +
                '`uniform half4 u_color;` — and it appears here as a control.'
              : 'Fix the compile error to see this shader’s uniforms.'}
          </p>
        )}
      </div>
    </div>
  )
}
