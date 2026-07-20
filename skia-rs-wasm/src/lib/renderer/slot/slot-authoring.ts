/**
 * Higher-level slot authoring actions — the ones that create or restructure
 * document nodes (as opposed to slot-edit.ts, which only mutates a slot's view
 * references). Kept separate so slot-edit stays a thin, side-effect-light
 * write-path and this module owns the node-creation plumbing (createFrame +
 * add-obj commit) it composes with.
 */
import { snapshot } from 'valtio'
import { docProxy, getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { setSelectedIds } from '../store/document-selection'
import { applyChanges } from '../../page-crud'
import { createFrame } from '../node-factory'
import { getCommittedNodeOnActivePage } from '../properties/commit-node-properties'
import { isSlotShape } from '../../worker/geometry/shapes'
import { setActiveView } from './slot-edit'
import type { AddObjChange, DelObjChange, PenpotNode } from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Ordinal for the default name of the Nth view created for a slot. */
function nextViewName(existing: number): string {
  return `View ${existing + 1}`
}

/**
 * Create a fresh, pre-sized view frame and register it as the slot's active view.
 *
 * The new frame is a top-level sibling (parented to the page root, like any
 * board): a view has stable identity and lives outside the slot, which merely
 * references it. It is sized to the slot's box and offset to sit just to the
 * slot's right so it is visible on canvas rather than hidden under the outlet.
 *
 * Two history frames (add-obj, then the slot's mod-obj) — creating the frame is
 * independently undoable from wiring it up. Returns the new view id, or null if
 * there is no active page or the target is not a slot.
 */
export async function addNewViewToSlot(slotId: string): Promise<string | null> {
  const slot = getCommittedNodeOnActivePage(slotId)
  if (!isSlotShape(slot)) return null

  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const page = getPage(pageId)
  if (!page) return null
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID

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
    parentId: rootId,
    fillColor: '#FFFFFF',
    fillOpacity: 1,
  })

  const addChange: AddObjChange = {
    type: 'add-obj',
    id: view.id,
    obj: view,
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  const undoChange: DelObjChange = { type: 'del-obj', id: view.id, pageId }
  await applyChanges([addChange], { undoChanges: [undoChange] })

  // Register + make it the active view (defaults it if the slot was empty).
  await setActiveView(slotId, view.id)
  return view.id
}

/** Layer name for a view id, for display in the slot panel. Falls back to the id. */
export function viewName(viewId: string): string {
  const objects = snapshot(docProxy).currentPageId
    ? getPage(snapshot(docProxy).currentPageId as string)?.objects
    : undefined
  const node = objects?.[viewId] as PenpotNode | undefined
  return node?.name ?? viewId.slice(0, 8)
}

/** Select the underlying view frame on canvas (double-click-into affordance). */
export function selectView(viewId: string): void {
  setSelectedIds(new Set([viewId]))
}
