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
import { findContainerAtPoint } from '../../components/LayersPanel/reparent'
import { rectToCenter } from '../../worker/geometry/rect'
import { ZERO_UUID } from '@skia-rs-wasm/common/conversions'

/** Per-shape reparent intent. Only present when the new parent differs from the current one. */
export interface PerShapeReparent {
  parentId: string
  index: number
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
    const hit = findContainerAtPoint(objects, projected, excludeIds)
    // When the projected center falls outside every container, escape to the
    // root frame (parentId == null sentinel) — matches the existing handler's
    // behavior at handlers/move.ts:189.
    const newParent = hit ?? (excludeIds.includes(ZERO_UUID) ? null : ZERO_UUID)
    if (!newParent) continue
    if (newParent === shape.parentId) continue
    const parent = objects[newParent]
    const index = parent?.shapes?.length ?? 0
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
