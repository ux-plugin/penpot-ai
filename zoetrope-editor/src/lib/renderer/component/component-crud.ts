/**
 * Component CRUD — create a component from a frame, place a copy of it, and
 * detach a copy back into ordinary shapes.
 *
 * Structure follows upstream Penpot: a component's library record points at a
 * *main instance*, which is an ordinary frame living on a page (not a private
 * copy of the tree), and a copy is a real duplicated subtree whose every node
 * carries `shapeRef` naming its twin in the main. Nothing here is projected or
 * virtual, so selection, hit-test, layout and the layers panel need no knowledge
 * of components.
 *
 * Each operation is ONE history frame spanning both commit arms: the page
 * `Change[]` that edits shapes and the `DocMetaChange[]` that edits the library
 * on `docProxy.meta`. `commitChanges` records the pair together, so a single
 * Cmd+Z reverts the shape edit and the library edit atomically — the same
 * arrangement token CRUD uses (see tokens/crud.ts).
 *
 * Sync (main edits fanning out into copies) is NOT here — that is P3.
 */
import { snapshot } from 'valtio'
import { docProxy, getActiveOrSinglePageId } from '../store/doc-proxy'
import { commitChanges } from '../store/commit'
import { newShapeId } from '../../common/shape-id'
import { subtreeWithRoot } from '../../common/subtree'
import { isUsableComponent, type LocalComponent } from '../../common/component'
import { isComponentCopyRoot, isComponentMain } from '../../worker/geometry/shapes'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { translateMatrix } from '../geom/matrix'
import type { IndexedShape } from '../../worker/types'
import type {
  AddObjChange,
  Change,
  DelObjChange,
  ModObjChange,
  PenpotNode,
} from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Gap between a main instance and a copy placed beside it. */
const COPY_GAP = 40

/** The component fields a copy wears; cleared as a unit on detach. */
const COMPONENT_FIELDS = [
  'componentId',
  'componentFile',
  'componentRoot',
  'mainInstance',
  'shapeRef',
  'touched',
  'remoteSynced',
] as const

/** A `mod-obj` that merges `assign` into the node (the pipeline's 'assign' op). */
function modObj(pageId: string, id: string, assign: Record<string, unknown>): ModObjChange {
  return { type: 'mod-obj', id, pageId, operations: [{ type: 'assign', value: assign }] }
}

/**
 * Read the page's objects through a valtio *snapshot*, never the live proxy: the
 * undo vector deep-clones geometry with `structuredClone`, which rejects a proxy
 * with DataCloneError.
 */
function readObjects(pageId: string): Record<string, IndexedShape> | undefined {
  return snapshot(docProxy).pageMap.get(pageId)?.objects as
    | Record<string, IndexedShape>
    | undefined
}

/** Components in the library that are ours and actionable. */
export function listComponents(): LocalComponent[] {
  const components = snapshot(docProxy).meta?.components as
    | Record<string, LocalComponent>
    | undefined
  return Object.values(components ?? {}).filter(isUsableComponent)
}

export function getComponent(componentId: string): LocalComponent | undefined {
  const components = snapshot(docProxy).meta?.components as
    | Record<string, LocalComponent>
    | undefined
  const found = components?.[componentId]
  return isUsableComponent(found) ? found : undefined
}

/**
 * Promote an existing frame to a component's main instance, in place.
 *
 * The frame keeps its id, box and children — anything already pointing at it
 * (an interaction target, a layout parent) keeps working. It simply gains the
 * component fields and a library record naming it.
 *
 * Returns the new component id, or null when the target is not a promotable
 * frame (the page root, a frame that is already a main, or a node inside a copy).
 */
export async function createComponentFromFrame(frameId: string): Promise<string | null> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const objects = readObjects(pageId)
  if (!objects) return null

  const frame = objects[frameId] as PenpotNode | undefined
  if (!frame || frame.type !== 'frame') return null
  // The page root is the canvas itself, never a component.
  if (frame.parentId == null || frameId === ROOT_UUID) return null
  // Already a main, or living inside a copy — neither is promotable.
  if (isComponentMain(frame) || frame.componentId != null || frame.shapeRef != null) return null

  const componentId = newShapeId()
  const component: LocalComponent = {
    id: componentId,
    name: frame.name ?? 'Component',
    path: '',
    mainInstanceId: frameId,
    mainInstancePage: pageId,
    props: [],
  }

  await commitChanges({
    pageId,
    redoChanges: [
      modObj(pageId, frameId, { componentId, componentRoot: true, mainInstance: true }),
    ],
    undoChanges: [
      modObj(pageId, frameId, {
        componentId: undefined,
        componentRoot: undefined,
        mainInstance: undefined,
      }),
    ],
    docMetaRedoChanges: [{ type: 'add-component', component }],
    docMetaUndoChanges: [{ type: 'del-component', id: componentId }],
  })
  return componentId
}

/**
 * Place a copy of a component on the current page.
 *
 * The main's subtree is duplicated with fresh ids; every copied node records
 * `shapeRef` pointing at the node it was copied from, which is what lets P3 sync
 * a main edit into this copy and P4 remember which attributes the user has
 * locally overridden. Shapes carry absolute coordinates, so the whole subtree is
 * translated by the same delta.
 *
 * One history frame: undo is a single `del-obj` on the copy root, which cascades
 * to the descendants and detaches it from its parent.
 *
 * Returns the copy's root id, or null when the component is unknown or its main
 * has gone missing.
 */
export async function instantiateComponent(
  componentId: string,
  at?: { x: number; y: number },
): Promise<string | null> {
  const component = getComponent(componentId)
  if (!component) return null

  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const objects = readObjects(pageId)
  if (!objects) return null
  // The main may live on another page; copies are placed on the current one, but
  // the tree has to be read from wherever the main actually is.
  const mainObjects =
    component.mainInstancePage === pageId
      ? objects
      : (snapshot(docProxy).pageMap.get(component.mainInstancePage)?.objects as
          | Record<string, IndexedShape>
          | undefined)
  const main = mainObjects?.[component.mainInstanceId] as PenpotNode | undefined
  if (!mainObjects || !main) return null

  const root = Object.values(objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID

  const mainX = main.selrect?.x ?? main.x ?? 0
  const mainY = main.selrect?.y ?? main.y ?? 0
  const width = main.selrect?.width ?? main.width ?? 0
  const dx = (at?.x ?? mainX + width + COPY_GAP) - mainX
  const dy = (at?.y ?? mainY) - mainY
  const shift = translateMatrix(dx, dy)

  // Root-first, parents always before their descendants — `processAddObj`
  // resolves each node's parent as it lands, so the order matters.
  const sourceIds = subtreeWithRoot(mainObjects, component.mainInstanceId)
  const idMap = new Map<string, string>(sourceIds.map((id) => [id, newShapeId()]))

  const adds: AddObjChange[] = []
  for (const srcId of sourceIds) {
    const src = mainObjects[srcId] as PenpotNode | undefined
    if (!src) continue
    const id = idMap.get(srcId)!
    const isRoot = srcId === component.mainInstanceId
    const parentId = isRoot ? rootId : (idMap.get(src.parentId ?? '') ?? rootId)
    const geometry = (applyTransformToNode(src, shift) ?? {}) as Partial<PenpotNode>
    const children = (src as { shapes?: string[] }).shapes
      ?.map((cid) => idMap.get(cid))
      .filter((cid): cid is string => cid != null)

    const clone = {
      ...(src as Record<string, unknown>),
      ...geometry,
      id,
      parentId,
      // A frame is its own frame; anything else belongs to the nearest frame,
      // which `processAddObj` resolves from `frameId` below.
      frameId: src.type === 'frame' ? id : parentId,
      shapes: children,
      // Every node in a copy names its twin in the main.
      shapeRef: srcId,
      // Local overrides start empty — nothing has been touched yet.
      touched: undefined,
      // Only the root carries the component link; a copy has exactly one root,
      // and the main flag never travels with a copy.
      componentId: isRoot ? componentId : undefined,
      componentRoot: isRoot ? true : undefined,
      mainInstance: undefined,
    } as unknown as PenpotNode

    adds.push({
      type: 'add-obj',
      id,
      obj: clone,
      frameId: parentId,
      parentId,
      index: isRoot ? (root?.shapes?.length ?? 0) : undefined,
      pageId,
    })
  }
  if (adds.length === 0) return null

  const copyRootId = idMap.get(component.mainInstanceId)!
  const del: DelObjChange = { type: 'del-obj', id: copyRootId, pageId }
  await commitChanges({ pageId, redoChanges: adds, undoChanges: [del] })
  return copyRootId
}

/**
 * Detach a copy: strip the component fields from its whole subtree, leaving
 * ordinary shapes that no longer track the main.
 *
 * This is the escape hatch for anything the declared property surface can't
 * express — the equivalent of Unity's "unpack prefab". Refuses a main instance,
 * where the intent would be to delete the component instead.
 */
export async function detachCopy(copyRootId: string): Promise<boolean> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return false
  const objects = readObjects(pageId)
  if (!objects) return false

  const rootNode = objects[copyRootId] as PenpotNode | undefined
  if (!isComponentCopyRoot(rootNode)) return false

  const cleared: Record<string, unknown> = {}
  for (const field of COMPONENT_FIELDS) cleared[field] = undefined

  const redo: Change[] = []
  const undo: Change[] = []
  for (const id of subtreeWithRoot(objects, copyRootId)) {
    const node = objects[id] as PenpotNode | undefined
    if (!node) continue
    // Restore exactly what each node had — the root and its descendants carry
    // different subsets of the fields.
    const previous: Record<string, unknown> = {}
    for (const field of COMPONENT_FIELDS) previous[field] = node[field]
    redo.push(modObj(pageId, id, cleared))
    undo.unshift(modObj(pageId, id, previous))
  }
  if (redo.length === 0) return false

  await commitChanges({ pageId, redoChanges: redo, undoChanges: undo })
  return true
}

/**
 * Delete a component's library record and detach its main instance, leaving the
 * frame itself on the canvas. Existing copies are detached too — with the record
 * gone there is nothing left for them to track.
 */
export async function deleteComponent(componentId: string): Promise<boolean> {
  const component = getComponent(componentId)
  if (!component) return false

  const pageId = getActiveOrSinglePageId()
  if (!pageId) return false
  const objects = readObjects(pageId)
  if (!objects) return false

  const cleared: Record<string, unknown> = {}
  for (const field of COMPONENT_FIELDS) cleared[field] = undefined

  const redo: Change[] = []
  const undo: Change[] = []
  for (const [id, node] of Object.entries(objects)) {
    const shape = node as PenpotNode
    const inThisComponent =
      shape.componentId === componentId ||
      (shape.shapeRef != null && isPartOfComponent(objects, shape, componentId))
    if (!inThisComponent) continue
    const previous: Record<string, unknown> = {}
    for (const field of COMPONENT_FIELDS) previous[field] = shape[field]
    redo.push(modObj(pageId, id, cleared))
    undo.unshift(modObj(pageId, id, previous))
  }

  await commitChanges({
    pageId,
    redoChanges: redo,
    undoChanges: undo,
    docMetaRedoChanges: [{ type: 'del-component', id: componentId }],
    docMetaUndoChanges: [{ type: 'add-component', component }],
  })
  return true
}

/** Walk up to the copy root to decide whether a `shapeRef`-bearing node belongs to `componentId`. */
function isPartOfComponent(
  objects: Record<string, IndexedShape>,
  shape: PenpotNode,
  componentId: string,
): boolean {
  let current: PenpotNode | undefined = shape
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.componentId != null) return current.componentId === componentId
    const parentId: string | undefined = current.parentId
    current = parentId ? (objects[parentId] as PenpotNode | undefined) : undefined
  }
  return false
}
