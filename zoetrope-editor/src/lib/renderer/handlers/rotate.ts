/**
 * Rotation handler
 * When the user drags from the rotation hit area, the selected shape rotates so its angle follows
 * the cursor (angle from selection center to cursor). Preview via setMoveModifiers(rotation matrix);
 * commit node.rotation on pointer up.
 *
 * Overlay + property panel stay in sync with the pointer (same pattern as move.ts): synchronous
 * `wasmSelRect` from `querySelectionRect` after each `renderer.setWasmModifiers` so the post-
 * propagate (incl. flex/grid reflow) bounds are reflected; throttled `requestRenderFrame`
 * so `_render` does not block overlay updates.
 */

import { Observable, EMPTY, merge } from 'rxjs'
import { map, filter, takeUntil, tap, take } from 'rxjs/operators'
import { pointerPos, rotatePreviewDeltaDeg, signalToObservable, viewport } from '../signals/pointer'
import { querySelectionRect, wasmSelectionRect as wasmSelRect } from '../signals/selection'
import { dragStopper } from '../streams/drag-stopper'
import { getSelectedIdsSet } from '../store/document-selection'
import { useWorkspaceStore } from '../store/workspace-store'
import { getCurrentPage } from '../store/doc-proxy'
import { screenToWorld } from '../viewport'
import { applyModifiersAndCommit } from './utils'
import { DRAG_RENDER_INTERVAL_MS } from './drag-render-interval'
import {
  applyMatrixToSelectionRect,
  cloneSelectionRect,
  finiteSelectionRect,
  rotateSelectionRectAroundPivot,
} from './selection-rect-helpers'
import { composeMatrix, rotationMatrixAroundPoint, transformPoint } from '../geom/matrix'
import { getWorkspaceWasmTransform } from '../store/modifier-overlay'
import { motionAnimatedMatrix, recordRotateKeyframe } from '../motion/motion-store'
import type { Point } from '../types'
import type { Matrix } from 'penpot-exporter/types'
import type { IndexedNode } from '../../worker/types'

function angleDegFromCenter(cx: number, cy: number, wx: number, wy: number): number {
  return Math.atan2(wy - cy, wx - cx) * (180 / Math.PI)
}

export function startRotateSelected(initialPosition: Point): Observable<void> {
  const { renderer } = useWorkspaceStore.getState()
  const vp = viewport.value
  const selectedIds = getSelectedIdsSet()

  if (!renderer || !vp || selectedIds.size < 1) {
    return EMPTY
  }

  const ids = Array.from(selectedIds)
  if (!finiteSelectionRect(wasmSelRect.peek())) {
    wasmSelRect.value = querySelectionRect(renderer, ids)
  }
  const isSingle = ids.length === 1
  const pageObjects = getCurrentPage()?.objects
  const selectedNodes = ids
    .map((id) => pageObjects?.[id])
    .filter((node): node is IndexedNode => node !== undefined)
  const singleNode = selectedNodes[0]

  if (isSingle) {
    if (!singleNode || singleNode.id !== ids[0] || !singleNode.selrect) {
      return EMPTY
    }
  }

  let cx: number
  let cy: number

  if (isSingle && singleNode?.selrect) {
    const sr = singleNode.selrect
    const x = (sr as { x?: number }).x ?? 0
    const y = (sr as { y?: number }).y ?? 0
    const w = (sr as { width?: number }).width ?? 0
    const h = (sr as { height?: number }).height ?? 0
    cx = x + w / 2
    cy = y + h / 2
  } else {
    const wr = wasmSelRect.peek()
    if (!wr) return EMPTY
    cx = wr.center.x
    cy = wr.center.y
  }

  const baselineRect = finiteSelectionRect(wasmSelRect.peek())
    ? cloneSelectionRect(wasmSelRect.peek()!)
    : null

  // Motion authoring: the shape's animated matrix M(t) at the playhead (null unless
  // the Motion tab is open and the playhead is off the rest frame). The gesture
  // composes ON TOP of it, so the animated scale/translation survives the rotation
  // instead of being wiped by the replace-all `setWasmModifiers`.
  const animMatrix = isSingle ? motionAnimatedMatrix(ids[0]) : null
  // Gesture pivot = the shape's VISIBLE centre. M(t) maps the rest centre to where
  // the shape is drawn, so that is what the user is rotating about. This is also
  // exactly consistent with the commit: R(animCentre, θ) ∘ M(t) equals adding θ to
  // the motion's rotation (which pivots about the rest centre), because M(t)
  // translates the rest centre onto the animated one.
  const pivot = animMatrix ? transformPoint(animMatrix, cx, cy) : { x: cx, y: cy }

  const initialWorld = screenToWorld(vp, initialPosition.x, initialPosition.y)
  const initialAngleDeg = angleDegFromCenter(pivot.x, pivot.y, initialWorld.x, initialWorld.y)

  const stopper = dragStopper()
  const latestDeltaDegRef = { current: 0 }
  const modifiersAppliedRef = { current: false }
  const commitDoneRef = { current: false }
  let lastRenderRequestTs = 0

  const rotateStream = signalToObservable(pointerPos).pipe(
    filter((pos): pos is NonNullable<typeof pos> => pos !== null),
    map((pos) => screenToWorld(vp, pos.x, pos.y)),
    map((world) => angleDegFromCenter(pivot.x, pivot.y, world.x, world.y)),
    map((currentAngleDeg) => currentAngleDeg - initialAngleDeg),
    tap((deltaDeg) => {
      if (commitDoneRef.current) return
      latestDeltaDegRef.current = deltaDeg
      modifiersAppliedRef.current = true

      rotatePreviewDeltaDeg.value = deltaDeg

      // Compose the gesture over the animated pose so scale/translation survive;
      // without motion this is the plain rotation about the rest centre.
      const gesture = rotationMatrixAroundPoint(pivot.x, pivot.y, deltaDeg)
      const matrix = animMatrix ? composeMatrix(gesture, animMatrix) : gesture
      const entries: Array<[string, Matrix]> = ids.map((id) => [id, matrix])
      renderer.setWasmModifiers(entries)

      // Derive the preview rect JS-side from the propagated matrix in
      // `modifierOverlay.workspaceWasmModifiers`. setWasmModifiers populated
      // it with the rotation composed with flex/grid reflow on the parent —
      // applying it to the baseline rect gives the post-flex preview without
      // a `querySelectionRect` round-trip. For multi-selection we still need
      // the WASM bounds query (each shape's bounds are unioned there);
      // single-selection (the common case) reads the map directly.
      let nextRect = null
      if (animMatrix && baselineRect) {
        // Baseline already reflects the animated pose, so rotate it by the drag
        // alone (about the visible centre) -- composing the full matrix here would
        // double-count M(t).
        nextRect = rotateSelectionRectAroundPivot(baselineRect, pivot.x, pivot.y, deltaDeg)
      } else if (baselineRect && ids.length === 1) {
        const propagated = getWorkspaceWasmTransform(ids[0])
        if (propagated) {
          nextRect = applyMatrixToSelectionRect(baselineRect, propagated)
        }
      }
      if (!nextRect) {
        const queried = querySelectionRect(renderer, ids)
        if (finiteSelectionRect(queried)) nextRect = queried
        else if (baselineRect) {
          nextRect = rotateSelectionRectAroundPivot(baselineRect, cx, cy, deltaDeg)
        }
      }
      if (nextRect) wasmSelRect.value = nextRect

      const now = performance.now()
      if (now - lastRenderRequestTs >= DRAG_RENDER_INTERVAL_MS) {
        lastRenderRequestTs = now
        renderer.requestRenderFrame()
      }
    }),
    map(() => undefined),
    takeUntil(stopper),
  )

  const commitOnRelease = stopper.pipe(
    take(1),
    tap(() => {
      rotatePreviewDeltaDeg.value = 0
      if (!modifiersAppliedRef.current) {
        return
      }
      const deltaDeg = latestDeltaDegRef.current

      // Motion authoring: with the Motion tab open and the playhead off the rest
      // frame, a single-shape rotation becomes a rotation keyframe (a delta from
      // rest) instead of a document rotation. The motion preview then owns the
      // modifiers -- seekMotion (inside recordRotateKeyframe) has already replaced
      // the drag modifier with the animated pose -- so we neither cleanModifiers
      // nor commit geometry.
      if (isSingle && recordRotateKeyframe(ids[0], deltaDeg)) {
        commitDoneRef.current = true
        wasmSelRect.value = querySelectionRect(renderer, ids)
        return
      }

      const matrix = rotationMatrixAroundPoint(cx, cy, deltaDeg)
      const entries: Array<[string, Matrix]> = ids.map((id) => [id, matrix])
      applyModifiersAndCommit(entries)
        .then(() => {
          commitDoneRef.current = true
          renderer.cleanModifiers()
          renderer.flushRenderSync()
          wasmSelRect.value = querySelectionRect(renderer, ids)
          requestAnimationFrame(() => renderer.requestRenderFrame())
        })
        .catch(() => {
          renderer.cleanModifiers()
          renderer.flushRenderSync()
          wasmSelRect.value = querySelectionRect(renderer, ids)
          requestAnimationFrame(() => renderer.requestRenderFrame())
        })
    }),
    map(() => undefined),
  )

  return merge(rotateStream, commitOnRelease) as Observable<void>
}
