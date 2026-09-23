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
 * Each operation is ONE history frame spanning both commit arms: the node
 * changes and the `DocMetaChange[]` that edits the library on `meta`. A single
 * Cmd+Z reverts both — the same arrangement token CRUD uses (see tokens/crud.ts).
 *
 * Sync (main edits fanning out into copies) is NOT here — that is P3.
 */
import { commitChanges } from '../store/commit'
import {
  add,
  descendants,
  getActiveOrSinglePageId,
  getNode,
  meta,
  mod,
  mods,
  placeNode,
  records,
  remap,
  type Change,
  type Node,
} from '../../doc'
import { newShapeId } from '../../common/shape-id'
import { isUsableComponent, type LocalComponent } from '../../common/component'
import { isComponentCopyRoot, isComponentMain } from '../../worker/geometry/shapes'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { translateMatrix } from '../geom/matrix'
import type { PenpotNode } from 'penpot-exporter/types'

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

const CLEARED: Partial<Node> = Object.fromEntries(COMPONENT_FIELDS.map((f) => [f, undefined]))

/** Components in the library that are ours and actionable. */
export function listComponents(): LocalComponent[] {
  return Object.values(meta.peek()?.components ?? {}).filter(isUsableComponent)
}

export function getComponent(componentId: string): LocalComponent | undefined {
  const found = meta.peek()?.components?.[componentId]
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
 * frame (a frame that is already a main, or a node inside a copy).
 */
export async function createComponentFromFrame(frameId: string): Promise<string | null> {
  const frame = getNode(frameId)
  if (!frame || frame.type !== 'frame') return null
  // Already a main, or living inside a copy — neither is promotable.
  if (isComponentMain(frame) || frame.componentId != null || frame.shapeRef != null) return null

  const componentId = newShapeId()
  const component: LocalComponent = {
    id: componentId,
    name: frame.name ?? 'Component',
    path: '',
    mainInstanceId: frameId,
    mainInstancePage: frame.page,
    props: [],
  }

  await commitChanges({
    changes: [mod('node', frameId, { componentId, componentRoot: true, mainInstance: true })],
    docMeta: [{ type: 'add-component', component }],
    docMetaUndo: [{ type: 'del-component', id: componentId }],
  })
  return componentId
}

/**
 * Place a copy of a component on the current page.
 *
 * The main's subtree is duplicated with fresh ids and `remap` rewrites every
 * reference inside it (parents, frames, a slot's views); every copied node
 * records `shapeRef` pointing at the node it was copied from, which is what lets P3 sync
 * a main edit into this copy and P4 remember which attributes the user has
 * locally overridden. Shapes carry absolute coordinates, so the whole subtree is
 * translated by the same delta.
 *
 * One history frame. Returns the copy's root id, or null when the component is
 * unknown or its main has gone missing.
 */
export async function instantiateComponent(
  componentId: string,
  at?: { x: number; y: number },
): Promise<string | null> {
  const component = getComponent(componentId)
  if (!component) return null

  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  // The main may live on another page; the copy lands on the current one.
  const main = getNode(component.mainInstanceId)
  if (!main) return null

  const mainX = main.selrect?.x ?? main.x ?? 0
  const mainY = main.selrect?.y ?? main.y ?? 0
  const width = main.selrect?.width ?? main.width ?? 0
  const dx = (at?.x ?? mainX + width + COPY_GAP) - mainX
  const dy = (at?.y ?? mainY) - mainY
  const shift = translateMatrix(dx, dy)

  const sourceIds = [main.id, ...descendants(main.id)]
  const idMap = new Map<string, string>(sourceIds.map((id) => [id, newShapeId()]))
  let root: Node | undefined

  const adds: Change[] = []
  for (const srcId of sourceIds) {
    const src = getNode(srcId)
    if (!src) continue
    const isRoot = srcId === main.id
    const geometry = (applyTransformToNode(src, shift) ?? {}) as Partial<PenpotNode>
    const moved = { ...remap('node', src, idMap), ...geometry } as Node
    const placed = isRoot
      ? (root = placeNode({ ...moved, parentId: undefined } as PenpotNode, { page: pageId }))
      : { ...moved, page: pageId, frameId: moved.frameId && idMap.has(src.frameId!) ? moved.frameId : root?.frameId }
    adds.push(
      add('node', {
        ...placed,
        id: idMap.get(srcId)!,
        shapeRef: srcId,
        touched: undefined,
        componentId: isRoot ? componentId : undefined,
        componentRoot: isRoot ? true : undefined,
        mainInstance: undefined,
      } as Node),
    )
  }
  if (adds.length === 0) return null

  await commitChanges({ changes: adds })
  return idMap.get(main.id)!
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
  if (!isComponentCopyRoot(getNode(copyRootId))) return false
  const ids = [copyRootId, ...descendants(copyRootId)]
  await commitChanges({ changes: [mods('node', ids, CLEARED)] })
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

  const ids: string[] = []
  for (const node of records('node')) {
    const inThisComponent =
      node.componentId === componentId ||
      (node.shapeRef != null && isPartOfComponent(node, componentId))
    if (inThisComponent) ids.push(node.id)
  }

  await commitChanges({
    changes: ids.length ? [mods('node', ids, CLEARED)] : [],
    docMeta: [{ type: 'del-component', id: componentId }],
    docMetaUndo: [{ type: 'add-component', component }],
  })
  return true
}

/** Walk up to the copy root to decide whether a `shapeRef`-bearing node belongs to `componentId`. */
function isPartOfComponent(node: Node, componentId: string): boolean {
  let current: Node | undefined = node
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.componentId != null) return current.componentId === componentId
    current = getNode(current.parentId)
  }
  return false
}
