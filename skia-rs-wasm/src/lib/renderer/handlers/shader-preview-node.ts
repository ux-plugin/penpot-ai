/**
 * Transient WASM preview of a shader drop — the shader equivalent of the flex
 * drag's drop placeholder (`handlers/drop-placeholder.ts`).
 *
 * While a shader is dragged over a shape we want to show *exactly* what applying
 * it would look like: the shader filling that shape's real silhouette (path,
 * rounded corners, everything), animated, and sitting under the floating tools.
 * Rather than reproduce any of that with an offscreen render + SVG clip, we let
 * the real renderer do it: clone the hovered node, swap in the dragged material,
 * and load the clone straight into the WASM shape store on top of its top-level
 * siblings.
 *
 * The clone lives ONLY in WASM — never written to docProxy, never in undo, never
 * in the layers panel or the worker hit index. It's created on hover, moved to
 * whichever shape is under the cursor, and destroyed on release/cancel by resetting
 * the root's child list (WASM `set_children` deletes ids dropped from the list),
 * identical to how the drop placeholder cleans up. On a real drop the caller
 * destroys it and commits the material to the actual node.
 */

import type { PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../api/material'
import { setObject } from '../api/orchestration'
import { createRect } from '../node-factory'
import { newShapeId } from '../../common/shape-id'

interface RendererLike {
  getModule(): unknown
  updateParentChildren(parentId: string, childIds: string[]): void
}

/** Handle to the live preview clone for one drag gesture. */
export interface ShaderPreviewNode {
  id: string
  /** The container (page root) the clone is a child of, in WASM. */
  rootId: string
  /** The doc node the clone mirrors — so we skip rebuilding while it stays put. */
  sourceId: string
}

/**
 * Clone `src` as a self-contained, shader-filled ghost. We keep its geometry and
 * fills verbatim (so the preview reads as the true applied result) and only swap
 * in the material, empty the children, and drop any layout — an emptied frame
 * keeps its own size instead of collapsing. Reusing the real shape loader means
 * every visual property (path, corners, strokes, effects) matches automatically.
 */
function buildPreviewClone(src: Record<string, unknown>, id: string, rootId: string, material: Material): PenpotNode {
  // JSON round-trip (not structuredClone): the live node is a valtio/index proxy
  // carrying non-cloneable refs — structuredClone throws DataCloneError on it.
  // The round-trip also strips functions and any transient junk, leaving a clean
  // POJO the shape loader accepts (mirrors drop-placeholder's clone).
  const clone = JSON.parse(JSON.stringify(src)) as Record<string, unknown>
  clone.id = id
  clone.parentId = rootId
  clone.frameId = rootId
  clone.shapes = []
  clone.material = material
  delete clone.layout
  delete clone.layoutFlexDir
  delete clone.layoutGridDir
  delete clone.layoutGridRows
  delete clone.layoutGridColumns
  delete clone.layoutWrapType
  return clone as unknown as PenpotNode
}

/**
 * Shapes we can mirror as a self-contained shader ghost — those with geometry of
 * their own. `group`/`bool` carry no fillable geometry, so they get no preview.
 */
const CLONE_TYPES = new Set(['rect', 'circle', 'path', 'frame', 'image', 'text'])

/**
 * Create/replace the preview so it mirrors `sourceNode`, filled with `material`,
 * on top of the root's children. Pass the existing `prev` handle (if any) so we
 * only rebuild when the hovered shape actually changed. Returns the live handle,
 * or null if there's nothing to preview (unsupported type / module not ready).
 */
export function showShaderPreviewForNode(
  renderer: RendererLike,
  rootId: string,
  rootChildIds: readonly string[],
  sourceId: string,
  sourceNode: Record<string, unknown>,
  material: Material,
  prev: ShaderPreviewNode | null,
): ShaderPreviewNode | null {
  if (prev && prev.sourceId === sourceId) return prev
  if (prev) hideShaderPreview(renderer, rootChildIds, prev)

  const module = renderer.getModule()
  const type = sourceNode.type as string | undefined
  if (!module || !type || !CLONE_TYPES.has(type)) return null

  const id = newShapeId()
  setObject(module as never, buildPreviewClone(sourceNode, id, rootId, material))
  renderer.updateParentChildren(rootId, [...rootChildIds, id])
  return { id, rootId, sourceId }
}

/**
 * Create/replace the preview as a plain rectangle at `worldRect`, filled with
 * `material` — the empty-canvas case (a drop there creates a new rect). Keyed on a
 * synthetic source id so it isn't rebuilt every pointer move.
 */
export function showShaderPreviewRect(
  renderer: RendererLike,
  rootId: string,
  rootChildIds: readonly string[],
  worldRect: { x: number; y: number; width: number; height: number },
  material: Material,
  prev: ShaderPreviewNode | null,
): ShaderPreviewNode | null {
  const module = renderer.getModule()
  if (!module) return null
  const sourceId = '__shader-new-rect__'
  if (prev && prev.sourceId === sourceId) {
    // Same synthetic target: reload its geometry in place, then re-assert the
    // child list (a no-op list change still schedules a render — setObject alone
    // does not) so the moved rect repaints.
    const rect = createRect({
      id: prev.id,
      x: worldRect.x,
      y: worldRect.y,
      width: worldRect.width,
      height: worldRect.height,
      parentId: rootId,
      fillColor: '#8A8A8A',
    }) as Record<string, unknown>
    rect.material = material
    setObject(module as never, rect as unknown as PenpotNode)
    renderer.updateParentChildren(rootId, [...rootChildIds, prev.id])
    return prev
  }
  if (prev) hideShaderPreview(renderer, rootChildIds, prev)

  const id = newShapeId()
  const rect = createRect({
    id,
    x: worldRect.x,
    y: worldRect.y,
    width: worldRect.width,
    height: worldRect.height,
    parentId: rootId,
    fillColor: '#8A8A8A',
  }) as Record<string, unknown>
  rect.material = material
  setObject(module as never, rect as unknown as PenpotNode)
  renderer.updateParentChildren(rootId, [...rootChildIds, id])
  return { id, rootId, sourceId }
}

/**
 * Destroy the preview: reset the root's WASM child list back to the document list,
 * dropping the clone's id so WASM deletes the shape.
 */
export function hideShaderPreview(
  renderer: RendererLike,
  rootChildIds: readonly string[],
  preview: ShaderPreviewNode,
): void {
  renderer.updateParentChildren(preview.rootId, [...rootChildIds])
}
