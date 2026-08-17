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
import { buildReparentChanges } from '../../components/LayersPanel/reparent'
import { buildTransformModObjPair } from '../../changes/changes-builder'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { translateMatrix } from '../geom/matrix'
import { setActiveView } from './slot-edit'
import type { IndexedShape } from '../../worker/types'
import type {
  AddObjChange,
  Change,
  DelObjChange,
  ModObjChange,
  PenpotNode,
} from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Gap between a slot and the view frame extracted from / created for it. */
const VIEW_GAP = 40

/** A `mod-obj` that merges `assign` into the node (the pipeline's 'assign' op). */
function modObj(pageId: string, id: string, assign: Record<string, unknown>): ModObjChange {
  return { type: 'mod-obj', id, pageId, operations: [{ type: 'assign', value: assign }] }
}

/** Every descendant id of `rootId` (excluding it), depth-first. */
function subtreeOf(objects: Record<string, IndexedShape>, rootId: string): string[] {
  const out: string[] = []
  const stack = [...(objects[rootId]?.shapes ?? [])]
  while (stack.length) {
    const id = stack.pop()
    if (id == null) continue
    const node = objects[id]
    if (!node) continue
    out.push(id)
    for (const child of node.shapes ?? []) stack.push(child)
  }
  return out
}

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
  // Read through a valtio snapshot, not the live proxy: the undo vector deep-
  // clones geometry via structuredClone, which rejects a proxy (DataCloneError).
  const objects = snapshot(docProxy).pageMap.get(pageId)?.objects as
    | Record<string, IndexedShape>
    | undefined
  if (!objects) return null
  const frame = objects[frameId]
  if (!frame || frame.type !== 'frame') return null

  const root = Object.values(objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID
  // The page root is the canvas itself, never an outlet.
  if (frameId === rootId) return null

  const children = [...(frame.shapes ?? [])]

  // Empty frame: a plain type swap, nothing to extract.
  if (children.length === 0) {
    const redo = modObj(pageId, frameId, {
      type: 'slot',
      views: [],
      activeView: undefined,
      shapes: undefined,
    })
    const undo = modObj(pageId, frameId, {
      type: 'frame',
      shapes: [],
      views: undefined,
      activeView: undefined,
    })
    await applyChanges([redo], { pageId, undoChanges: [undo] })
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
    parentId: rootId,
    fillColor: '#FFFFFF',
    fillOpacity: 1,
  })

  // Collected before any change is applied, so it reflects the original tree.
  const moved = subtreeOf(objects, frameId)

  const addView: AddObjChange = {
    type: 'add-obj',
    id: view.id,
    obj: view,
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  const delView: DelObjChange = { type: 'del-obj', id: view.id, pageId }

  const reparent = buildReparentChanges({
    pageId,
    parentId: view.id,
    index: 0,
    shapeIds: children,
    objects,
  })

  // Shift the extracted content by the same delta as the new frame.
  const shift = translateMatrix(dx, 0)
  const shiftRedo: Change[] = []
  const shiftUndo: Change[] = []
  for (const id of moved) {
    const node = objects[id] as PenpotNode | undefined
    if (!node) continue
    const partial = applyTransformToNode(node, shift)
    if (!partial) continue
    const pair = buildTransformModObjPair(pageId, id, node, partial as Record<string, unknown>)
    shiftRedo.push(pair.redo)
    shiftUndo.unshift(pair.undo)
  }

  const toSlot = modObj(pageId, frameId, {
    type: 'slot',
    views: [view.id],
    activeView: view.id,
    shapes: undefined,
  })
  const toFrame = modObj(pageId, frameId, {
    type: 'frame',
    shapes: [],
    views: undefined,
    activeView: undefined,
  })

  // Undo replays in array order, so it mirrors redo backwards: become a frame
  // again, un-shift the content, move it home, then drop the now-empty view.
  await applyChanges(
    [addView, ...reparent.redoChanges, ...shiftRedo, toSlot],
    {
      pageId,
      undoChanges: [toFrame, ...shiftUndo, ...reparent.undoChanges, delView],
    },
  )
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
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return false
  const slot = getCommittedNodeOnActivePage(slotId)
  if (!isSlotShape(slot)) return false

  const redo = modObj(pageId, slotId, {
    type: 'frame',
    shapes: [],
    views: undefined,
    activeView: undefined,
  })
  const undo = modObj(pageId, slotId, {
    type: 'slot',
    views: [...slot.views],
    activeView: slot.activeView,
    shapes: undefined,
  })
  await applyChanges([redo], { pageId, undoChanges: [undo] })
  return true
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
