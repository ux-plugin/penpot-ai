/**
 * MaterialEditor — the shared editing UI for a custom shader material: the
 * source field, a debounced compile-status line, and the reflected uniform
 * controls (a color swatch for `@color` vec3/4, else a numeric field per
 * component). Owns its own compile+reflect so any host just supplies the
 * `material` and an `onChange`.
 *
 * Language-agnostic: the compile + grammar come from the material's
 * `ShaderLanguage` provider, so nothing here is SkSL-specific.
 *
 * Used both by the inline `FloatingEffectEditorPanel` (compact, plain textarea)
 * and the full `ShaderMaterialStage` (focus mode, CodeMirror with highlighting +
 * inline diagnostics).
 */

import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { ShaderCodeEditor } from './ShaderCodeEditor'
import { MaterialUniformControls } from './MaterialUniformControls'
import type { Material } from '../../renderer/api/material'
import { getWasmModule } from '../../renderer/wasm-module'
import { shaderLanguage, type ShaderCompileOutput } from '../../renderer/shader-lang'

export interface MaterialEditorProps {
  material: Material
  onChange: (partial: Partial<Material>) => void
  /**
   * `fill` makes the editor grow to its container's height (source textarea
   * flexes, status + uniforms pin below in a scroll area) — for the focus
   * stage's editor pane. Default (`false`) is the compact fixed-height layout
   * for the inline floating panel.
   */
  fill?: boolean
  /**
   * Observe each compile result (`null` while recompiling). The editor keeps
   * owning the compile so every host gets the debounce + reflection for free;
   * this just lets a host react to it — the focus stage uses `usesTime` to
   * decide whether to show transport and run an animation loop.
   */
  onCompiled?: (result: ShaderCompileOutput | null) => void
  /**
   * Render the reflected uniform controls inline (default). The focus stage
   * passes `false` and hosts them in its right rail (`ShaderUniformsRail`)
   * instead, so it still owns the compile here but surfaces the knobs elsewhere.
   */
  showUniforms?: boolean
  /**
   * Notified with the CodeMirror `EditorView` once it mounts (fill mode only —
   * the compact textarea has no view). The focus stage uses it to drive
   * jump-to-line from the console strip.
   */
  onEditorReady?: (view: EditorView) => void
}

export function MaterialEditor({
  material,
  onChange,
  fill = false,
  onCompiled,
  showUniforms = true,
  onEditorReady,
}: MaterialEditorProps) {
  const language = shaderLanguage(material.language)

  // Compile+reflect the source (debounced) to drive the status line, the
  // reflected controls, and the editor's inline diagnostics. Tag each result
  // with the source it came from so a source change (or an absent WASM module)
  // derives back to `null` = "Compiling…" without a synchronous setState cascade.
  const [compiled, setCompiled] = useState<{ source: string; result: ShaderCompileOutput } | null>(null)
  const source = material.source
  useEffect(() => {
    // Gate on the module being up so startup shows "Compiling…" rather than a
    // spurious error frame before the renderer exists.
    if (!getWasmModule()) return
    const id = setTimeout(() => {
      setCompiled({ source, result: language.compile(source) })
    }, 150)
    return () => clearTimeout(id)
  }, [source, language])
  const compileResult = compiled?.source === source ? compiled.result : null
  const uniforms = compileResult?.uniforms ?? []
  const diagnostics = compileResult?.diagnostics ?? []

  // Report each result to an interested host. Via a ref so an inline callback
  // can't retrigger this effect every render.
  const onCompiledRef = useRef(onCompiled)
  onCompiledRef.current = onCompiled
  useEffect(() => {
    onCompiledRef.current?.(compileResult)
  }, [compileResult])

  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3'}>
      {/* Source editor. Focus mode (`fill`) gets CodeMirror with highlighting +
          inline diagnostics; the compact floating panel keeps a plain textarea. */}
      <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-1.5' : 'space-y-1.5'}>
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{language.label} source</span>
        {fill ? (
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-input text-[11px]">
            <ShaderCodeEditor
              language={language}
              value={material.source}
              diagnostics={diagnostics}
              onViewReady={onEditorReady}
              onChange={(v) => onChange({ source: v })}
              className="h-full"
            />
          </div>
        ) : (
          <textarea
            className="border-input bg-background h-44 w-full resize-y rounded-md border p-2 font-mono text-[11px] leading-relaxed"
            spellCheck={false}
            value={material.source}
            onChange={(e) => onChange({ source: e.target.value })}
          />
        )}
      </div>

      {/* Compile status */}
      <div className="shrink-0 text-[11px]">
        {compileResult == null ? (
          <span className="text-muted-foreground">Compiling…</span>
        ) : compileResult.ok ? (
          <span className="text-emerald-600">
            ✓ Compiled · {uniforms.length} uniform{uniforms.length === 1 ? '' : 's'}
            {compileResult.inputs.length > 0
              ? ` · ${compileResult.inputs.length} input${compileResult.inputs.length === 1 ? '' : 's'}`
              : ''}
          </span>
        ) : (
          <span className="break-words font-mono text-red-600">
            {diagnostics.length > 0
              ? `${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'} · ${diagnostics[0].message}`
              : 'Compile failed'}
          </span>
        )}
      </div>

      {/* Reflected uniform controls. Inline by default; the focus stage passes
          `showUniforms={false}` and renders them in its right rail instead. */}
      {showUniforms && compileResult?.ok && uniforms.length > 0 && (
        <div className={`border-t border-border pt-2 ${fill ? 'max-h-56 shrink-0 overflow-auto' : ''}`}>
          <MaterialUniformControls
            uniforms={uniforms}
            material={material}
            onChangeUniform={(name, value) =>
              onChange({
                uniforms: [...(material.uniforms ?? []).filter((u) => u.name !== name), { name, value }],
              })
            }
          />
        </div>
      )}
    </div>
  )
}
