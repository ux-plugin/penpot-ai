/**
 * Inspector → Motion tab. First slice of the timeline authoring UI: playback
 * transport (play / pause / stop, loop) for the page's motion clips, plus a
 * quick "animate selected" action that authors a demo clip on the selected
 * shape — enough to exercise the engine → Skia path end-to-end. The full
 * track / keyframe timeline lands next.
 */

import { useMemo } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import { docProxy } from '../../renderer/store/doc-proxy'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import {
  motionClips,
  motionLoop,
  motionPlaying,
  motionTime,
  pauseMotion,
  playMotion,
  setMotionClips,
  setMotionLoop,
  stopMotion,
} from '../../renderer/motion/motion-store'
import type { Clip } from '../../renderer/motion/types'

const btnCls =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40'

/** A visible demo: slide 200px (ease-in-out) and spin 360°, looping. */
function demoClip(targetId: string): Clip {
  return {
    id: `demo-${targetId}`,
    targetId,
    duration: 1000,
    loop: true,
    tracks: [
      { property: 'x', keyframes: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 1000, value: 200 }] },
      { property: 'rotation', keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 360 }] },
    ],
  }
}

export function MotionTab() {
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const clips = useSignalCoalesced(motionClips)
  const playing = useSignalCoalesced(motionPlaying)
  const time = useSignalCoalesced(motionTime)
  const loop = useSignalCoalesced(motionLoop)
  const hasClips = clips.length > 0

  const animateSelected = () => {
    if (!singleId) return
    setMotionClips([demoClip(singleId)])
    setMotionLoop(true)
    playMotion()
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={btnCls}
          disabled={!hasClips}
          onClick={() => (playing ? pauseMotion() : playMotion())}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className={btnCls} disabled={!hasClips} onClick={stopMotion}>
          Stop
        </button>
        <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={loop} onChange={(e) => setMotionLoop(e.target.checked)} />
          Loop
        </label>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{Math.round(time)} ms</span>
      </div>

      <button type="button" className={cn(btnCls, 'w-full')} disabled={!singleId} onClick={animateSelected}>
        Animate selected (demo)
      </button>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {!singleId
          ? 'Select a single shape to animate.'
          : hasClips
            ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · target ${singleId.slice(0, 8)}…`
            : 'Click “Animate selected” to add a demo clip, then Play.'}
      </p>
    </div>
  )
}
