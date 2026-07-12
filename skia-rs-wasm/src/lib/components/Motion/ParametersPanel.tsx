/**
 * Parameters panel — declare number parameters, drive them live with a slider,
 * and bind the selected shape's properties to one. Sliding a parameter
 * re-evaluates the scene through the same runtime path as timeline playback, so a
 * param-driven property moves on the canvas immediately (no play needed). This is
 * the param-domain half of the unified driver model: a keyframe track and a
 * parameter binding are the same curve, sampled over a different domain.
 */

import { useState } from 'react'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import {
  addNumberParam,
  bindPropertyToParam,
  motionParamDefs,
  motionParams,
  removeParam,
  setParamValue,
} from '../../renderer/motion/motion-store'
import type { AnimatableProperty } from '../../renderer/motion/props'

const selCls =
  'h-6 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-ring'
const fieldCls =
  'h-6 w-14 rounded-md border border-border bg-background px-1.5 text-right font-mono text-[11px] text-foreground outline-none focus:border-ring'
const btnCls =
  'inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-40'

const BIND_PROPS: { property: AnimatableProperty; label: string }[] = [
  { property: 'x', label: 'X' },
  { property: 'y', label: 'Y' },
  { property: 'rotation', label: 'Rotation' },
]

const fmt = (n: number): string => String(Math.round(n * 100) / 100)

export function ParametersPanel({ targetId }: { targetId: string | null }) {
  const defs = useSignalCoalesced(motionParamDefs)
  const values = useSignalCoalesced(motionParams)

  const [bindProp, setBindProp] = useState<AnimatableProperty>('x')
  const [bindParam, setBindParam] = useState<string>('')
  const [endDelta, setEndDelta] = useState('100')

  const paramId = bindParam || defs[0]?.id || ''

  const bind = (): void => {
    const n = parseFloat(endDelta)
    if (!Number.isNaN(n) && targetId && paramId) bindPropertyToParam(targetId, bindProp, paramId, n)
  }

  return (
    <div className="border-t border-border px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Parameters</span>
        <button type="button" className={btnCls} onClick={() => addNumberParam(0, 1)}>
          + Add
        </button>
      </div>

      {defs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No parameters. Add one to drive a property by value instead of time.
        </p>
      ) : (
        <div className="space-y-2">
          {defs.map((d) => {
            const min = d.min ?? 0
            const max = d.max ?? 1
            return (
              <div key={d.id} className="flex items-center gap-2">
                <span className="w-8 shrink-0 font-mono text-[11px] text-foreground">{d.id}</span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={(max - min) / 100 || 0.01}
                  value={values[d.id] ?? min}
                  onChange={(e) => setParamValue(d.id, Number(e.target.value))}
                  className="flex-1 accent-[#0d99ff]"
                  aria-label={`${d.id} value`}
                />
                <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                  {fmt(values[d.id] ?? min)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${d.id}`}
                  onClick={() => removeParam(d.id)}
                  className="shrink-0 px-1 text-muted-foreground hover:text-foreground"
                >
                  &times;
                </button>
              </div>
            )
          })}
        </div>
      )}

      {targetId && defs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
          <span className="text-[11px] text-muted-foreground">Bind</span>
          <select
            value={bindProp}
            onChange={(e) => setBindProp(e.target.value as AnimatableProperty)}
            className={selCls}
            aria-label="Property to bind"
          >
            {BIND_PROPS.map((b) => (
              <option key={b.property} value={b.property}>
                {b.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">to</span>
          <select
            value={paramId}
            onChange={(e) => setBindParam(e.target.value)}
            className={selCls}
            aria-label="Parameter to bind to"
          >
            {defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">Δ at max</span>
          <input
            type="number"
            value={endDelta}
            onChange={(e) => setEndDelta(e.target.value)}
            className={fieldCls}
            aria-label="Delta at parameter max"
          />
          <button type="button" className={btnCls} onClick={bind}>
            Bind
          </button>
        </div>
      )}
    </div>
  )
}
