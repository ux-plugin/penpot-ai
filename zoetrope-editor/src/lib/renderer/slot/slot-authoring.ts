/**
 * Higher-level slot authoring actions — the ones that create or restructure
 * document nodes (as opposed to slot-edit.ts, which only mutates a slot's view
 * references). Kept separate so slot-edit stays a thin, side-effect-light
 * write-path and this module owns the node-creation plumbing (createFrame +
 * addNode commit) it composes with.
 */
import {
  addNode,
  beginGroup,
  children,
  descendants,
  endGroup,
  getActiveOrSinglePageId,
  getNode,
  mod,
  moveNodes,
  type Change,
  type Node,
} from '../../doc'
import { setSelectedIds } from '../store/document-selection'
import { applyChanges } from '../../page-crud'
import { createFrame } from '../node-factory'
import { isSlotShape } from '../../worker/geometry/shapes'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { translateMatrix } from '../geom/matrix'
import { setActiveView } from './slot-edit'

/** Gap between a slot and the view frame extracted from / created for it. */
const VIEW_GAP = 40

/** Ordinal for the default name of the Nth view created for a slot. */
function nextViewName(existing: number): string {
  return `View ${existing + 1}`
}

/**
 * Create a fresh, pre-sized view frame and register it as the slot's active view.
 *
 * The new frame is a top-level sibling (like any board): a view has stable
 * identity and lives outside the slot, which merely references it. It is sized
 * to the slot's box and offset to sit just to the slot's right so it is visible
 * on canvas rather than hidden under the outlet.
 *
 * Two history frames (add, then the slot's mod) — creating the frame is
 * independently undoable from wiring it up. Returns the new view id, or null if
 * there is no active page or the target is not a slot.
 */
export async function addNewViewToSlot(slotId: string): Promise<string | null> {
  const slot = getNode(slotId)
  if (!isSlotShape(slot)) return null

  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null

  const width = slot.selrect?.width ?? slot.width ?? 400
  const height = slot.selrect?.height ?? slot.height ?? 300
  const x = (slot.selrect?.x ?? slot.x ?? 0) + width + 40
  const y = slot.selrect?.y ?? slot.y ?? 0

  const view = createFrame({
    name: nextViewName(slot.views.length),
    x,
    y,
    width,
    height,
    fillColor: '#FFFFFF',
    fillOpacity: 1,
  })

  await applyChanges([addNode(view, { page: pageId })])

  // Register + make it the active view (defaults it if the slot was empty).
  await setActiveView(slotId, view.id)
  return view.id
}

/**
 * Turn an existing frame into a slot, in place.
 *
 * The frame keeps its id and box — so anything already pointing at it (an
 * interaction target, a layout parent) keeps working — but a slot owns no
 * children, so the frame's content has to go somewhere. It is extracted into a
 * new view frame placed beside the slot, which the slot then references as its
 * active view: converting a populated region into an outlet preserves what was
 * in it as that outlet's first view rather than destroying it.
 *
 * Because shapes carry absolute coordinates, the extracted subtree is translated
 * by the same delta as the new frame so the content lands inside it.
 *
 * An empty frame converts to an empty slot (no view is invented for it).
 *
 * The whole conversion is a single history frame. Returns the new view id, or
 * null when nothing was created (empty frame) or the target was not convertible.
 */
export async function convertFrameToSlot(frameId: string): Promise<string | null> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const frame = getNode(frameId)
  if (!frame || frame.type !== 'frame') return null

  const kids = [...children(frameId)]

  // Empty frame: a plain type swap, nothing to extract.
  if (kids.length === 0) {
    await applyChanges([mod('node', frameId, { type: 'slot', views: [], activeView: undefined } as Partial<Node>)])
    return null
  }

  const width = frame.selrect?.width ?? frame.width ?? 400
  const height = frame.selrect?.height ?? frame.height ?? 300
  const fx = frame.selrect?.x ?? frame.x ?? 0
  const fy = frame.selrect?.y ?? frame.y ?? 0
  const dx = width + VIEW_GAP

  const view = createFrame({
    name: `${frame.name ?? 'Frame'} view`,
    x: fx + dx,
    y: fy,
    width,
    height,
    fillColor: '#FFFFFF',
    fillOpacity: 1,
  })

  // Collected before any change is applied, so it reflects the original tree.
  const moved = descendants(frameId)

  // Shift the extracted content by the same delta as the new frame.
  const shift = translateMatrix(dx, 0)
  const shifts: Change[] = []
  for (const id of moved) {
    const node = getNode(id)
    if (!node) continue
    const partial = applyTransformToNode(node, shift)
    if (partial) shifts.push(mod('node', id, partial as Partial<Node>))
  }

  const toSlot = mod('node', frameId, { type: 'slot', views: [view.id], activeView: view.id } as Partial<Node>)

  // The view must be a record before `moveNodes` can frame the children under
  // it, so it lands in its own commit; the group folds both into one frame.
  const group = `convert-frame-to-slot:${frameId}`
  beginGroup(group)
  try {
    await applyChanges([addNode(view, { page: pageId })])
    await applyChanges([...moveNodes(kids, { page: pageId, parentId: view.id, index: 0 }), ...shifts, toSlot])
  } finally {
    endGroup(group)
  }
  return view.id
}

/**
 * Turn a slot back into an ordinary frame.
 *
 * Not a true inverse of {@link convertFrameToSlot}: a view has stable identity
 * and may be shown by several slots, so the slot's views are left alone as the
 * independent frames they already are rather than being consumed back into the
 * frame. The result is an empty frame with the slot's box.
 */
export async function convertSlotToFrame(slotId: string): Promise<boolean> {
  const slot = getNode(slotId)
  if (!isSlotShape(slot)) return false

  await applyChanges([mod('node', slotId, { type: 'frame', views: undefined, activeView: undefined } as Partial<Node>)])
  return true
}

/** Layer name for a view id, for display in the slot panel. Falls back to the id. */
export function viewName(viewId: string): string {
  return getNode(viewId)?.name ?? viewId.slice(0, 8)
}

/** Select the underlying view frame on canvas (double-click-into affordance). */
export function selectView(viewId: string): void {
  setSelectedIds(new Set([viewId]))
}
