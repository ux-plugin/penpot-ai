/**
 * Motion badge (Slice 4). A small, selection-gated chip pinned to the top-left
 * corner of a selected animated shape's box. It signals "this shape has motion"
 * and toggles the on-canvas path overlay (filled when paths are shown, outlined
 * when hidden). Shown only when exactly one animated shape is selected and
 * playback is not running.
 *
 * Drawn inside a world-viewBox SVG (same mapping as SelectionOverlay) so it lines
 * up at any zoom; the chip itself is authored in screen pixels via a `scale(1/zoom)`
 * group so it stays a constant size. The chip opts back into pointer events; the
 * rest of the SVG is transparent to them.
 */

import { useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../../renderer/store/doc-proxy'
import { viewport as viewportSignal } from '../../renderer/signals/pointer'
import { wasmSelectionRect as wasmSelectionRectSignal } from '../../renderer/signals/selection'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { motionPlaying, showMotionPaths } from '../../renderer/motion/motion-store'
import { hasMotion } from '../../renderer/motion/animated-pose'
import { finiteSelectionOverlayRect } from './finite-selection-overlay-rect'
import { useViewBoxSync } from './useViewBoxSync'
import { SELECTION_STROKE } from './constants'

export interface MotionBadgeProps {
  canvasSize: { width: number; height: number }
}

const SVG_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
} as const

export function MotionBadge({ canvasSize }: MotionBadgeProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  useViewBoxSync(svgRef, canvasSize)

  const doc = useSnapshot(docProxy)
  // `docProxy.selectedIds` is a Set snapshot — normalize to an array to read it.
  const selectedIds = useMemo(() => [...doc.selectedIds], [doc.selectedIds])
  const wasmSelectionRect = useSignalCoalesced(wasmSelectionRectSignal)
  const viewport = useSignalCoalesced(viewportSignal)
  const isPlaying = useSignalCoalesced(motionPlaying)
  const pathsOn = useSignalCoalesced(showMotionPaths)

  const targetId = selectedIds.length === 1 ? selectedIds[0] : null
  const active =
    targetId != null &&
    !isPlaying &&
    hasMotion(targetId) &&
    finiteSelectionOverlayRect(wasmSelectionRect) &&
    viewport != null &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0

  if (!active || !wasmSelectionRect) {
    return <svg ref={svgRef} aria-hidden style={SVG_STYLE} preserveAspectRatio="xMidYMid meet" />
  }

  // Top-left corner of the (possibly rotated) selection box in world space.
  const { center, width, height, transform } = wasmSelectionRect
  const cornerX = center.x + transform.a * (-width / 2) + transform.c * (-height / 2)
  const cornerY = center.y + transform.b * (-width / 2) + transform.d * (-height / 2)
  const invZoom = 1 / viewport!.zoom

  const toggle = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation()
    e.preventDefault()
    showMotionPaths.value = !showMotionPaths.value
  }

  const chipFill = pathsOn ? SELECTION_STROKE : 'var(--app-white, #fff)'
  const glyph = pathsOn ? 'var(--app-white, #fff)' : SELECTION_STROKE

  return (
    <svg ref={svgRef} aria-hidden style={SVG_STYLE} preserveAspectRatio="xMidYMid meet">
      {/* Screen-px chip authored inside a 1/zoom group so it's constant size.
          Nudged up-left of the corner so it floats just outside the box. */}
      <g transform={`translate(${cornerX},${cornerY}) scale(${invZoom})`}>
        <g
          transform="translate(-2,-14)"
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onPointerDown={toggle}
        >
          <title>{pathsOn ? 'Hide motion path' : 'Show motion path'}</title>
          <circle r={9} fill={chipFill} stroke={SELECTION_STROKE} strokeWidth={1} />
          {/* trajectory glyph: a small curve from a start square to an end dot */}
          <path d="M -4.5 3 Q 0 -5 4.5 -2.5" fill="none" stroke={glyph} strokeWidth={1.3} strokeLinecap="round" />
          <rect x={-5.6} y={1.9} width={2.4} height={2.4} fill={glyph} />
          <circle cx={4.5} cy={-2.5} r={1.7} fill={glyph} />
        </g>
      </g>
    </svg>
  )
}
