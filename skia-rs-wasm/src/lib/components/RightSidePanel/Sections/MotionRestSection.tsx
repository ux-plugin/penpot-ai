/**
 * Parameters -> Motion. When the selected shape has a motion clip, this section
 * lets you pick which motion (a dropdown -- scaffolding for multiple motions per
 * shape) and slide a player line to choose the shape's *resting pose*: the still
 * frame it shows when the motion isn't playing. Dragging the slider PREVIEWS the
 * pose (seek); RELEASING commits it -- the shape's document home re-bases to that
 * pose (so layout/selection/export follow the rest) and the keyframes shift so
 * the trajectory is unchanged, with no jump. Rendered only when the shape
 * actually has a motion, so shapes without one show no Motion section.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Home } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { useSignalCoalesced } from '@/lib/renderer/signals/use-signal-coalesced'
import { commitMotionRestFrame, motionShapes, previewMotionRestFrame } from '@/lib/renderer/motion/motion-store'

export interface MotionRestSectionProps {
  nodeId: string
}

export function MotionRestSection({ nodeId }: MotionRestSectionProps) {
  const shapes = useSignalCoalesced(motionShapes)
  const targetShapes = shapes.filter((s) => s.targetId === nodeId)
  const active = targetShapes[0]
  const [collapsed, setCollapsed] = useState(false)
  // While dragging the slider, the pending (previewed) rest; committed on release.
  const [pending, setPending] = useState<number | null>(null)

  // No motion on this shape -> no section (matches the other conditional sections).
  if (!active) return null

  const restMax = Math.max(1000, active.timeline.duration)
  const restFrame = pending ?? active.restFrame ?? 0

  const commit = (): void => {
    if (pending == null) return
    const v = pending
    void commitMotionRestFrame(nodeId, v).finally(() => setPending(null))
  }

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            Motion
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] text-muted-foreground">Motion</span>
              <select
                className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-ring"
                value={active.timeline.id}
                onChange={() => {
                  /* single motion per shape for now; selector is scaffolding for multi-motion */
                }}
              >
                {targetShapes.map((s, i) => (
                  <option key={s.timeline.id} value={s.timeline.id}>
                    Motion {i + 1}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Home className="size-3" aria-hidden /> Resting pose
                </span>
                <span className="font-mono">{Math.round(restFrame)} ms</span>
              </div>
              <input
                type="range"
                min={0}
                max={restMax}
                step={1}
                value={restFrame}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setPending(v)
                  previewMotionRestFrame(v)
                }}
                onPointerUp={commit}
                onKeyUp={commit}
                className="w-full accent-[#0d99ff]"
                aria-label="Slide to pick the resting pose; release to set"
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}
