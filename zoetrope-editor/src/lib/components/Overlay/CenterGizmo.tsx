/**
 * CenterGizmo — selection chrome anchored to the shape's CENTRE rather than to
 * its bounds.
 *
 * The bounds-derived chrome lives inside `translate(centre) matrix(a,b,c,d,0,0)`,
 * whose linear part goes singular when a motion animates `scale` to 0 (a = d = 0)
 * — collapsing every child to a point, so the box and handles become
 * un-grabbable. This gizmo is mounted under a TRANSLATE-ONLY group, so it is
 * immune: the centre is `transformPoint(M(t), restCentre)`, which stays valid
 * even when the transform is singular (it is the very pivot the motion rotates
 * and scales about).
 *
 * Two roles, following the Figma-style dual model:
 *  - always: a small pivot dot, so the user can SEE what rotation/scale turn
 *    about while authoring motion (purely informational, never takes pointers,
 *    so it can't swallow the double-click that enters text editing).
 *  - when the bounds are degenerate: a floored, constant-size box plus move and
 *    rotate grabs — the affordance that keeps a collapsed shape manipulable.
 *
 * Everything is authored in screen px and divided by `zoom`, so the gizmo keeps
 * a constant on-screen size at any zoom level.
 */

import type { ResizeHandlePosition } from '../../renderer/types'
import { HANDLE_FILL, HANDLE_STROKE, SELECTION_STROKE } from './constants'

/** Side of the fallback box, in screen px. */
const GIZMO_BOX_SCREEN = 28
/** Pivot dot radius, in screen px. */
const PIVOT_DOT_RADIUS_SCREEN = 2.5
/** Gap between the box top edge and the rotation grab, in screen px. */
const ROTATE_OFFSET_SCREEN = 14
/** Rotation grab radius, in screen px. */
const ROTATE_GRAB_RADIUS_SCREEN = 6

export interface CenterGizmoProps {
  /** Shape centre in world coords — `transformPoint(M(t), restCentre)`. */
  center: { x: number; y: number }
  zoom: number
  /**
   * True when the bounds-derived chrome is unusable (scale→0, sub-pixel, or
   * zoomed far out). Turns the gizmo from an informational dot into the
   * interactive fallback.
   */
  degenerate: boolean
  /** Whether the rotate grab may be shown (rotation authoring is keyframe-aware). */
  allowRotate?: boolean
  overrideCursor?: string | null
  onMovePointerDown: (e: React.PointerEvent) => void
  onRotationPointerDown: (e: React.PointerEvent, position: ResizeHandlePosition) => void
}

export function CenterGizmo({
  center,
  zoom,
  degenerate,
  allowRotate = true,
  overrideCursor,
  onMovePointerDown,
  onRotationPointerDown,
}: CenterGizmoProps) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const dot = PIVOT_DOT_RADIUS_SCREEN / safeZoom
  const half = GIZMO_BOX_SCREEN / 2 / safeZoom
  const strokeWidth = 1 / safeZoom

  return (
    <g transform={`translate(${center.x},${center.y})`}>
      {degenerate && (
        <>
          <rect
            x={-half}
            y={-half}
            width={half * 2}
            height={half * 2}
            fill="transparent"
            stroke={SELECTION_STROKE}
            strokeWidth={strokeWidth}
            strokeDasharray={`${4 / safeZoom} ${3 / safeZoom}`}
            style={{ pointerEvents: 'auto', cursor: overrideCursor ?? 'move' }}
            onPointerDown={onMovePointerDown}
          />
          {allowRotate && (
            <circle
              cx={0}
              cy={-half - ROTATE_OFFSET_SCREEN / safeZoom}
              r={ROTATE_GRAB_RADIUS_SCREEN / safeZoom}
              fill={HANDLE_FILL}
              stroke={HANDLE_STROKE}
              strokeWidth={strokeWidth}
              style={{ pointerEvents: 'auto', cursor: overrideCursor ?? 'grab' }}
              onPointerDown={(e) => onRotationPointerDown(e, 'top-right')}
            />
          )}
        </>
      )}
      <circle cx={0} cy={0} r={dot} fill={SELECTION_STROKE} style={{ pointerEvents: 'none' }} />
    </g>
  )
}
