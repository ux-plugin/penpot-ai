/**
 * Pure helpers for detecting reparent intent during a move gesture.
 * Used by:
 *  - move handler per-frame to emit `setStructureModifiers` so propagate reflows
 *    flex/grid containers live (mirrors CLJS `set-wasm-modifiers` at
 *    frontend/src/app/main/data/workspace/modifiers.cljs:634).
 *  - move handler at commit time to fold `mov-objects` into the same
 *    `commitChanges` bundle as the move's `mod-obj` changes.
 *
 * Refactored from the body of the previous `reparentSelectedIfMovedIntoFrame`
 * in handlers/move.ts; unlike that helper these functions never call
 * `commitChanges` themselves.
 */

import type { Point } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../worker/types'
import { findContainerAtPoint, findSlotAtPoint } from '../../components/LayersPanel/reparent'
import { isFrameShape } from '../../worker/geometry/shapes'
import { rectToCenter } from '../../worker/geometry/rect'
import { ZERO_UUID } from '@skia-rs-wasm/common/conversions'
import { computeDropIndex, hasAnyLayout } from './drop-intent'

/** Per-shape reparent intent. Only present when the new parent differs from the current one. */
export interface PerShapeReparent {
  parentId: string
  index: number
}

/**
 * Detect "drop a view frame onto a slot" intent at commit time.
 *
 * For each selected *frame* whose projected center lands on a slot, returns a
 * `frameId -> slotId` entry. The caller assigns the frame as the slot's active
 * view (a reference) and excludes it from the move/reparent commit — the frame
 * snaps back to where it was; only `slot.activeView` changes. Non-frames and
 * frames not over a slot are absent.
 */
export function detectSlotDropTargets(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
  delta: Point,
): Map<string, string> {
  const result = new Map<string, string>()
  if (selectedIds.size === 0) return result
  const objects = page.objects as Record<string, IndexedShape>
  const excludeIds = Array.from(selectedIds)

  for (const id of selectedIds) {
    const shape = objects[id]
    if (!isFrameShape(shape) || !shape.selrect) continue
    const baseCenter = rectToCenter(shape.selrect)
    if (!baseCenter) continue
    const projected: Point = { x: baseCenter.x + delta.x, y: baseCenter.y + delta.y }
    const slotId = findSlotAtPoint(objects, projected, excludeIds)
    if (slotId) result.set(id, slotId)
  }
  return result
}

/** A single (parent, index, ids) target — used by the commit pipeline to build mov-objects. */
export interface ReparentTarget {
  parentId: string
  index: number
  ids: readonly string[]
}

/** Structure-modifier entry shape accepted by `setStructureModifiers` (api/modifiers.ts). */
export interface StructureModifierEntry {
  type: 'add-children' | 'remove-children' | 'scale-content'
  parent: string
  id: string
  index?: number
  value: number
}

/**
 * For each selected shape, project its center by `delta` and find the
 * innermost container the projected center falls into (excluding the moving
 * shapes themselves and their descendants — same rules as `findContainerAtPoint`).
 *
 * Returns a map keyed by shape id with the proposed (parentId, index). A
 * shape only appears in the map when the proposed parent differs from its
 * current `parentId`. Empty map = no reparent.
 */
export function detectReparentTargets(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
  delta: Point,
  /**
   * Point used to pick the insertion index within a flex container. Pass the
   * cursor's world position (Figma-style) — otherwise the shape's own center is
   * used, which for a shape larger than the container's children sits past all of
   * them and always lands last.
   */
  indexPoint?: Point,
): Map<string, PerShapeReparent> {
  const result = new Map<string, PerShapeReparent>()
  if (selectedIds.size === 0) return result
  const objects = page.objects as Record<string, IndexedShape>
  const excludeIds = computeReparentExcludeIds(selectedIds, page)

  for (const id of selectedIds) {
    const shape = objects[id]
    if (!shape?.selrect) continue
    const baseCenter = rectToCenter(shape.selrect)
    if (!baseCenter) continue
    const projected: Point = { x: baseCenter.x + delta.x, y: baseCenter.y + delta.y }
    // Resolve the target container at the CURSOR (Figma-style), matching the
    // drop-preview overlay so preview and commit agree on the same frame. Without
    // this the container was picked at the shape's projected center — a different
    // point than the cursor — which is what made the placeholder and the actual
    // reparent disagree near borders. Falls back to the center when no cursor.
    const hit = findContainerAtPoint(objects, indexPoint ?? projected, excludeIds)
    // When the projected center falls outside every container, escape to the
    // root frame (parentId == null sentinel) — matches the existing handler's
    // behavior at handlers/move.ts:189.
    const newParent = hit ?? (excludeIds.includes(ZERO_UUID) ? null : ZERO_UUID)
    if (!newParent) continue
    const parent = objects[newParent]
    // Same-parent drop is an in-place reorder — only meaningful when the parent
    // has a layout (flex/grid). For a non-layout parent it's a free move, so skip.
    const sameParent = newParent === shape.parentId
    if (sameParent && !(parent && hasAnyLayout(parent))) continue
    // Insert at the cursor position (matches the drop-preview) rather than always
    // appending. computeDropIndex handles flex (row/col); non-layout and grid
    // parents append. For a same-parent reorder, exclude the dragged shapes from
    // the index math (they're lifted out of the flow during the drag).
    const index = parent
      ? computeDropIndex(parent, objects, indexPoint ?? projected, sameParent ? selectedIds : undefined)
      : 0
    result.set(id, { parentId: newParent, index })
  }
  return result
}

/**
 * Build the exclude list for `findContainerAtPoint` during a reparent search.
 *
 * Rule: every frame is a valid drop target *except* the direct siblings of
 * the dragged shape (i.e. the other children of the dragged shape's immediate
 * parent). Their entire subtrees are excluded too via `collectDescendants`
 * inside `findContainerAtPoint`.
 *
 * Cousins, the parent itself, ancestors, and unrelated frames anywhere on the
 * canvas all stay as candidates. Root-level shapes have no parent (or root as
 * parent) — when their parent is root, the only "siblings" are other top-level
 * shapes, and the user explicitly wants those root-level reparents to keep
 * working, so we don't exclude root's children.
 */
function computeReparentExcludeIds(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
): string[] {
  const out: string[] = Array.from(selectedIds)
  const seen = new Set(out)
  const objects = page.objects as Record<string, IndexedShape>
  for (const id of selectedIds) {
    const parentId = (objects[id] as { parentId?: string } | undefined)?.parentId
    if (!parentId || parentId === ZERO_UUID) continue
    const parent = objects[parentId] as { shapes?: string[] } | undefined
    for (const sibId of parent?.shapes ?? []) {
      if (!seen.has(sibId)) {
        seen.add(sibId)
        out.push(sibId)
      }
    }
  }
  return out
}

/**
 * Group per-shape reparent intents by their target parent. One entry per
 * destination parent. Caller uses this to build `mov-objects` changes (one per
 * group) and merge them into a single commit bundle.
 */
export function groupReparentTargets(
  targets: ReadonlyMap<string, PerShapeReparent>,
): ReparentTarget[] {
  const byParent = new Map<string, ReparentTarget>()
  for (const [shapeId, t] of targets) {
    const existing = byParent.get(t.parentId)
    if (existing) {
      ;(existing.ids as string[]).push(shapeId)
    } else {
      byParent.set(t.parentId, { parentId: t.parentId, index: t.index, ids: [shapeId] })
    }
  }
  return Array.from(byParent.values())
}

/**
 * Containers that need a reflow when a shape enters/leaves them. CLJS sends an
 * identity-matrix entry for every parent in the modif-tree so Rust converts it
 * into a `Reflow` modifier (shapes/modifiers.rs:376–378), queuing layout
 * containers for `reflow_flex_layout` / `reflow_grid_layout`. Without these,
 * `propagate_transform` only queues the moved shape's *real* parent for reflow
 * — the new target parent is never reached because `shape.parent_id` doesn't
 * change until commit.
 *
 * Returns the set of (a) every projected new parent and (b) every shape's
 * current real parent, deduped. Empty if no targets.
 */
export function collectReflowParents(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
  targets: ReadonlyMap<string, PerShapeReparent>,
): Set<string> {
  const out = new Set<string>()
  if (targets.size === 0) return out
  const objects = page.objects as Record<string, IndexedShape>
  for (const t of targets.values()) {
    out.add(t.parentId)
  }
  for (const id of selectedIds) {
    const real = objects[id]?.parentId
    if (real) out.add(real)
  }
  return out
}

/**
 * Build the commit-time structure-modifier batch from a final reparent map.
 *
 * For each (shape, target) pair: emit `remove-children` from the shape's real
 * parent (if different from the target) so the source layout reflows it out,
 * and `add-children` to the target so the destination layout includes it.
 *
 * TODO: live drag-time previews of "shape will land at this slot in the
 * target" would require tracking a per-frame `prev → next` diff (remove from
 * old projected target, add to new) so the dragged shape visibly inserts into
 * the hovered container during the gesture. Out of scope for now — drop only
 * happens on release.
 */
export function buildCommitStructureEntries(
  targets: ReadonlyMap<string, PerShapeReparent>,
  page: IndexedPage,
): StructureModifierEntry[] {
  const entries: StructureModifierEntry[] = []
  const objects = page.objects as Record<string, IndexedShape>
  for (const [id, target] of targets) {
    const realParent = (objects[id] as { parentId?: string } | undefined)?.parentId
    if (realParent && realParent !== target.parentId) {
      entries.push({
        type: 'remove-children',
        parent: realParent,
        id,
        value: 0,
      })
    }
    entries.push({
      type: 'add-children',
      parent: target.parentId,
      id,
      index: target.index,
      value: 0,
    })
  }
  return entries
}

/**
 * Build the per-frame "free this shape from its layout" structure modifiers.
 * For each selected shape whose real parent has a flex/grid layout, emit a
 * `remove-children` from that real parent. While these are in `pool.structure`,
 * propagate's flex reflow on the real parent iterates the reduced children
 * list — so the dragging shape doesn't get snapped back to its layout slot,
 * and its siblings collapse to fill the gap (live visual feedback).
 *
 * Mirrors CLJS's drag-time structure-parent `:remove-children` op.
 */
export function buildLayoutDetachEntries(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
): StructureModifierEntry[] {
  const out: StructureModifierEntry[] = []
  const objects = page.objects as Record<string, IndexedShape>
  for (const id of selectedIds) {
    const shape = objects[id]
    const realParent = shape?.parentId
    if (!realParent) continue
    const parent = objects[realParent] as Record<string, unknown> | undefined
    if (!parent) continue
    const hasLayout =
      parent.layout ||
      parent.layoutFlexDir ||
      parent.layoutGridDir ||
      parent.layoutGridRows ||
      parent.layoutGridColumns
    if (!hasLayout) continue
    out.push({
      type: 'remove-children',
      parent: realParent,
      id,
      value: 0,
    })
  }
  return out
}

/**
 * Build the per-frame "reparent preview" structure modifiers for a drag.
 *
 * For each dragged shape: `remove-children` from its real parent (so the source
 * layout reflows without it) and `add-children` to the hovered **target** as its
 * **topmost** child, so it paints above the target's own fill and its other
 * children — i.e. above the parent it's being dropped into, without hoisting it
 * over the rest of the canvas. These are transient modifiers — `get()` applies
 * them to the paint traversal and `cleanModifiers` reverts them on release; the
 * real reparent is committed at the computed index on drop. The dragged shapes
 * are additionally marked layout-absolute (via `setAbsoluteModifiers`) so a
 * flex/grid target skips them in its flow and they stay under the cursor via
 * their translate modifier.
 */
export function buildReparentPreviewEntries(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
  targetId: string,
): StructureModifierEntry[] {
  const out: StructureModifierEntry[] = []
  const objects = page.objects as Record<string, IndexedShape>
  for (const id of selectedIds) {
    const realParent = (objects[id] as { parentId?: string } | undefined)?.parentId
    if (realParent && realParent !== targetId) {
      out.push({ type: 'remove-children', parent: realParent, id, value: 0 })
    }
    // index 0 = topmost child: the SSA scheduler (emit_tree_in_z_order) paints
    // the last-emitted child on top, and children_ids_iter emits self.children[0]
    // last, so the front of the target's child list is the top of its z-order.
    out.push({ type: 'add-children', parent: targetId, id, index: 0, value: 0 })
  }
  return out
}

/** Walk selected ids; return text shapes mapped to their current `growType`. Used at commit. */
export function collectTextGrowTypes(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  const objects = page.objects as Record<string, IndexedShape>
  for (const id of selectedIds) {
    const shape = objects[id]
    if (!shape) continue
    if ((shape as { type?: string }).type !== 'text') continue
    out.set(id, (shape as { growType?: string }).growType)
  }
  return out
}
