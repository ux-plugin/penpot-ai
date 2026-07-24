/**
 * Inspector -> Motion tab. Delta-based authoring: each property row reads
 * `current -> end` -- the shape's current (rest) value on the left, an editable
 * end on the right. What gets stored is the *delta* (end - current), so the
 * motion is a portable offset from wherever the shape sits. The diamond
 * pins/removes a keyframe (delta) at the playhead.
 */

import { useState } from 'react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../../renderer/store/doc-proxy'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { keyframeAt, keyframeDelta, type ShapeMotion } from '../../renderer/motion/edit'
import {
  motionShapes,
  motionLoop,
  motionPlaying,
  motionTime,
  pauseMotion,
  playMotion,
  removeKeyframeAtPlayhead,
  setKeyframeAtPlayhead,
  setMotionLoop,
  stopMotion,
} from '../../renderer/motion/motion-store'
import type { AnimatableProperty } from '../../renderer/motion/props'
import { ParametersPanel } from '../Motion/ParametersPanel'

const ACCENT = '#0d99ff'
const btnCls =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40'
const fieldCls =
  'h-7 w-16 rounded-md border border-border bg-background px-2 text-right font-mono text-[11px] text-foreground outline-none focus:border-ring disabled:opacity-50'

const PROPS: { property: AnimatableProperty; label: string; disabled?: boolean }[] = [
  { property: 'x', label: 'X' },
  { property: 'y', label: 'Y' },
  { property: 'rotation', label: 'Rotation' },
  { property: 'scaleX', label: 'Scale X' },
  { property: 'scaleY', label: 'Scale Y' },
  { property: 'opacity', label: 'Opacity (soon)', disabled: true },
]

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100
  return Number.isFinite(r) ? String(r) : '0'
}

function PropertyRow({
  targetId,
  property,
  label,
  base,
  disabled,
  shapes,
  time,
}: {
  targetId: string
  property: AnimatableProperty
  label: string
  base: number
  disabled?: boolean
  shapes: ShapeMotion[]
  time: number
}) {
  const kfHere = keyframeAt(shapes, targetId, property, time)
  // The delta at the playhead (offset from rest); end = current + delta.
  const delta = keyframeDelta(shapes, targetId, property, time)
  const end = base + delta

  const [edit, setEdit] = useState<string | null>(null)
  const shown = edit ?? fmt(end)

  const commit = (raw: string): void => {
    setEdit(null)
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) setKeyframeAtPlayhead(targetId, property, n - base)
  }
  const toggle = (): void => {
    if (disabled) return
    if (kfHere) removeKeyframeAtPlayhead(targetId, property)
    else setKeyframeAtPlayhead(targetId, property, delta)
  }

  return (
    <div className="flex h-8 items-center gap-1.5 px-2.5" style={disabled ? { opacity: 0.45 } : undefined}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={kfHere ? `Remove ${label} keyframe` : `Keyframe ${label}`}
        aria-pressed={kfHere != null}
        className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground"
      >
        <span
          className="h-2.5 w-2.5 rotate-45 rounded-[2px]"
          style={kfHere ? { background: ACCENT } : { border: '1.5px solid currentColor' }}
        />
      </button>
      <span className="w-14 shrink-0 truncate text-xs text-muted-foreground">{label}</span>
      <span
        className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70"
        title="Current (rest) value"
      >
        {fmt(base)}
      </span>
      <span className="shrink-0 text-muted-foreground/50" aria-hidden>
        &rarr;
      </span>
      <input
        type="number"
        className={fieldCls}
        value={shown}
        disabled={disabled}
        title="End value — the motion runs current → this"
        onChange={(e) => setEdit(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
        }}
      />
    </div>
  )
}

export function MotionTab() {
  const doc = useSnapshot(docProxy)
  const selectedIds = new Set(doc.selectedIds)
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const shapes = useSignalCoalesced(motionShapes)
  const playing = useSignalCoalesced(motionPlaying)
  const time = useSignalCoalesced(motionTime)
  const loop = useSignalCoalesced(motionLoop)
  const hasMotion = shapes.length > 0

  const pageId = doc.currentPageId ?? (doc.pageMap.size === 1 ? [...doc.pageMap.keys()][0] : null)
  const node = singleId && pageId ? doc.pageMap.get(pageId)?.objects[singleId] : undefined
  const baseFor = (p: AnimatableProperty): number => {
    const n = node as { x?: number; y?: number; rotation?: number; opacity?: number } | undefined
    switch (p) {
      case 'x':
        return typeof n?.x === 'number' ? n.x : 0
      case 'y':
        return typeof n?.y === 'number' ? n.y : 0
      case 'rotation':
        return typeof n?.rotation === 'number' ? n.rotation : 0
      case 'scaleX':
      case 'scaleY':
        // Rest scale is the identity multiplier (1×); the stored keyframe value is
        // the delta from it (end − 1), which the modifier maps back to `1 + delta`.
        return 1
      case 'opacity':
        return typeof n?.opacity === 'number' ? n.opacity : 1
      default:
        return 1
    }
  }

  return (
    <div className="flex min-h-0 flex-col overflow-auto">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        <button
          type="button"
          className={btnCls}
          disabled={!hasMotion}
          onClick={() => (playing ? pauseMotion() : playMotion())}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className={btnCls} disabled={!hasMotion} onClick={stopMotion}>
          Stop
        </button>
        <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={loop} onChange={(e) => setMotionLoop(e.target.checked)} />
          Loop
        </label>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{Math.round(time)} ms</span>
      </div>

      {singleId ? (
        <div className="py-1">
          {PROPS.map((p) => (
            <PropertyRow
              key={p.property}
              targetId={singleId}
              property={p.property}
              label={p.label}
              base={baseFor(p.property)}
              disabled={p.disabled}
              shapes={shapes}
              time={time}
            />
          ))}
          <p className="px-2.5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            Each row is <span className="text-foreground">current &rarr; end</span>. To make it move: scrub the playhead
            to a later time, then <span className="text-foreground">drag the shape on the canvas</span> to where it
            should end up (or type an end value). A rest keyframe is added at the start automatically, so it animates
            current &rarr; there.
          </p>
        </div>
      ) : (
        <p className="px-2.5 py-3 text-[11px] text-muted-foreground">Select a single shape to animate.</p>
      )}

      <ParametersPanel targetId={singleId} />
    </div>
  )
}
