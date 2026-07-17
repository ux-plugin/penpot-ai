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
import { Input } from '@/components/ui/input'
import { NumericField } from './NumericField'
import { ShaderCodeEditor } from './ShaderCodeEditor'
import type { Material, MaterialUniformValue } from '../../renderer/api/material'
import { getWasmModule } from '../../renderer/wasm-module'
import { shaderLanguage, type ShaderCompileOutput } from '../../renderer/shader-lang'

/** Pack normalized-float RGB(A) components into a #RRGGBB hex string. */
function rgbToHex(vals: number[]): string {
  const c = (x: number) =>
    Math.max(0, Math.min(255, Math.round((x ?? 0) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(vals[0])}${c(vals[1])}${c(vals[2])}`
}

/** Parse #RRGGBB into `comps` normalized floats (alpha=1 for vec4). */
function hexToRgb(hex: string, comps: number): number[] {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return comps >= 4 ? [r, g, b, 1] : [r, g, b]
}

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
}

export function MaterialEditor({ material, onChange, fill = false, onCompiled }: MaterialEditorProps) {
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

  const readVals = (name: string, comps: number): number[] => {
    const u = material.uniforms?.find((x) => x.name === name)
    if (!u) return Array.from({ length: comps }, () => 0)
    return u.value.type === 'f32' ? [u.value.value] : [...u.value.value]
  }
  const commitVals = (name: string, comps: number, vals: number[]) => {
    let value: MaterialUniformValue
    if (comps <= 1) value = { type: 'f32', value: vals[0] ?? 0 }
    else if (comps === 2) value = { type: 'vec2', value: [vals[0] ?? 0, vals[1] ?? 0] }
    else if (comps === 3) value = { type: 'vec3', value: [vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0] }
    else value = { type: 'vec4', value: [vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0, vals[3] ?? 0] }
    const others = (material.uniforms ?? []).filter((x) => x.name !== name)
    onChange({ uniforms: [...others, { name, value }] })
  }

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

      {/* Reflected uniform controls (slider per component, or a color swatch) */}
      {compileResult?.ok && uniforms.length > 0 && (
        <div className={`space-y-2 border-t border-border pt-2 ${fill ? 'max-h-56 shrink-0 overflow-auto' : ''}`}>
          {uniforms.map((u) => {
            const comps = u.components || 1
            const vals = readVals(u.name, comps)

            if (u.isColor && comps >= 3) {
              const hex = rgbToHex(vals)
              return (
                <div key={u.name} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={u.name}>{u.name}</span>
                  <label className="relative size-5 shrink-0 overflow-hidden rounded border border-border" style={{ background: hex }} title="Pick color">
                    <input
                      type="color"
                      aria-label={u.name}
                      value={hex}
                      onChange={(e) => commitVals(u.name, comps, hexToRgb(e.target.value, comps))}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                  </label>
                  <Input
                    type="text"
                    className="h-7 min-w-0 flex-1 font-mono text-xs"
                    value={hex}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      if (/^#[0-9A-Fa-f]{6}$/.test(v)) commitVals(u.name, comps, hexToRgb(v, comps))
                    }}
                  />
                </div>
              )
            }

            return (
              <div key={u.name} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={u.name}>{u.name}</span>
                <div className="flex min-w-0 flex-1 gap-1">
                  {Array.from({ length: comps }).map((_, i) => (
                    <NumericField
                      key={i}
                      className="h-7 min-w-0 flex-1 px-1.5 text-xs"
                      aria-label={`${u.name}[${i}]`}
                      value={vals[i] ?? 0}
                      min={-9999}
                      max={9999}
                      step={0.01}
                      onCommit={(nv) => {
                        const next = [...vals]
                        next[i] = nv
                        commitVals(u.name, comps, next)
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
