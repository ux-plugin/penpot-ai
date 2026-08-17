/**
 * On-canvas motion path overlay (Slice 5). For a single selected animated shape
 * it draws the spatial trajectory through its position keyframes, read-only
 * keyframe diamonds, and a live playhead dot at the current (paused) pose.
 *
 * The trajectory is anchored to the shape's STABLE committed pose (its selrect
 * center), not to the live selection rect — so while the shape is dragged to
 * author a keyframe, only the keyframe at the playhead (and the path through it)
 * moves, and the rest of the overlay stays pinned. Read-only; geometry comes from
 * `buildMotionPath` (pure, host-tested). Shares SelectionOverlay's world viewBox
 * (via useViewBoxSync); marks are constant screen size (size ÷ zoom). Hidden
 * during active playback and when the paths toggle is off.
 */

import { useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../../renderer/store/doc-proxy'
import { viewport as viewportSignal } from '../../renderer/signals/pointer'
import { wasmSelectionRect as wasmSelectionRectSignal } from '../../renderer/signals/selection'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import {
  motionParams,
  motionPlaying,
  motionShapes,
  motionTime,
  selectedKeyframeTime,
  showMotionPaths,
} from '../../renderer/motion/motion-store'
import { hasMotion } from '../../renderer/motion/animated-pose'
import { buildMotionPath } from '../../renderer/motion/motion-path'
import { finiteSelectionOverlayRect } from './finite-selection-overlay-rect'
import { useViewBoxSync } from './useViewBoxSync'
import { SELECTION_STROKE } from './constants'

export interface MotionPathOverlayProps {
  canvasSize: { width: number; height: number }
}

/** Screen-space sizes (÷ zoom to world) for the constant-size marks. */
const PATH_STROKE_PX = 1.5
const DIAMOND_PX = 7
const PLAYHEAD_RADIUS_PX = 4
const MARK_STROKE_PX = 1

export function MotionPathOverlay({ canvasSize }: MotionPathOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  useViewBoxSync(svgRef, canvasSize)

  const doc = useSnapshot(docProxy)
  // `docProxy.selectedIds` is a Set snapshot — normalize to an array to read it.
  const selectedIds = useMemo(() => [...doc.selectedIds], [doc.selectedIds])
  const wasmSelectionRect = useSignalCoalesced(wasmSelectionRectSignal)
  const viewport = useSignalCoalesced(viewportSignal)
  const shapes = useSignalCoalesced(motionShapes)
  const time = useSignalCoalesced(motionTime)
  const params = useSignalCoalesced(motionParams)
  const isPlaying = useSignalCoalesced(motionPlaying)
  const pathsOn = useSignalCoalesced(showMotionPaths)
  const selected = useSignalCoalesced(selectedKeyframeTime)

  // Gate: exactly one selected shape that carries a motion, paths toggle on, not
  // actively playing, and a finite selection rect + viewport to anchor to.
  const targetId = selectedIds.length === 1 ? selectedIds[0] : null
  const active =
    targetId != null &&
    pathsOn &&
    !isPlaying &&
    hasMotion(targetId) &&
    finiteSelectionOverlayRect(wasmSelectionRect) &&
    viewport != null &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0

  // Stable rest anchor = the committed selrect center, read from the reactive doc
  // snapshot (NOT the live selection rect). It doesn't move while the shape is
  // dragged — only when the document pose actually changes (e.g. rest re-home).
  const restAnchor = useMemo(() => {
    if (!targetId) return null
    const page = doc.currentPageId ? doc.pageMap.get(doc.currentPageId) : undefined
    const node = page?.objects[targetId] as
      | { selrect?: { x: number; y: number; width: number; height: number } }
      | undefined
    const sr = node?.selrect
    return sr ? { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 } : null
  }, [targetId, doc])

  const geom = useMemo(() => {
    if (!active || !wasmSelectionRect || !restAnchor) return null
    const motion = shapes.find((s) => s.targetId === targetId)
    // livePoint = the live selection center; buildMotionPath overlays it onto the
    // current keyframe only while it diverges from the committed pose (a drag).
    return buildMotionPath(motion?.timeline, targetId!, restAnchor, time, wasmSelectionRect.center, params, 48, motion?.restFrame ?? 0)
  }, [active, wasmSelectionRect, restAnchor, shapes, targetId, time, params])

  const zoom = viewport?.zoom ?? 1
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1

  if (!active || !geom || !geom.hasPath || !wasmSelectionRect) {
    return <svg ref={svgRef} aria-hidden style={SVG_STYLE} preserveAspectRatio="xMidYMid meet" />
  }

  const stroke = PATH_STROKE_PX / safeZoom
  const diamond = DIAMOND_PX / safeZoom
  const dot = PLAYHEAD_RADIUS_PX / safeZoom
  const markStroke = MARK_STROKE_PX / safeZoom
  const dash = `${5 / safeZoom} ${4 / safeZoom}`

  // Selection comes from the store's single `selectedKeyframeTime` — the same
  // value the timeline highlights, so canvas + timeline can't disagree.
  const onKeyframe = selected != null
  const pathD = geom.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  return (
    <svg ref={svgRef} aria-hidden style={SVG_STYLE} preserveAspectRatio="xMidYMid meet">
      {/* the trajectory */}
      <path d={pathD} fill="none" stroke={SELECTION_STROKE} strokeWidth={stroke} strokeDasharray={dash} opacity={0.9} />

      {/* keyframe diamonds — the one at the playhead is "current" (filled), others hollow */}
      {geom.keyframes.map((k) => {
        const current = selected != null && k.t === selected
        return (
          <rect
            key={`kf-${k.t}`}
            x={-diamond / 2}
            y={-diamond / 2}
            width={diamond}
            height={diamond}
            transform={`translate(${k.x},${k.y}) rotate(45)`}
            fill={current ? SELECTION_STROKE : 'var(--app-white, #fff)'}
            stroke={SELECTION_STROKE}
            strokeWidth={markStroke}
          />
        )
      })}

      {/* playhead dot for the interpolated pose between keyframes (the current
          keyframe's filled diamond stands in for it when the playhead is on one) */}
      {!onKeyframe && (
        <circle cx={wasmSelectionRect.center.x} cy={wasmSelectionRect.center.y} r={dot} fill={SELECTION_STROKE} />
      )}
    </svg>
  )
}

const SVG_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
} as const
