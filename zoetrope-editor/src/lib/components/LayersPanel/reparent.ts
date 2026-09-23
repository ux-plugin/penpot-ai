/**
 * Pure helpers for drag-to-reparent: both in the Layers panel (zone-based)
 * and on the canvas (point-in-frame drop). Mirrors Penpot's drop-side geometry
 * (dnd.cljs) and on-drop dispatch (layer_item.cljs). The move itself is
 * `moveNodes` from doc.
 */

import type { PenpotNode, Point } from 'penpot-exporter/types'
import { ancestors, descendants, getNode, ofType, siblingIndex } from '../../doc'
import {
  isBoolShape,
  isComponentShape,
  isFrameShape,
  isGroupShape,
  isSlotShape,
} from '../../worker/geometry/shapes'
import { containsPoint } from '../../worker/geometry/rect'

export type DropSide = 'top' | 'center' | 'bot'

/**
 * Three-zone detection for containers (top 20% / center 60% / bot 20%),
 * binary split at 50% otherwise.
 */
export function computeDropSide(
  offsetY: number,
  rowHeight: number,
  detectCenter: boolean,
): DropSide {
  if (rowHeight <= 0) return 'bot'
  if (detectCenter) {
    const thold1 = rowHeight * 0.2
    const thold2 = rowHeight * 0.8
    if (offsetY < thold1) return 'top'
    if (offsetY > thold2) return 'bot'
    return 'center'
  }
  return offsetY < rowHeight / 2 ? 'top' : 'bot'
}

/**
 * True for shape types that can hold children (frame, group, bool, component).
 *
 * Slots are intentionally excluded: a slot *references* views, it does not own
 * children. Because of this, a center-drop onto a slot resolves to `null` in
 * `resolveDropTarget` (never a reparent), preserving the one-geometric-parent
 * invariant. Slot drops are instead surfaced by `resolveSlotDrop`.
 */
export function isContainer(node: PenpotNode | null | undefined): boolean {
  return isFrameShape(node) || isGroupShape(node) || isBoolShape(node) || isComponentShape(node)
}

/** True when `ancestorId` is `descendantId` or above it. */
export function isAncestor(ancestorId: string, descendantId: string): boolean {
  return ancestorId === descendantId || ancestors(descendantId).includes(ancestorId)
}

export interface ResolveDropTargetParams {
  targetId: string
  side: DropSide
  draggedIds: readonly string[]
}

export interface ResolvedDropTarget {
  /** Absent: the page's top level. */
  parentId: string | undefined
  index: number
}

/**
 * Resolve a (targetId, side) gesture to a (parentId, index) placement.
 * Returns null for invalid or no-op drops.
 */
export function resolveDropTarget(
  params: ResolveDropTargetParams,
): ResolvedDropTarget | null {
  const { targetId, side, draggedIds } = params
  if (draggedIds.length === 0) return null

  if (draggedIds.some((id) => id === targetId)) return null

  const target = getNode(targetId)
  if (!target) return null

  let parentId: string | undefined
  let index: number

  if (side === 'center') {
    if (!isContainer(target)) return null
    parentId = targetId
    index = 0
  } else {
    parentId = target.parentId
    const currentIndex = siblingIndex(targetId)
    if (currentIndex < 0) return null
    index = side === 'top' ? currentIndex : currentIndex + 1
  }

  if (parentId && draggedIds.some((id) => isAncestor(id, parentId!))) return null

  if (isNoOpDrop(draggedIds, parentId, index)) return null

  return { parentId, index }
}

export interface ResolvedSlotDrop {
  slotId: string
  /** Dragged view-frame ids to register as candidate views of the slot. */
  viewIds: string[]
}

/**
 * Resolve a center-drop *onto a slot* to a view-assignment intent (add the dragged
 * frames to the slot's `views`). This is the slot counterpart to
 * `resolveDropTarget`: the two are mutually exclusive — a slot is never a reparent
 * target — so a caller checks this first and falls back to `resolveDropTarget`.
 *
 * Only frames are valid views; non-frame drags (and the slot itself) are ignored.
 * Returns null when the gesture is not a frame-onto-slot center-drop.
 *
 * NOTE: this is the pure intent only. Committing the assignment is the shared
 * slot write-path (slot-edit.ts), so drop and `show-in-slot` authoring stay DRY.
 */
export function resolveSlotDrop(
  params: ResolveDropTargetParams,
): ResolvedSlotDrop | null {
  const { targetId, side, draggedIds } = params
  if (side !== 'center') return null
  if (!isSlotShape(getNode(targetId))) return null

  const viewIds = draggedIds.filter(
    (id) => id !== targetId && isFrameShape(getNode(id)),
  )
  if (viewIds.length === 0) return null

  return { slotId: targetId, viewIds }
}

function isNoOpDrop(
  draggedIds: readonly string[],
  parentId: string | undefined,
  index: number,
): boolean {
  for (const id of draggedIds) {
    const shape = getNode(id)
    if (!shape) return false
    if (shape.parentId !== parentId) return false
    const currentIndex = siblingIndex(id)
    if (currentIndex !== index && currentIndex !== index - 1) {
      return false
    }
  }
  return true
}

/** Node types that hold children; slots are not among them. */
export const CONTAINER_TYPES = ['frame', 'group', 'bool', 'component'] as const

/** The smallest node of `types` on `pageId` whose selrect contains `point`, skipping `excluded`. */
function innermostAt(
  pageId: string,
  types: readonly string[],
  point: Point,
  excluded: ReadonlySet<string>,
): string | null {
  let bestId: string | null = null
  let bestArea = Infinity
  for (const type of types) {
    for (const id of ofType(pageId, type)) {
      if (excluded.has(id)) continue
      const sr = getNode(id)?.selrect
      if (!sr || !containsPoint(sr, point)) continue
      const area = (sr.width ?? 0) * (sr.height ?? 0)
      if (area < bestArea) {
        bestId = id
        bestArea = area
      }
    }
  }
  return bestId
}

/**
 * Innermost container on `pageId` whose selrect contains `point`, excluding
 * `excludeIds` and their descendants (so a shape can't be reparented into
 * itself or another shape being moved together). Scans containers only.
 */
export function findContainerAtPoint(pageId: string, point: Point, excludeIds: readonly string[]): string | null {
  const excluded = new Set<string>(excludeIds)
  for (const id of excludeIds) for (const d of descendants(id)) excluded.add(d)
  return innermostAt(pageId, CONTAINER_TYPES, point, excluded)
}

/**
 * Innermost slot on `pageId` whose selrect contains `point`, excluding
 * `excludeIds`. Slots are not containers, so this is the parallel lookup for a
 * "drop a view frame onto a slot" gesture. Scans slots only.
 */
export function findSlotAtPoint(pageId: string, point: Point, excludeIds: readonly string[]): string | null {
  return innermostAt(pageId, ['slot'], point, new Set(excludeIds))
}
