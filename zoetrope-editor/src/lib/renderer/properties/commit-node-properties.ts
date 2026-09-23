/**
 * Commit partial node updates.
 *
 * Layout-* edits additionally trigger a flex/grid reflow on the affected
 * container: `propagate_modifiers` runs the WASM reflow with the freshly-set
 * flex config, and the resulting child transforms land in the same commit.
 * Mirrors CLJS `update-layout` (shape_layout.cljs:290) + `update-layout-positions`.
 */
import type { Matrix, PenpotNode } from 'penpot-exporter/types'
import { getNode, mod, type Change, type Node } from '../../doc'
import { commitChanges } from '../store/commit'
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

export function rectLayoutPartial(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): Partial<PenpotNode> {
  const selrect = { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height }
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  return { x, y, width, height, selrect, points, rotation: rotation !== 0 ? rotation : undefined }
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
 * rotation stay consistent. Untouched target fields fall back to the committed
 * value, so a single-axis edit produces a single-axis transform.
 */
export async function commitNodeGeometry(
  nodeId: string,
  before: PenpotNode,
  target: GeometryTarget,
  extra?: Partial<PenpotNode>,
): Promise<void> {
  const sr = before.selrect as { x?: number; y?: number; width?: number; height?: number } | undefined
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

  const S = buildResizeMatrix(T, Tinv, sx, sy, cx, cy, -w0 / 2, -h0 / 2)
  const R = rotationMatrixAroundPoint(cx, cy, dRot)
  const RS = composeMatrix(R, S)
  const M = { ...RS, e: RS.e + dx, f: RS.f + dy }

  const partial = applyTransformToNode(before, M)
  if (!partial) return
  await commitNodePartialUpdate(nodeId, before, { ...partial, ...extra })
}

/**
 * Which container needs a flex/grid reflow given a partial: a container-layout
 * key on the shape itself → the shape; a `layoutItem*` key on a child → its
 * parent; otherwise none.
 */
function resolveReflowTarget(id: string, parentId: string | undefined, partial: Partial<PenpotNode>): string | undefined {
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
): Promise<void> {
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) if (v !== undefined) set[k] = v
  const keys = Object.keys(set)
  if (keys.length === 0) return

  const reflowId = resolveReflowTarget(id, nodeBefore.parentId, partial)
  const module = useWorkspaceStore.getState().renderer?.getModule?.()

  // Fast path: no layout edit, or renderer/wasm not available (SSR/tests).
  if (!reflowId || !module) {
    await commitChanges({ changes: [mod('node', id, set as Partial<Node>)] })
    return
  }

  // Layout edit, one commit: push the new layout block to WASM ahead of
  // propagate (individual setters, no full setObject, no render), reflow the
  // target with an identity modifier (Rust's "reflow this layout" signal), and
  // commit the layout write with the propagated child geometry. If propagate
  // throws, WASM holds the new config and the document the old; the next
  // setObject for the shape re-syncs it.
  const projected = { ...nodeBefore, ...set } as PenpotNode
  const layoutChanged = keys.some((k) => CONTAINER_LAYOUT_KEYS.has(k) || k.startsWith('layoutItem'))

  let propagated: Array<{ id: string; transform: Matrix }> = []
  try {
    if (layoutChanged) {
      moduleUseShape(module, id)
      clearLayout(module)
      if ('layoutFlexDir' in projected && projected.layoutFlexDir) setFlexLayout(module, projected)
      if ('layoutGridDir' in projected && projected.layoutGridDir) setGridLayout(module, projected)
      setLayoutData(module, projected)
    }
    cleanModifiers(module)
    propagated = propagateModifiers(module, [[reflowId, identityMatrix()]], 0, 'child')
  } finally {
    cleanModifiers(module)
  }

  const changes: Change[] = [mod('node', id, set as Partial<Node>)]
  for (const { id: targetId, transform } of propagated) {
    if (targetId === reflowId) continue
    const node = getNode(targetId)
    if (!node) continue
    const childPartial = applyTransformToNode(node, transform)
    if (childPartial) changes.push(mod('node', targetId, childPartial as Partial<Node>))
  }
  await commitChanges({ changes })
  clearModifierOverlay()
}

/**
 * Commit a text shape's `grow-type` and, for the content-driven modes, resize
 * the box to fit the text in the same frame. Measurement is best-effort: if
 * WASM is unavailable or returns a degenerate size, only the mode changes.
 */
export async function commitTextGrowType(
  id: string,
  nodeBefore: PenpotNode,
  growType: 'fixed' | 'auto-width' | 'auto-height',
): Promise<void> {
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
        // Measurement unavailable — mode-only change.
      }
    }
  }

  await commitNodePartialUpdate(id, nodeBefore, partial)
}
