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
import { movePreviewWorldDelta, pointerPos, signalToObservable, viewport, worldPointerPos } from '../signals/pointer'
import { querySelectionRect, wasmSelectionRect as wasmSelRect } from '../signals/selection'
import { dragStopper } from '../streams/drag-stopper'
import { useWorkspaceStore } from '../store/workspace-store'
import { getModifierKeys } from '../store/shortcuts-store'
import { isSnapPixelGridEnabled } from '../store/workspace-settings'
import { snapMoveDeltaToGrid } from './pixel-snap'
import { getSelectedIdsSet } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { applyModifiersAndCommit } from './utils'
import { motionAnimatedMatrix, recordDragKeyframe } from '../motion/motion-store'
import { DRAG_RENDER_INTERVAL_MS } from './drag-render-interval'
import {
  cloneSelectionRect,
  finiteSelectionRect,
  translateSelectionRectWorld,
} from './selection-rect-helpers'
import { composeMatrix, identityMatrix, translateMatrix } from '../geom/matrix'
import {
  buildCommitStructureEntries,
  buildLayoutDetachEntries,
  buildReparentPreviewEntries,
  collectReflowParents,
  collectTextGrowTypes,
  detectReparentTargets,
} from './reparent-detection'
import { resolveDropIntent } from './drop-intent'
import {
  createDropPlaceholder,
  positionDropPlaceholder,
  reattachDropPlaceholder,
  destroyDropPlaceholder,
  type DropPlaceholder,
} from './drop-placeholder'
import { dropIntentSignal, clearDropIntent } from '../signals/drop-intent'
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
  // Motion authoring: the shape's animated matrix M(t) at the playhead (null
  // unless the Motion tab is open and the playhead is off the rest frame). The
  // drag composes ON TOP of it below.
  const animMatrix =
    selectedIds.size === 1 ? motionAnimatedMatrix(selectedIds.values().next().value as string) : null

  /**
   * The per-frame preview matrix for the dragged shapes. `setWasmModifiers` is
   * replace-all, so while a motion preview is applied a bare translate would wipe
   * M(t) and snap the shape back to its REST SIZE for the whole drag. Composing
   * `translate(drag) ∘ M(t)` keeps the animated scale/rotation and moves the shape
   * from where it visually is. Without motion this is just the plain translate.
   */
  const previewMatrix = (dx: number, dy: number): Matrix => {
    const drag = translateMatrix(dx, dy)
    return animMatrix ? composeMatrix(drag, animMatrix) : drag
  }
  // Pre-compute "remove from real parent" structure entries for any selected
  // shape whose parent has a layout. These are stable across the gesture so we
  // build them once and re-emit each frame after cleanModifiers wipes them.
  // Without these, propagate's parent flex reflow re-pins the dragged shape
  // to its layout slot every frame and the cursor-following preview is dead.
  const layoutDetachEntries = buildLayoutDetachEntries(selectedIds, page)

  // Transient Figma-style drop placeholder (WASM-only, never in docProxy/undo).
  // Created on the first hover over a flex target, moved if the target changes,
  // and destroyed on release/cancel. See handlers/drop-placeholder.ts.
  let placeholder: DropPlaceholder | null = null
  // The exact (target, index) shown by the last preview frame. Reused verbatim at
  // commit so the drop lands where the gap was — recomputing at release can differ
  // because the placeholder (and its gap) is gone and children snap back.
  let lastPreview: { targetId: string; index: number } | null = null
  const destroyPlaceholder = (): void => {
    if (!placeholder) return
    try {
      const docKids = (page.objects[placeholder.targetId] as { shapes?: string[] } | undefined)?.shapes ?? []
      destroyDropPlaceholder(renderer, placeholder, docKids)
    } catch {
      /* ignore */
    }
    placeholder = null
  }

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
      // Set when this frame applies a layout drop-preview probe. The probe's
      // setWasmModifiers already leaves the canvas in the desired state (target
      // siblings reflowed to open the gap; dragged shape translated to the cursor),
      // so we keep it and skip the reset push that would strip the add-children.
      let layoutProbeActive = false

      // 1. Update overlay SYNCHRONOUSLY (like Penpot frontend's set-temporary-selrect).
      //    This runs inside the pointer event microtask, BEFORE any RAF fires.
      if (baselineRect) {
        const preview = translateSelectionRectWorld(baselineRect, worldDelta.x, worldDelta.y)
        wasmSelRect.value = preview
        // Drop-preview: resolve where the selection would land (target + index) so
        // the overlay can draw the ghost + highlight. The insertion index follows
        // the cursor (Figma-style), not the shape's center — falls back to the
        // moved center only if the pointer isn't available.
        const cursor = worldPointerPos.value ?? undefined
        const point = cursor ?? { x: baselineRect.center.x + worldDelta.x, y: baselineRect.center.y + worldDelta.y }
        const intent = resolveDropIntent(selectedIds, page, point)

        // Reparent detection (cursor-based) drives BOTH the faithful "held shape"
        // snapshot overlay and the flex gap preview. It returns a target only when
        // the container differs from the shape's current parent — genuine
        // reparenting, not a same-parent reorder.
        const probeTargets = detectReparentTargets(selectedIds, page, worldDelta, cursor)
        const firstTarget = probeTargets.values().next().value as
          | { parentId: string; index: number }
          | undefined

        // Figma-style preview: the real shapes float under the cursor (a plain
        // translate), while a transient placeholder is inserted into the flex
        // target so the engine reflows the siblings to open a gap. The layout
        // engine owns the placeholder's position, so we query it back for the
        // ghost footprint. Guarded so a failure just falls back to the provisional.
        // The lift and the gap preview are two independent concerns:
        //  - Lift on top: runs for ANY reparent target (a `firstTarget`).
        //  - Gap placeholder: layout targets only (they reflow siblings to open
        //    a gap; a non-layout parent has nothing to reflow).
        if (firstTarget) {
          try {
            if (intent?.hasLayout) {
              const objsAll = page.objects as Record<string, { shapes?: string[] }>
              // Normalize to sibling-space: exclude the dragged shapes so the
              // placeholder splices among clean siblings — identical to a drag from
              // outside. A dragged shape that IS a child here (same-parent reorder)
              // is appended so WASM keeps it (dropping it from set_children would
              // delete it); the lift then moves it to the front, out of flow.
              const rawKids = objsAll[firstTarget.parentId]?.shapes ?? []
              const siblings = rawKids.filter((id) => !selectedIds.has(id))
              const draggedHere = rawKids.filter((id) => selectedIds.has(id))
              const targetDocKids = draggedHere.length > 0 ? [...siblings, ...draggedHere] : siblings
              // Sibling-space drop index (0..siblings.length), from computeDropIndex
              // on the resting document positions (placeholder-free, so it's stable).
              const dropIndex = firstTarget.index
              lastPreview = { targetId: firstTarget.parentId, index: dropIndex }
              // Ensure the placeholder exists, lives in the current target, and sits
              // at the drop index (so the gap opens where the shape lands).
              if (!placeholder) {
                // Clone the dragged shape as a faded ghost (single primitive); fall
                // back to a rect sized to the selection bounds otherwise.
                const bx = baselineRect.center.x - baselineRect.width / 2
                const by = baselineRect.center.y - baselineRect.height / 2
                const fallbackSelrect = {
                  x: bx,
                  y: by,
                  x1: bx,
                  y1: by,
                  x2: bx + baselineRect.width,
                  y2: by + baselineRect.height,
                  width: baselineRect.width,
                  height: baselineRect.height,
                }
                placeholder = createDropPlaceholder(
                  renderer,
                  firstTarget.parentId,
                  targetDocKids,
                  { objects: page.objects, selectedIds, fallbackSelrect },
                  dropIndex,
                )
              } else if (placeholder.targetId !== firstTarget.parentId) {
                // Restore the old target to its full document list (keep the dragged
                // shape referenced so WASM doesn't delete it while it's lifted).
                const oldDocKids = objsAll[placeholder.targetId]?.shapes ?? []
                placeholder = reattachDropPlaceholder(
                  renderer,
                  placeholder,
                  oldDocKids,
                  firstTarget.parentId,
                  targetDocKids,
                  dropIndex,
                )
              } else {
                placeholder = positionDropPlaceholder(renderer, placeholder, targetDocKids, dropIndex)
              }
            } else {
              // Non-layout target: nothing reflows, so no placeholder gap — but the
              // drop still lands at the resolved (append) index.
              destroyPlaceholder()
              lastPreview = { targetId: firstTarget.parentId, index: firstTarget.index }
            }

            // Lift on top: pull the dragged shapes out of their source and add them
            // to the target at index 0, so the tiled renderer paints them ON TOP of
            // the target's content — real shapes, crisp at any size. Mark them
            // layout-absolute (a no-op on a non-layout parent) so a flex/grid target
            // skips them in its flow; they track the cursor via the translate below.
            // Reflow the target (identity) so a layout placeholder opens its gap.
            // All transient — `cleanModifiers` reverts it on release, and the real
            // reparent commits at the calculated index.
            const previewStructure = buildReparentPreviewEntries(selectedIds, page, firstTarget.parentId)
            const probeReflow = collectReflowParents(selectedIds, page, probeTargets)
            const probeEntries: Array<[string, Matrix]> = [
              ...Array.from(selectedIds, (id) => [id, previewMatrix(worldDelta.x, worldDelta.y)] as [string, Matrix]),
              ...Array.from(probeReflow, (id) => [id, identityMatrix()] as [string, Matrix]),
            ]
            renderer.setWasmModifiers(probeEntries, {
              structureModifiers: previewStructure,
              absoluteModifiers: Array.from(selectedIds),
            })
            layoutProbeActive = true

            // Ghost = where the placeholder landed (the opened gap); layout only.
            const gap = placeholder ? querySelectionRect(renderer, [placeholder.id]) : null
            if (gap && intent) {
              intent.footprint = {
                x: gap.center.x - gap.width / 2,
                y: gap.center.y - gap.height / 2,
                width: gap.width,
                height: gap.height,
              }
            }
          } catch {
            // keep the provisional footprint
          }
        } else {
          // Not over any reparent target — no lift, no gap.
          destroyPlaceholder()
          lastPreview = null
        }
        dropIntentSignal.value = intent
      }

      // Unified gesture push: clean → set-structure → propagate('child') → set
      // → mirror to modifierOverlay store. Mirrors CLJS `set-wasm-modifiers`
      // (modifiers.cljs:612-642). cleanModifiers wipes pool.structure too, so
      // detach entries are re-emitted every frame via the options bag.
      // The overlay preview above translates baselineRect by the drag alone --
      // seekMotion already refreshed it to the animated (displaced, scaled) rect,
      // so it needs no motion term. The shape modifier does: it composes the drag
      // over M(t) so the animated pose survives the gesture (see previewMatrix).
      const moveEntries: Array<[string, Matrix]> = Array.from(selectedIds, (id) => [
        id,
        previewMatrix(worldDelta.x, worldDelta.y),
      ])
      // Skip the reset push when a probe is active: it already rendered the
      // reflowed-siblings + cursor-following-shape state, and re-pushing without the
      // add-children structure would snap the siblings back to their base positions.
      if (!layoutProbeActive) {
        renderer.setWasmModifiers(moveEntries, {
          structureModifiers: layoutDetachEntries.length > 0 ? layoutDetachEntries : undefined,
        })
      }

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
      clearDropIntent()
      // Tear down the transient placeholder before committing so the target's
      // WASM child list is back to the document list when the real reparent lands.
      destroyPlaceholder()
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
      // geometry for. This bundles `mov-objects` into the same commit call. The
      // insertion index follows the cursor (matches the drop-preview), so the drop
      // lands where the ghost showed instead of always appending.
      const finalTargets = detectReparentTargets(selectedIds, page, delta, worldPointerPos.value ?? undefined)
      // Land the drop where the preview gap was: reuse the exact index the last
      // preview frame showed. (detectReparentTargets already recomputes the same
      // wrap-aware index from resting positions, but reusing lastPreview guarantees
      // release == what the user saw.)
      for (const t of finalTargets.values()) {
        if (lastPreview && t.parentId === lastPreview.targetId) {
          t.index = lastPreview.index
        }
      }
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
