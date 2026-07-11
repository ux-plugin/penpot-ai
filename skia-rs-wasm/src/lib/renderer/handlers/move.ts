/**
 * Move handler
 * Ported from frontend/src/app/main/data/workspace/transforms.cljs start-move-selected
 * Uses WASM modifiers for preview during drag; commits on pointer up. Shift constrains to one axis.
 *
 * Architecture (matching Penpot frontend):
 * - Overlay (selection rect SVG) is updated SYNCHRONOUSLY from each pointer event
 * - WASM canvas render is scheduled ASYNC via requestRender (RAF-coalesced)
 * - This ensures the overlay is always responsive even when _render blocks (~55ms)
 *
 * Reparent during drag (mirrors CLJS set-wasm-modifiers at modifiers.cljs:634):
 * - Per-frame, when the projected drop target changes, the structure modifiers
 *   (layout-detach entries) are passed to `renderer.setWasmModifiers` via its
 *   options bag, so propagate_modifiers reflows flex/grid containers live.
 * - On pointer-up, fold mov-objects into the same commitChanges bundle as the
 *   move's mod-obj changes — single undo frame per gesture.
 */

import { Observable, EMPTY, merge } from 'rxjs'
import { map, filter, takeUntil, tap, take, scan } from 'rxjs/operators'
import { movePreviewWorldDelta, pointerPos, signalToObservable, viewport } from '../signals/pointer'
import { querySelectionRect, wasmSelectionRect as wasmSelRect } from '../signals/selection'
import { dragStopper } from '../streams/drag-stopper'
import { useWorkspaceStore } from '../store/workspace-store'
import { getModifierKeys } from '../store/shortcuts-store'
import { isSnapPixelGridEnabled } from '../store/workspace-settings'
import { snapMoveDeltaToGrid } from './pixel-snap'
import { getSelectedIdsSet } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { applyModifiersAndCommit } from './utils'
import { motionDragBase, recordDragKeyframe } from '../motion/motion-store'
import { DRAG_RENDER_INTERVAL_MS } from './drag-render-interval'
import {
  cloneSelectionRect,
  finiteSelectionRect,
  translateSelectionRectWorld,
} from './selection-rect-helpers'
import { identityMatrix, translateMatrix } from '../geom/matrix'
import {
  buildCommitStructureEntries,
  buildLayoutDetachEntries,
  collectReflowParents,
  collectTextGrowTypes,
  detectReparentTargets,
} from './reparent-detection'
import type { Point } from '../types'
import type { Matrix } from 'penpot-exporter/types'

function constrainDeltaByShift(delta: { x: number; y: number }): { x: number; y: number } {
  const keys = getModifierKeys()
  if (!keys.shift) return delta
  const xDisp = Math.abs(delta.x) > Math.abs(delta.y)
  if (xDisp) return { x: delta.x, y: 0 }
  return { x: 0, y: delta.y }
}

export function startMoveSelected(initialPosition: Point): Observable<void> {
  const { renderer } = useWorkspaceStore.getState()
  const vp = viewport.value
  const selectedIds = getSelectedIdsSet()
  const pageId = getActiveOrSinglePageId()

  if (!renderer || !vp || selectedIds.size === 0 || !pageId) return EMPTY

  const page = getPage(pageId)
  if (!page) return EMPTY

  movePreviewWorldDelta.value = { x: 0, y: 0 }

  const stopper = dragStopper()
  const zoom = vp.zoom

  const modifiersAppliedRef = { current: false }
  let lastRenderRequestTs = 0

  // Pre-drag WASM selection rect captured at drag start (for overlay positioning).
  const baselineRect = finiteSelectionRect(wasmSelRect.peek())
    ? cloneSelectionRect(wasmSelRect.peek()!)
    : null

  // Pre-drag selection top-left in world units; non-null only when pixel snap is
  // on (and we have a finite baseline), in which case the move delta is rounded
  // so the selection steps on the whole-pixel grid. Snapping the delta (rather
  // than the WASM `pixelPrecision` flag) keeps this handler's TS-computed overlay
  // in lockstep with the committed geometry and leaves the size untouched.
  const snapBaseTopLeft =
    isSnapPixelGridEnabled() && baselineRect
      ? {
          x: baselineRect.center.x - baselineRect.width / 2,
          y: baselineRect.center.y - baselineRect.height / 2,
        }
      : null

  const lastEventDeltaRef = { current: { x: 0, y: 0 } }
  // Motion authoring: the shape's current animated offset from rest at the
  // playhead (null unless the Motion tab is open and the playhead is off the
  // rest frame). Added to the drag below so the shape follows the cursor from
  // its displaced pose instead of snapping to rest.
  const motionBase =
    selectedIds.size === 1 ? motionDragBase(selectedIds.values().next().value as string) : null
  // Pre-compute "remove from real parent" structure entries for any selected
  // shape whose parent has a layout. These are stable across the gesture so we
  // build them once and re-emit each frame after cleanModifiers wipes them.
  // Without these, propagate's parent flex reflow re-pins the dragged shape
  // to its layout slot every frame and the cursor-following preview is dead.
  const layoutDetachEntries = buildLayoutDetachEntries(selectedIds, page)

  const DRAG_THRESHOLD_SCREEN_PX = 5
  const moveStream = signalToObservable(pointerPos).pipe(
    filter((pos): pos is NonNullable<typeof pos> => pos !== null),
    map((pos) => ({
      x: pos.x - initialPosition.x,
      y: pos.y - initialPosition.y,
    })),
    scan(
      (acc: { delta: { x: number; y: number }; activated: boolean }, delta) => {
        const mag = Math.sqrt(delta.x ** 2 + delta.y ** 2)
        return { delta, activated: acc.activated || mag > DRAG_THRESHOLD_SCREEN_PX }
      },
      { delta: { x: 0, y: 0 }, activated: false } as { delta: { x: number; y: number }; activated: boolean }
    ),
    filter(({ activated }) => activated),
    map(({ delta }) => delta),
    map((delta) => ({
      x: delta.x / zoom,
      y: delta.y / zoom,
    })),
    map(constrainDeltaByShift),
    map((worldDelta) => snapMoveDeltaToGrid(worldDelta, snapBaseTopLeft, getModifierKeys().shift)),
    tap((worldDelta) => {
      modifiersAppliedRef.current = true
      lastEventDeltaRef.current = { x: worldDelta.x, y: worldDelta.y }
      movePreviewWorldDelta.value = worldDelta

      // 1. Update overlay SYNCHRONOUSLY (like Penpot frontend's set-temporary-selrect).
      //    This runs inside the pointer event microtask, BEFORE any RAF fires.
      if (baselineRect) {
        const preview = translateSelectionRectWorld(baselineRect, worldDelta.x, worldDelta.y)
        wasmSelRect.value = preview
      }

      // Unified gesture push: clean → set-structure → propagate('child') → set
      // → mirror to modifierOverlay store. Mirrors CLJS `set-wasm-modifiers`
      // (modifiers.cljs:612-642). cleanModifiers wipes pool.structure too, so
      // detach entries are re-emitted every frame via the options bag.
      // baselineRect (the overlay preview above) already includes motionBase --
      // seekMotion refreshes it to the animated rect -- so the overlay uses the
      // drag delta alone. The shape modifier, however, translates from the
      // document (rest) pose, so it must add motionBase to stay under the cursor.
      const renderDelta = motionBase
        ? { x: worldDelta.x + motionBase.x, y: worldDelta.y + motionBase.y }
        : worldDelta
      const moveEntries: Array<[string, Matrix]> = Array.from(selectedIds, (id) => [
        id,
        translateMatrix(renderDelta.x, renderDelta.y),
      ])
      renderer.setWasmModifiers(moveEntries, {
        structureModifiers: layoutDetachEntries.length > 0 ? layoutDetachEntries : undefined,
      })

      // 4. Throttle canvas render (~60 Hz); overlay still updates every pointer event.
      const now = performance.now()
      if (now - lastRenderRequestTs >= DRAG_RENDER_INTERVAL_MS) {
        lastRenderRequestTs = now
        renderer.requestRenderFrame()
      }

    }),
    map(() => undefined),
    takeUntil(stopper)
  )

  const commitOnRelease = stopper.pipe(
    take(1),
    tap(() => {
      if (!modifiersAppliedRef.current) {
        movePreviewWorldDelta.value = { x: 0, y: 0 }
        renderer.cleanModifiers()
        return
      }
      const delta = lastEventDeltaRef.current

      // Motion authoring: with the Motion tab open and the playhead off the rest
      // frame, a single-shape drag becomes an x/y keyframe (an offset from rest)
      // instead of a document move. The motion preview then owns the modifiers,
      // so we neither cleanModifiers nor commit geometry -- seekMotion (inside
      // recordDragKeyframe) has already replaced the drag modifiers with the
      // animated pose at the playhead.
      if (selectedIds.size === 1) {
        const onlyId = selectedIds.values().next().value as string
        if (recordDragKeyframe(onlyId, delta.x, delta.y)) {
          movePreviewWorldDelta.value = { x: 0, y: 0 }
          wasmSelRect.value = querySelectionRect(renderer, selectedIds)
          return
        }
      }

      // Compute the final reparent intent against the same delta we'll commit
      // geometry for. This bundles `mov-objects` into the same commit call.
      const finalTargets = detectReparentTargets(selectedIds, page, delta)
      const structureModifiers =
        finalTargets.size > 0 ? buildCommitStructureEntries(finalTargets, page) : undefined
      const textGrowTypes = collectTextGrowTypes(selectedIds, page)

      // Same identity-reflow trick as the per-frame path so the new target
      // parent (and the source parent) reflow during the final propagate.
      const reflowParents = collectReflowParents(selectedIds, page, finalTargets)
      const moveEntries: Array<[string, Matrix]> = [
        ...Array.from(selectedIds).map((id) => [id, translateMatrix(delta.x, delta.y)] as [string, Matrix]),
        ...Array.from(reflowParents, (id) => [id, identityMatrix()] as [string, Matrix]),
      ]

      applyModifiersAndCommit(moveEntries, {
        reparentTargets: finalTargets.size > 0 ? finalTargets : undefined,
        structureModifiers,
        textGrowTypes: textGrowTypes.size > 0 ? textGrowTypes : undefined,
      })
        .then(() => {
          renderer.cleanModifiers()
          renderer.flushRenderSync()
          wasmSelRect.value = querySelectionRect(renderer, selectedIds)
          movePreviewWorldDelta.value = { x: 0, y: 0 }
        })
        .catch(() => {
          renderer.cleanModifiers()
          renderer.flushRenderSync()
          wasmSelRect.value = querySelectionRect(renderer, selectedIds)
          movePreviewWorldDelta.value = { x: 0, y: 0 }
        })
    }),
    map(() => undefined)
  )

  return merge(moveStream, commitOnRelease) as Observable<void>
}
