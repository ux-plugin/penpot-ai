/**
 * Transient drop placeholder for the Figma-style flex drag preview.
 *
 * When a shape is dragged over a flex container we want two things at once:
 *  - the dragged shape floats under the cursor (a plain translate modifier), and
 *  - the container's siblings slide apart to open a gap where it will land.
 *
 * The dragged shape itself can't do both: the moment it's an in-flow child the
 * flex engine owns its position and pins it into a slot (it stops following the
 * cursor). So we insert a *separate* placeholder — a faded clone of the dragged
 * shape (or a rect fallback) — as a real child of the target. The engine reflows
 * the siblings around the placeholder (that's the gap), while the real shape stays
 * detached and is translated to the cursor.
 *
 * The placeholder lives ONLY in the WASM shape store — it is never written to
 * docProxy, never enters undo history, and never reaches the layers panel. It is
 * created on first hover over a flex target and destroyed on release/cancel via
 * `updateParentChildren` (WASM `set_children` deletes ids dropped from the list).
 */
import type { PenpotNode, Selrect } from 'penpot-exporter/types'
import { setObject } from '../api/orchestration'
import { createRect } from '../node-factory'
import { newShapeId } from '../../common/shape-id'

interface RendererLike {
  getModule(): unknown
  updateParentChildren(parentId: string, childIds: string[]): void
}

/**
 * Inputs for building the placeholder: the page objects, the current selection,
 * and a bounding rect to fall back to when the selection can't be mirrored as a
 * single self-contained shape.
 */
export interface PlaceholderSpec {
  objects: Record<string, unknown>
  selectedIds: ReadonlySet<string>
  fallbackSelrect: Selrect
}

/**
 * Shapes we clone as the placeholder. Leaf primitives clone directly; a `frame`
 * clones too but is stripped to a childless, layout-less box (it has its own
 * geometry/fill/corners, so it makes a good ghost). `group`/`bool` have no
 * geometry of their own, so they fall through to the rect fallback.
 */
const CLONE_TYPES = new Set(['rect', 'circle', 'path', 'frame'])

/** Accent used for the preview highlight (matches the drop-intent overlay). */
const ACCENT = '#3B82F6'

/** Multiplier on the clone's own fills so its body reads as translucent. */
const GHOST_FILL_OPACITY = 0.4

/**
 * Crisp accent outline stamped on every ghost so it's unmistakably a preview and
 * not a real shape. Full opacity (the body is faded via the fills, not the node
 * opacity), so the highlight stays sharp. Fresh object per call — `setObject`
 * takes ownership of the node.
 */
function highlightStroke(): Record<string, unknown> {
  return {
    strokeColor: ACCENT,
    strokeOpacity: 1,
    strokeWidth: 2,
    strokeStyle: 'dotted',
    strokeAlignment: 'center',
  }
}

/** Fallback ghost (multi-select / group / text): a translucent accent rect. */
const GHOST_FILL = { fillColor: ACCENT, fillOpacity: 0.15 }
const GHOST_STROKE = { strokeColor: ACCENT, strokeWidth: 2 }

/**
 * Build the placeholder node. A single primitive is CLONED verbatim and faded —
 * reusing the real shape loader (`setObject`) means every visual property
 * (geometry, rounded corners, stroke style, effects, and anything added later)
 * matches automatically, with no parallel rendering code to maintain. Anything
 * else (multi-select, group/frame, text) falls back to a translucent rect sized to
 * the selection bounds.
 */
function buildPlaceholderNode(spec: PlaceholderSpec, id: string, targetId: string): PenpotNode {
  const { objects, selectedIds, fallbackSelrect } = spec
  if (selectedIds.size === 1) {
    const srcId = selectedIds.values().next().value as string
    const src = objects[srcId] as
      | (Record<string, unknown> & { type?: string; shapes?: string[]; opacity?: number })
      | undefined
    if (src && src.type && CLONE_TYPES.has(src.type)) {
      const clone = JSON.parse(JSON.stringify(src)) as Record<string, unknown>
      clone.id = id
      clone.parentId = targetId
      clone.frameId = targetId
      // Preview styling: fade the ghost's own fills so the body reads as
      // translucent, then stamp a crisp accent outline so it's clearly a preview
      // and not a real shape. The silhouette (path, corners, size) comes from the
      // clone itself. Fading the *fills* (not the node opacity) keeps the
      // highlight sharp.
      const srcFills = Array.isArray((clone as { fills?: unknown }).fills)
        ? (clone as { fills: Array<Record<string, unknown>> }).fills
        : []
      clone.fills = srcFills.map((f) => ({
        ...f,
        fillOpacity: (typeof f.fillOpacity === 'number' ? f.fillOpacity : 1) * GHOST_FILL_OPACITY,
      }))
      clone.strokes = [highlightStroke()]
      // Make it self-contained: no real children, and no own layout so an emptied
      // frame keeps its size instead of collapsing/reflowing.
      clone.shapes = []
      delete clone.layout
      delete clone.layoutFlexDir
      delete clone.layoutGridDir
      delete clone.layoutGridRows
      delete clone.layoutGridColumns
      delete clone.layoutWrapType
      return clone as unknown as PenpotNode
    }
  }
  const rect = createRect({
    id,
    x: fallbackSelrect.x,
    y: fallbackSelrect.y,
    width: fallbackSelrect.width,
    height: fallbackSelrect.height,
    fillColor: GHOST_FILL.fillColor,
    fillOpacity: GHOST_FILL.fillOpacity,
    strokeColor: GHOST_STROKE.strokeColor,
    strokeWidth: GHOST_STROKE.strokeWidth,
  })
  const r = rect as Record<string, unknown>
  r.parentId = targetId
  r.frameId = targetId
  return rect
}

/** Tracks the live placeholder for one drag gesture. */
export interface DropPlaceholder {
  id: string
  /** The container the placeholder is currently a child of (in WASM). */
  targetId: string
  /** Its current insertion index within `targetId`'s document child list. */
  index: number
}

/** `targetChildIds` (the doc child list) with the placeholder spliced in at `index`. */
function childListWith(targetChildIds: readonly string[], id: string, index: number): string[] {
  const kids = [...targetChildIds]
  const i = Math.max(0, Math.min(index, kids.length))
  kids.splice(i, 0, id)
  return kids
}

/**
 * Create the placeholder in WASM — a faded clone of the dragged shape (see
 * `buildPlaceholderNode`) loaded through the real shape loader — and insert it into
 * `targetId` at `index` so the flex layout opens the gap there. `targetChildIds` is
 * the container's *document* child list (without the placeholder). Returns the
 * handle, or null if the module isn't ready.
 */
export function createDropPlaceholder(
  renderer: RendererLike,
  targetId: string,
  targetChildIds: readonly string[],
  spec: PlaceholderSpec,
  index: number,
): DropPlaceholder | null {
  const module = renderer.getModule() as
    | { _use_shape?: unknown }
    | null
    | undefined
  if (!module) return null
  const id = newShapeId()
  setObject(module as never, buildPlaceholderNode(spec, id, targetId))
  renderer.updateParentChildren(targetId, childListWith(targetChildIds, id, index))
  return { id, targetId, index }
}

/**
 * Move the placeholder to `index` within its current target. No-op if unchanged.
 * Reordering keeps every id present in the child list, so nothing is deleted.
 */
export function positionDropPlaceholder(
  renderer: RendererLike,
  placeholder: DropPlaceholder,
  targetChildIds: readonly string[],
  index: number,
): DropPlaceholder {
  if (placeholder.index === index) return placeholder
  renderer.updateParentChildren(placeholder.targetId, childListWith(targetChildIds, placeholder.id, index))
  return { ...placeholder, index }
}

/**
 * Move the placeholder to a different container (the cursor left the old target).
 * Detaches from the old parent (which deletes nothing — the placeholder id moves)
 * and inserts into the new one at `index`.
 */
export function reattachDropPlaceholder(
  renderer: RendererLike,
  placeholder: DropPlaceholder,
  oldTargetChildIds: readonly string[],
  newTargetId: string,
  newTargetChildIds: readonly string[],
  index: number,
): DropPlaceholder {
  // Remove from the old parent's WASM child list (restores it to the doc list),
  // then insert into the new parent. The shape itself survives because it's still
  // referenced by the new parent in the same frame.
  renderer.updateParentChildren(placeholder.targetId, [...oldTargetChildIds])
  renderer.updateParentChildren(newTargetId, childListWith(newTargetChildIds, placeholder.id, index))
  return { id: placeholder.id, targetId: newTargetId, index }
}

/**
 * Destroy the placeholder: reset its parent's WASM child list back to the
 * document list, which drops the placeholder id and makes WASM delete the shape.
 */
export function destroyDropPlaceholder(
  renderer: RendererLike,
  placeholder: DropPlaceholder,
  targetChildIds: readonly string[],
): void {
  renderer.updateParentChildren(placeholder.targetId, [...targetChildIds])
}
