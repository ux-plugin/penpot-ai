/**
 * Slot write-path — the single place that mutates a slot's view references.
 *
 * Both authoring surfaces funnel through here so commit + undo are identical:
 *   - dragging a frame onto a slot in the Layers panel (resolveSlotDrop)
 *   - picking a view in the "Show here" interaction (InteractionsTab)
 *
 * Each call is one history frame via `commitNodePartialUpdate` (fast path: views/
 * activeView aren't layout keys, so no reflow). Slots are a local extension of the
 * node union, so the slot is fetched/narrowed via `isSlotShape` and the partial is
 * cast at the commit boundary; the commit pipeline treats objects structurally.
 */
import { snapshot } from 'valtio'
import { docProxy } from '../store/doc-proxy'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../properties/commit-node-properties'
import { isSlotShape } from '../../worker/geometry/shapes'
import type { SlotShape } from '../../common/slot-shape'
import type { PenpotNode } from 'penpot-exporter/types'

function currentPageId(): string | undefined {
  return snapshot(docProxy).currentPageId ?? undefined
}

/** Commit a views/activeView change on the slot (one history frame). No-op if unchanged. */
async function commitSlot(
  slot: SlotShape,
  views: string[],
  activeView: string | undefined,
): Promise<void> {
  const sameViews =
    views.length === slot.views.length && views.every((v, i) => v === slot.views[i])
  if (sameViews && activeView === slot.activeView) return
  await commitNodePartialUpdate(
    slot.id,
    slot as unknown as PenpotNode,
    { views, activeView } as Partial<PenpotNode>,
    currentPageId(),
  )
}

/**
 * Register view frames as candidates of the slot. New ids are appended to `views`;
 * the active view is only *defaulted* (never overridden) — the first candidate
 * becomes the design-time default, but registering more candidates does not change
 * what an already-configured slot shows. Idempotent.
 */
export async function addViewsToSlot(slotId: string, viewIds: string[]): Promise<void> {
  const slot = getCommittedNodeOnActivePage(slotId)
  if (!isSlotShape(slot)) return
  const toAdd = viewIds.filter((v) => v && !slot.views.includes(v))
  if (toAdd.length === 0 && slot.activeView != null) return
  const views = [...slot.views, ...toAdd]
  const activeView = slot.activeView ?? views[0]
  await commitSlot(slot, views, activeView)
}

/** Single-view convenience for {@link addViewsToSlot}. */
export async function addViewToSlot(slotId: string, viewId: string): Promise<void> {
  return addViewsToSlot(slotId, [viewId])
}

/**
 * Explicitly set the slot's active (design-time default) view. Unlike
 * {@link addViewToSlot} this always changes `activeView`, registering the view as a
 * candidate first if needed.
 */
export async function setActiveView(slotId: string, viewId: string): Promise<void> {
  const slot = getCommittedNodeOnActivePage(slotId)
  if (!isSlotShape(slot)) return
  const views = slot.views.includes(viewId) ? slot.views : [...slot.views, viewId]
  await commitSlot(slot, views, viewId)
}

/**
 * Drop a view from the slot's candidates. If it was the active view, fall back to
 * the first remaining candidate (or none).
 */
export async function removeViewFromSlot(slotId: string, viewId: string): Promise<void> {
  const slot = getCommittedNodeOnActivePage(slotId)
  if (!isSlotShape(slot)) return
  if (!slot.views.includes(viewId)) return
  const views = slot.views.filter((v) => v !== viewId)
  const activeView = slot.activeView === viewId ? views[0] : slot.activeView
  await commitSlot(slot, views, activeView)
}
