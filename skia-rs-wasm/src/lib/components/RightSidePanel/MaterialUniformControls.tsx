/**
 * MaterialUniformControls — the reflected-uniform editor rows for a material: a
 * color swatch + hex field for a `layout(color)` vec3/4, else one numeric field
 * per component. Pure presentation over `(uniforms, material, onChange)`, so it
 * renders identically wherever the material lives — inline in `MaterialEditor`
 * (floating panel) or in the focus stage's `ShaderUniformsRail` (right rail).
 *
 * It renders just the list of rows (`space-y-2`); callers own the surrounding
 * frame (border, scroll, header).
 */

import { Input } from '@/components/ui/input'
import { NumericField } from './NumericField'
import type { Material, MaterialUniformValue, ReflectedUniform } from '../../renderer/api/material'

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

export interface MaterialUniformControlsProps {
  uniforms: ReflectedUniform[]
  /** The current material — read for each uniform's live value (display only). */
  material: Material
  /**
   * Commit ONE changed uniform. The host merges it into its own freshest draft,
   * so the controls never rebuild the full list from a possibly-stale `material`
   * (the rail reads `material` through an rAF-gated signal — rebuilding there
   * could drop a sibling uniform changed in the same frame).
   */
  onChangeUniform: (name: string, value: MaterialUniformValue) => void
}

export function MaterialUniformControls({ uniforms, material, onChangeUniform }: MaterialUniformControlsProps) {
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
    onChangeUniform(name, value)
  }

  return (
    <div className="space-y-2">
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
  )
}
