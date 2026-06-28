/**
 * Commit partial node updates with paired undo for history (mod-obj assign).
 *
 * Layout-* edits additionally trigger a flex/grid reflow on the affected
 * container: `propagate_modifiers` runs the WASM reflow with the freshly-set
 * flex config, the resulting child transforms are written back to docProxy,
 * and the whole edit lands as a single history frame. Mirrors CLJS
 * `update-layout` (shape_layout.cljs:290) + `update-layout-positions`
 * (shape_layout.cljs:100), where the `:layout/update` event is what builds
 * `(ctm/reflow-modifiers)` and applies them via `apply-wasm-modifiers`.
 */

import { snapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { docProxy } from '../store/doc-proxy'
import {
  appendModObjPair,
  emptyChangesBuilder,
  snapshotGeometryForUndo,
  toCommitBundle,
  type ChangesBuilder,
} from '../../changes/changes-builder'
import { commitChangesPublic } from '../../page-crud'
import { cleanModifiers, propagateModifiers } from '../api/modifiers'
import { clearLayout, setFlexLayout, setGridLayout, setLayoutData } from '../api/layout'
import { moduleUseShape, setShapeGrowType } from '../api/shape'
import { getTextDimensions } from '../api/text'
import {
  IDENTITY_MATRIX,
  buildResizeMatrix,
  composeMatrix,
  identityMatrix,
  invertMatrix,
  rotationMatrixAroundPoint,
} from '../geom/matrix'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { useWorkspaceStore } from '../store/workspace-store'
import { clearModifierOverlay } from '../store/modifier-overlay'

const CONTAINER_LAYOUT_KEYS = new Set<string>([
  'layoutFlexDir',
  'layoutGridDir',
  'layoutWrapType',
  'layoutJustifyContent',
  'layoutJustifyItems',
  'layoutAlignItems',
  'layoutAlignContent',
  'layoutGap',
  'layoutPadding',
  'layoutGridRows',
  'layoutGridColumns',
  'layoutGridCells',
])

function snapshotAttrsForUndo(node: PenpotNode, keys: string[]): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  const rec = node as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (v !== undefined) {
      snap[k] = v !== null && typeof v === 'object' ? structuredClone(v as object) : v
    }
  }
  return snap
}

export function rectLayoutPartial(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number
): Partial<PenpotNode> {
  const selrect = {
    x,
    y,
    width,
    height,
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height,
  }
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  return {
    x,
    y,
    width,
    height,
    selrect,
    points,
    rotation: rotation !== 0 ? rotation : undefined,
  }
}

/** Absolute target geometry; only the changed fields are set (others held at committed). */
export interface GeometryTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
}

/**
 * Single geometry-commit pipeline shared by the Position (X/Y/rotation) and
 * Appearance (W/H) panels. Builds ONE world matrix — scale around the local
 * top-left ∘ rotate around center ∘ translate — from the delta between `before`
 * and `target`, then applyTransformToNode so transform + points + selrect +
 * rotation are always consistent. This is what keeps a rotated shape from
 * drifting on resize: the old axis-aligned path emitted a bare rotation scalar
 * and pivoted around a moving center. Untouched target fields fall back to the
 * committed value, so a single-axis edit produces a single-axis transform.
 *
 * No-ops when there's no usable selrect or the transform collapses the shape —
 * the panel only enables these fields for shapes with real geometry.
 */
export async function commitNodeGeometry(
  nodeId: string,
  before: PenpotNode,
  target: GeometryTarget,
  pageId: string | null | undefined,
  extra?: Partial<PenpotNode>,
): Promise<void> {
  const sr = before.selrect as
    | { x?: number; y?: number; width?: number; height?: number }
    | undefined
  const w0 = sr?.width ?? 0
  const h0 = sr?.height ?? 0
  if (!sr || w0 <= 0 || h0 <= 0) return

  const T = before.transform ?? IDENTITY_MATRIX
  const Tinv = before.transformInverse ?? invertMatrix(T) ?? IDENTITY_MATRIX
  const cx = (sr.x ?? 0) + w0 / 2
  const cy = (sr.y ?? 0) + h0 / 2
  const curX = (before as { x?: number }).x ?? sr.x ?? 0
  const curY = (before as { y?: number }).y ?? sr.y ?? 0
  const curRot = before.rotation ?? 0

  const sx = (target.width ?? w0) / w0
  const sy = (target.height ?? h0) / h0
  const dRot = (target.rotation ?? curRot) - curRot
  const dx = (target.x ?? curX) - curX
  const dy = (target.y ?? curY) - curY

  // Scale around the local top-left (offset -w0/2,-h0/2 from center), then
  // rotate around the center, then translate in world space.
  const S = buildResizeMatrix(T, Tinv, sx, sy, cx, cy, -w0 / 2, -h0 / 2)
  const R = rotationMatrixAroundPoint(cx, cy, dRot)
  const RS = composeMatrix(R, S)
  const M = { ...RS, e: RS.e + dx, f: RS.f + dy }

  const partial = applyTransformToNode(before, M)
  if (!partial) return
  await commitNodePartialUpdate(nodeId, before, { ...partial, ...extra }, pageId)
}

/** Latest committed node on the current page (same page key as `docProxy.currentPageId`). */
export function getCommittedNodeOnActivePage(nodeId: string): PenpotNode | null {
  const snap = snapshot(docProxy)
  const page = snap.currentPageId ? snap.pageMap.get(snap.currentPageId) : undefined
  return (page?.objects[nodeId] as PenpotNode | undefined) ?? null
}

/**
 * Resolve which container needs a flex/grid reflow given a partial.
 * - Container-layout key on the shape itself → reflow the shape.
 * - `layoutItem*` key (margin/sizing/align-self/...) on a child → reflow the child's parent.
 * - Otherwise → no reflow needed.
 */
function resolveReflowTarget(
  id: string,
  parentId: string | undefined,
  partial: Partial<PenpotNode>
): string | undefined {
  let touchesContainer = false
  let touchesItem = false
  for (const k of Object.keys(partial)) {
    if (CONTAINER_LAYOUT_KEYS.has(k)) touchesContainer = true
    else if (k.startsWith('layoutItem')) touchesItem = true
  }
  if (touchesContainer) return id
  if (touchesItem && parentId) return parentId
  return undefined
}

export async function commitNodePartialUpdate(
  id: string,
  nodeBefore: PenpotNode,
  partial: Partial<PenpotNode>,
  pageId: string | null | undefined
): Promise<void> {
  const redoAssign: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) {
      redoAssign[k] = v
    }
  }
  const keys = Object.keys(redoAssign)
  if (keys.length === 0) return

  const undoAssign = snapshotAttrsForUndo(nodeBefore, keys)
  const pid = pageId ?? undefined

  const reflowId = resolveReflowTarget(id, nodeBefore.parentId, partial)
  const renderer = useWorkspaceStore.getState().renderer
  const module = renderer?.getModule?.()

  // Fast path: no layout edit, or renderer/wasm not available (e.g. SSR/tests).
  if (!reflowId || !module) {
    let builder = emptyChangesBuilder({ pageId: pid })
    builder = appendModObjPair(builder, pid, id, { redoAssign, undoAssign })
    const bundle = toCommitBundle(builder)
    await commitChangesPublic({
      redoChanges: bundle.redoChanges,
      undoChanges: bundle.undoChanges,
      pageId: pid,
    })
    return
  }

  // Layout edit. Three phases collapsed into ONE commitChangesPublic call
  // (and therefore one history frame, via the history-sync subscriber):
  //
  //   1. Push the new layout block (just clearLayout + setFlex/Grid +
  //      setLayoutData) to WASM directly, ahead of propagate. We use the
  //      individual layout setters here rather than `renderer.updateShape`,
  //      because we don't want a full setObject pass (no spurious
  //      transform/fills/etc. re-pushes) and we don't want to schedule a
  //      render — the commit at the end will handle that.
  //
  //   2. propagate_modifiers with an identity matrix on the reflow target —
  //      Rust treats identity-on-container as a "reflow this layout" signal
  //      (geom/matrix.ts:11) and returns new child transforms reflecting the
  //      just-set config.
  //
  //   3. Build mod-obj pairs from the propagated transforms (against the
  //      pre-reflow children snapshot from docProxy) and concatenate them
  //      with the layout mod-obj. ONE commitChangesPublic call writes both
  //      to docProxy and re-syncs WASM via the renderer-sync subscriber.
  //      The renderer-sync re-pushes the parent's layout config (idempotent
  //      with phase 1) and the children's geometry as transform-only
  //      partials. The history-sync subscriber records exactly one frame.
  //
  // Transactionality: phase 1 mutates WASM before docProxy. If propagate
  // throws (or anything between throws) we'd be left with WASM holding the
  // new layout config and docProxy holding the old. The try/finally below
  // calls cleanModifiers either way; the state divergence is recoverable
  // because the next setObject for that shape (selection click, undo, etc.)
  // will re-sync WASM from docProxy.
  const projectedLayoutShape = { ...nodeBefore, ...redoAssign } as PenpotNode
  const layoutChangedKeys = new Set(
    keys.filter((k) => CONTAINER_LAYOUT_KEYS.has(k) || k.startsWith('layoutItem')),
  )

  let propagated: Array<{ id: string; transform: import('penpot-exporter/types').Matrix }> = []
  try {
    if (layoutChangedKeys.size > 0) {
      moduleUseShape(module, id)
      clearLayout(module)
      if ('layoutFlexDir' in projectedLayoutShape && projectedLayoutShape.layoutFlexDir) {
        setFlexLayout(module, projectedLayoutShape)
      }
      if ('layoutGridDir' in projectedLayoutShape && projectedLayoutShape.layoutGridDir) {
        setGridLayout(module, projectedLayoutShape)
      }
      setLayoutData(module, projectedLayoutShape)
    }
    cleanModifiers(module)
    propagated = propagateModifiers(module, [[reflowId, identityMatrix()]], 0, 'child')
  } finally {
    // Always clean — leaves WASM's modifier pool empty even if propagate threw.
    cleanModifiers(module)
  }

  let layoutBuilder = emptyChangesBuilder({ pageId: pid })
  layoutBuilder = appendModObjPair(layoutBuilder, pid, id, { redoAssign, undoAssign })

  let reflowBuilder: ChangesBuilder = emptyChangesBuilder({ pageId: pid })
  if (propagated.length > 0) {
    const docSnap = snapshot(docProxy)
    const pageObjects = pid ? docSnap.pageMap.get(pid)?.objects : undefined
    if (pageObjects) {
      for (const { id: targetId, transform } of propagated) {
        if (targetId === reflowId) continue
        const node = pageObjects[targetId] as PenpotNode | undefined
        if (!node) continue
        const childPartial = applyTransformToNode(node, transform)
        if (!childPartial) continue
        reflowBuilder = appendModObjPair(reflowBuilder, pid, targetId, {
          redoAssign: childPartial as Record<string, unknown>,
          undoAssign: snapshotGeometryForUndo(node),
        })
      }
    }
  }

  // Combine bundles. `appendModObjPair` appends to redoChanges and prepends to
  // undoChanges, so iterating layout then reflow gives:
  //   redo: [layout-redo, child1-redo, child2-redo, …]
  //   undo: [childN-undo, …, child1-undo, layout-undo]
  // Undo replays in array order → children revert first, then layout. Matches
  // the prepend invariant in changes-builder.ts:77.
  const layoutBundle = toCommitBundle(layoutBuilder)
  const reflowBundle = toCommitBundle(reflowBuilder)
  const combinedRedo = [...layoutBundle.redoChanges, ...reflowBundle.redoChanges]
  const combinedUndo = [...reflowBundle.undoChanges, ...layoutBundle.undoChanges]
  await commitChangesPublic({
    redoChanges: combinedRedo,
    undoChanges: combinedUndo,
    pageId: pid,
  })

  clearModifierOverlay()
}

/**
 * Commit a text shape's `grow-type` and, for the content-driven modes, resize
 * the box to fit the text in the same history frame.
 *
 * Switching to `auto-width`/`auto-height` only changes how the box *should*
 * size; the geometry isn't recomputed until a later layout pass. To make the
 * toggle feel immediate, we set the grow type on the WASM shape, read back the
 * laid-out text size (`get_text_dimensions`, the same source `syncTextEditGeometry`
 * uses while editing), and fold the new selrect/width/height into the commit so
 * the box hugs the text right away. `fixed` keeps the current size. Measurement
 * is best-effort: if WASM is unavailable or returns a degenerate size, we fall
 * back to a mode-only change.
 */
export async function commitTextGrowType(
  id: string,
  nodeBefore: PenpotNode,
  growType: 'fixed' | 'auto-width' | 'auto-height',
  pageId: string | null | undefined,
): Promise<void> {
  const pid = pageId ?? undefined
  let partial: Partial<PenpotNode> = { growType }

  if (growType === 'auto-width' || growType === 'auto-height') {
    const module = useWorkspaceStore.getState().renderer?.getModule?.()
    const sel = (nodeBefore as { selrect?: { x?: number; y?: number; width?: number; height?: number } }).selrect
    const x = sel?.x ?? (nodeBefore as { x?: number }).x ?? 0
    const y = sel?.y ?? (nodeBefore as { y?: number }).y ?? 0
    const rot = (nodeBefore as { rotation?: number }).rotation ?? 0
    const curWidth = sel?.width ?? (nodeBefore as { width?: number }).width ?? 0

    if (module) {
      try {
        moduleUseShape(module, id)
        setShapeGrowType(module, growType)
        const dims = getTextDimensions(module, id)
        const width = growType === 'auto-width' ? dims.width : curWidth
        const height = dims.height
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          partial = { growType, ...rectLayoutPartial(x, y, width, height, rot) }
        }
      } catch {
        // Measurement unavailable (SSR/tests/degenerate layout) — mode-only change.
      }
    }
  }

  await commitNodePartialUpdate(id, nodeBefore, partial, pid)
}
