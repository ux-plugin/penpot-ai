/**
 * ShaderUniformsRail — the shader stage's right rail. It takes over the right
 * panel slot (`App` renders `focus.right` in place of the Inspector) while a
 * shader is being authored: same panel chrome as the Inspector — the shared
 * `FloatingEditorRail` shell — just retitled "Uniforms" with the material's
 * reflected-uniform controls as its body instead of the shape sections. The
 * Inspector's shape content (position, fills, tabs) is exactly the noise focus
 * mode removes, so we swap the body, not the panel.
 *
 * Everything is read from `shaderUniformsBridge`: the stage owns the draft +
 * compile and publishes there, so this rail is a thin subscriber. See the bridge
 * module for why the two live in separate focus-stage slots.
 */

import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { shaderUniformsBridge } from '../../renderer/signals/shader-uniforms-bridge'
import { FloatingEditorRail } from '../EditorShell/floating-editor-rail'
import { MaterialUniformControls } from '../RightSidePanel/MaterialUniformControls'

export function ShaderUniformsRail() {
  const bridge = useSignalCoalesced(shaderUniformsBridge)

  return (
    <FloatingEditorRail docked side="right" title="Uniforms" collapsed={false} onCollapsedChange={() => {}}>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
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
    </FloatingEditorRail>
  )
}
