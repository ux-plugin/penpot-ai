/**
 * Bottom-docked motion timeline. Shows one lane per (shape, property) track with
 * keyframe diamonds positioned by time, a draggable playhead that scrubs
 * (seekMotion), and transport controls. Authoring of keyframes happens in the
 * Motion inspector tab; this panel visualises and scrubs. Mounted via
 * TimelineDock, which is gated on the active inspector tab.
 */

import { useRef, useState } from 'react'
import { inspectorTab } from '../../renderer/signals/inspector-tab'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import {
  motionShapes,
  motionLoop,
  motionPlaying,
  motionTime,
  moveKeyframeTime,
  pauseMotion,
  playMotion,
  seekMotion,
  selectedKeyframeTime,
  setMotionLoop,
  stopMotion,
} from '../../renderer/motion/motion-store'
import type { AnimatableProperty } from '../../renderer/motion/props'

const LABEL_W = 132
const ACCENT = '#0d99ff'
const PLAYHEAD = '#ff5b5b'

const PROP_LABEL: Record<AnimatableProperty, string> = {
  x: 'X',
  y: 'Y',
  rotation: 'Rotation',
  scaleX: 'Scale X',
  scaleY: 'Scale Y',
  opacity: 'Opacity',
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function TimelinePanel() {
  const shapes = useSignalCoalesced(motionShapes)
  const time = useSignalCoalesced(motionTime)
  const playing = useSignalCoalesced(motionPlaying)
  const loop = useSignalCoalesced(motionLoop)
  const selected = useSignalCoalesced(selectedKeyframeTime)

  const duration = Math.max(1000, ...shapes.map((s) => s.timeline.duration))
  const rows = shapes.flatMap((s) =>
    s.timeline.bindings
      .filter((b) => b.curve.domain.kind === 'time') // param-domain bindings live in the parameter panel, not the time ruler
      .map((b) => ({
        targetId: s.targetId,
        property: b.target.prop as AnimatableProperty,
        keys: b.curve.keys,
      })),
  )

  const laneRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [kfDrag, setKfDrag] = useState<{
    targetId: string
    property: AnimatableProperty
    from: number
    time: number
  } | null>(null)
  const kfLaneRef = useRef<HTMLDivElement | null>(null)
  const seekFromClientX = (clientX: number) => {
    const el = laneRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    seekMotion(clamp01((clientX - r.left) / r.width) * duration)
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          disabled={rows.length === 0}
          onClick={() => (playing ? pauseMotion() : playMotion())}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          disabled={rows.length === 0}
          onClick={stopMotion}
        >
          Stop
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">
          {Math.round(time)} / {Math.round(duration)} ms
        </span>
        <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={loop} onChange={(e) => setMotionLoop(e.target.checked)} />
          Loop
        </label>
        <span className="ml-auto text-xs text-muted-foreground">Timeline</span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {/* ruler */}
        <div className="flex h-5 items-center text-[10px] text-muted-foreground">
          <div style={{ width: LABEL_W, flex: 'none' }} className="px-3">
            Tracks
          </div>
          <div className="relative flex-1">
            {ticks.map((f) => (
              <span key={f} className="absolute top-0" style={{ left: `${f * 100}%`, transform: 'translateX(-50%)' }}>
                {Math.round(f * duration)}
              </span>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            No keyframes yet — scrub the playhead to a later time, then drag the shape on the canvas to set where it
            moves to.
          </p>
        ) : (
          rows.map(({ targetId, property, keys }) => (
            <div key={`${targetId}:${property}`} className="flex h-7 items-stretch border-t border-border/60">
              <div
                style={{ width: LABEL_W, flex: 'none' }}
                className="flex items-center gap-1 px-3 text-[11px] text-muted-foreground"
              >
                <span className="text-foreground">{targetId.slice(0, 4)}</span>
                <span className="text-muted-foreground">· {PROP_LABEL[property]}</span>
              </div>
              <div className="relative flex-1 border-l border-border/60">
                {keys.map((k, i) => {
                  const isDrag =
                    kfDrag != null &&
                    kfDrag.targetId === targetId &&
                    kfDrag.property === property &&
                    Math.abs(kfDrag.from - k.at) <= 0.5
                  const t = isDrag ? kfDrag.time : k.at
                  const current = selected != null && t === selected
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-label={`Keyframe at ${Math.round(k.at)} ms${current ? ' (current)' : ''} — drag to retime`}
                      className="group absolute top-1/2 z-10 grid h-4 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center"
                      style={{ left: `${clamp01(t / duration) * 100}%` }}
                      onPointerDown={(e) => {
                        kfLaneRef.current = e.currentTarget.parentElement as HTMLDivElement | null
                        e.currentTarget.setPointerCapture(e.pointerId)
                        setKfDrag({ targetId, property, from: k.at, time: k.at })
                      }}
                      onPointerMove={(e) => {
                        const lane = kfLaneRef.current
                        if (!lane) return
                        const r = lane.getBoundingClientRect()
                        const nt = clamp01((e.clientX - r.left) / r.width) * duration
                        setKfDrag((d) => (d ? { ...d, time: nt } : d))
                      }}
                      onPointerUp={(e) => {
                        if (kfDrag) {
                          if (Math.abs(kfDrag.time - kfDrag.from) < 1) seekMotion(kfDrag.from)
                          else moveKeyframeTime(kfDrag.targetId, kfDrag.property, kfDrag.from, kfDrag.time)
                        }
                        setKfDrag(null)
                        kfLaneRef.current = null
                        try {
                          e.currentTarget.releasePointerCapture(e.pointerId)
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      <span
                        className="h-2.5 w-2.5 rotate-45 rounded-[2px] transition-transform group-hover:scale-125"
                        style={
                          current
                            ? { background: ACCENT, boxShadow: `0 0 0 2px ${ACCENT}33` }
                            : { background: 'var(--background, #fff)', border: `1.5px solid ${ACCENT}`, boxSizing: 'border-box' }
                        }
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          ))
        )}

        {/* scrub strip over the lanes */}
        <div
          ref={laneRef}
          className="absolute top-0 bottom-0"
          style={{ left: LABEL_W, right: 0 }}
          onPointerDown={(e) => {
            dragging.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            seekFromClientX(e.clientX)
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromClientX(e.clientX)
          }}
          onPointerUp={(e) => {
            dragging.current = false
            try {
              e.currentTarget.releasePointerCapture(e.pointerId)
            } catch {
              /* ignore */
            }
          }}
        />

        {/* playhead */}
        <div
          className="pointer-events-none absolute top-0 bottom-0"
          style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${clamp01(time / duration)})`, width: 1, background: PLAYHEAD }}
        >
          <span
            className="absolute top-0"
            style={{ left: -4, width: 9, height: 11, background: PLAYHEAD, borderRadius: '0 0 3px 3px' }}
          />
        </div>
      </div>
    </div>
  )
}

/** Mounts the timeline at the bottom of the canvas when the Motion tab is active. */
export function TimelineDock() {
  const tab = useSignalCoalesced(inspectorTab)
  if (tab !== 'motion') return null
  return (
    <div
      className="pointer-events-auto absolute right-0 bottom-0 left-0 border-t border-border bg-background"
      style={{ height: 188, zIndex: 45 }}
    >
      <TimelinePanel />
    </div>
  )
}
