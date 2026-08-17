/**
 * MaterialUniformControls — the reflected-uniform editor rows for a material: a
 * color swatch + hex for a `layout(color)` vec3/4, else a numeric field per
 * component. A bindable uniform (color or scalar) can also be linked to a
 * design token: bound, it shows a locked pill (value comes from the token);
 * unbound, a "Link" button opens a picker of matching-type tokens.
 *
 * Bindings materialize — the token's resolved value is written into the
 * uniform's value and kept in sync while these controls are mounted — so the
 * renderer only ever sees a plain value. Commits emit ONE whole
 * `MaterialUniform` (value + optional token), which the host merges against its
 * own freshest draft.
 *
 * Renders just the list of rows; callers own the surrounding frame.
 */

import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { Link2, Unlink2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { NumericField } from './NumericField'
import { docProxy } from '../../renderer/store/doc-proxy'
import { effectiveActiveTokens, type Token, type TokensLib } from '../../tokens/types'
import { useResolvedTokens } from '../../tokens/use-resolved-tokens'
import type { ResolvedToken } from '../../tokens/resolve'
import type { Material, MaterialUniform, MaterialUniformValue, ReflectedUniform } from '../../renderer/api/material'
import { materializeTokenValue, uniformTokenType } from './material-token'

/** Pack normalized-float RGB(A) components into a #RRGGBB hex string. */
function rgbToHex(vals: readonly number[]): string {
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

function valsOf(u: MaterialUniform | undefined, comps: number): number[] {
  if (!u) return Array.from({ length: comps }, () => 0)
  return u.value.type === 'f32' ? [u.value.value] : [...u.value.value]
}

function packValue(comps: number, vals: number[]): MaterialUniformValue {
  if (comps <= 1) return { type: 'f32', value: vals[0] ?? 0 }
  if (comps === 2) return { type: 'vec2', value: [vals[0] ?? 0, vals[1] ?? 0] }
  if (comps === 3) return { type: 'vec3', value: [vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0] }
  return { type: 'vec4', value: [vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0, vals[3] ?? 0] }
}

function sameValue(a: MaterialUniformValue, b: MaterialUniformValue): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'f32') return a.value === (b as { value: number }).value
  const av = a.value as readonly number[]
  const bv = (b as { value: readonly number[] }).value
  return av.length === bv.length && av.every((x, i) => x === bv[i])
}

/** A resolved token's compact display: a swatch (color) or its text. */
function tokenDisplay(r: ResolvedToken | undefined): { swatch?: string; text: string } {
  if (!r || r.errors?.length || r.resolvedValue == null) return { text: 'unresolved' }
  if (r.type === 'color') return { swatch: String(r.resolvedValue), text: String(r.resolvedValue) }
  return { text: String(r.resolvedValue) }
}

export interface MaterialUniformControlsProps {
  uniforms: ReflectedUniform[]
  /** The current material — read for each uniform's live value + token binding. */
  material: Material
  /** Commit ONE whole uniform (value + optional token). Host merges by name. */
  onCommitUniform: (u: MaterialUniform) => void
}

export function MaterialUniformControls({ uniforms, material, onCommitUniform }: MaterialUniformControlsProps) {
  const doc = useSnapshot(docProxy)
  const lib = doc.meta?.tokens as TokensLib | undefined
  const resolved = useResolvedTokens()
  const [openPicker, setOpenPicker] = useState<string | null>(null)

  const byName = (name: string) => material.uniforms?.find((x) => x.name === name)

  // Re-materialize bound uniforms whenever their token's resolved value changes
  // (theme switch, token edit). Guarded by value equality so it converges after
  // one commit and never loops. Keyed on a signature of the bound tokens' values
  // so it only fires on a real change. (While these controls are mounted only —
  // full propagation while closed is a fast-follow.)
  const latest = useRef({ material, uniforms, resolved, onCommitUniform })
  // Synced in an effect rather than during render. Declared BEFORE the
  // re-materialize effect below, so it has already landed by the time that one
  // reads `latest.current`.
  useEffect(() => {
    latest.current = { material, uniforms, resolved, onCommitUniform }
  })
  const boundSig = (material.uniforms ?? [])
    .filter((u) => u.token)
    .map((u) => `${u.name}:${JSON.stringify(resolved.get(u.token!)?.resolvedValue ?? null)}`)
    .join('|')
  useEffect(() => {
    const s = latest.current
    for (const mu of s.material.uniforms ?? []) {
      if (!mu.token) continue
      const refl = s.uniforms.find((u) => u.name === mu.name)
      if (!refl) continue
      const mat = materializeTokenValue(refl, s.resolved.get(mu.token))
      if (mat && !sameValue(mat, mu.value)) s.onCommitUniform({ name: mu.name, value: mat, token: mu.token })
    }
  }, [boundSig])

  return (
    <div className="space-y-2">
      {uniforms.map((u) => {
        const comps = u.components || 1
        const mu = byName(u.name)
        const vals = valsOf(mu, comps)
        const tokenType = uniformTokenType(u)
        const boundToken = mu?.token

        const commitVals = (nextVals: number[]) =>
          onCommitUniform({ name: u.name, value: packValue(comps, nextVals) })

        const bind = (t: Token) => {
          setOpenPicker(null)
          const mat = materializeTokenValue(u, resolved.get(t.name))
          onCommitUniform({ name: u.name, value: mat ?? packValue(comps, vals), token: t.name })
        }
        const unlink = () => onCommitUniform({ name: u.name, value: packValue(comps, vals) })

        // ── Bound: locked token pill ──────────────────────────────────────────
        if (boundToken) {
          const d = tokenDisplay(resolved.get(boundToken))
          return (
            <div key={u.name} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={u.name}>{u.name}</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]">
                <Link2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                {d.swatch && <span className="size-3 shrink-0 rounded border border-border" style={{ backgroundColor: d.swatch }} aria-hidden />}
                <span className="min-w-0 flex-1 truncate font-medium" title={boundToken}>{boundToken}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{d.text}</span>
              </div>
              <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Unlink ${u.name}`} title="Unlink — keeps the current value" onClick={unlink}>
                <Unlink2 className="size-3.5" />
              </button>
            </div>
          )
        }

        // ── Unbound: raw control (+ link affordance for a bindable uniform) ────
        const control =
          u.isColor && comps >= 3 ? (
            (() => {
              const hex = rgbToHex(vals)
              return (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <label className="relative size-5 shrink-0 overflow-hidden rounded border border-border" style={{ background: hex }} title="Pick color">
                    <input type="color" aria-label={u.name} value={hex} onChange={(e) => commitVals(hexToRgb(e.target.value, comps))} className="absolute inset-0 size-full cursor-pointer opacity-0" />
                  </label>
                  <Input type="text" className="h-7 min-w-0 flex-1 font-mono text-xs" value={hex}
                    onChange={(e) => { const v = e.target.value.trim(); if (/^#[0-9A-Fa-f]{6}$/.test(v)) commitVals(hexToRgb(v, comps)) }} />
                </div>
              )
            })()
          ) : (
            <div className="flex min-w-0 flex-1 gap-1">
              {Array.from({ length: comps }).map((_, i) => (
                <NumericField key={i} className="h-7 min-w-0 flex-1 px-1.5 text-xs" aria-label={`${u.name}[${i}]`} value={vals[i] ?? 0} min={-9999} max={9999} step={0.01}
                  onCommit={(nv) => { const next = [...vals]; next[i] = nv; commitVals(next) }} />
              ))}
            </div>
          )

        const candidates = lib ? [...effectiveActiveTokens(lib).values()].filter((t) => t.type === tokenType) : []
        const picking = openPicker === u.name

        return (
          <div key={u.name} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={u.name}>{u.name}</span>
              {control}
              {tokenType && (
                <button type="button" className={cn('shrink-0 text-muted-foreground hover:text-foreground', picking && 'text-foreground')} aria-expanded={picking} aria-label={`Link ${u.name} to token`} title={`Link to a ${tokenType} token`} onClick={() => setOpenPicker((p) => (p === u.name ? null : u.name))}>
                  <Link2 className="size-3.5" />
                </button>
              )}
            </div>
            {picking && tokenType && (
              <div className="ml-24 rounded-md border border-border">
                <div className="px-2 py-1 text-[0.6rem] uppercase tracking-wider text-muted-foreground">Apply {tokenType} token</div>
                <ul className="list-none p-0">
                  {candidates.length === 0 && <li className="px-2 py-1 text-[11px] text-muted-foreground">No {tokenType} tokens yet</li>}
                  {candidates.map((t) => {
                    const d = tokenDisplay(resolved.get(t.name))
                    return (
                      <li key={t.id}>
                        <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-muted/60" onClick={() => bind(t as Token)} title={`Apply ${t.name}`}>
                          {d.swatch && <span className="size-3 shrink-0 rounded border border-border" style={{ backgroundColor: d.swatch }} aria-hidden />}
                          <span className="min-w-0 flex-1 truncate">{t.name}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{d.text}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
