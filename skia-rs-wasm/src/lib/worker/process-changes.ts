/**
 * Incremental change processing for the worker index.
 * Mirrors common/src/app/common/files/changes.cljc for add-obj, mod-obj, del-obj, reorder-children.
 */

import type { PenpotNode } from '@penpot-exporter/types'
import type { IndexedPage } from './types'
import type { IndexChange } from '@skia-rs-wasm/common'
import { ZERO_UUID } from './types'

/** Operation for mod-obj: assign merges multiple attrs, set sets single attr */
export interface AssignOperation {
  type: 'assign'
  value: Record<string, unknown>
  ignoreTouched?: boolean
  ignoreGeometry?: boolean
}

export interface SetOperation {
  type: 'set'
  attr: string
  val: unknown
  ignoreTouched?: boolean
  ignoreGeometry?: boolean
}

export type Operation = AssignOperation | SetOperation

/** Normalized change for internal processing */
export interface AddObjChange {
  type: 'add-obj'
  id: string
  obj: PenpotNode
  pageId?: string
  frameId?: string
  parentId?: string
  index?: number
  ignoreTouched?: boolean
}

export interface ModObjChange {
  type: 'mod-obj'
  id: string
  pageId?: string
  operations: Operation[]
}

export interface DelObjChange {
  type: 'del-obj'
  id: string
  pageId?: string
  ignoreTouched?: boolean
}

export interface ReorderChildrenChange {
  type: 'reorder-children'
  pageId?: string
  parentId: string
  shapes: string[]
}

export type Change = AddObjChange | ModObjChange | DelObjChange | ReorderChildrenChange

/** Normalize IndexChange from common/types to internal Change format */
function normalizeChange(c: IndexChange): Change | null {
  const type = c.type
  if (!type || !['add-obj', 'mod-obj', 'del-obj', 'reorder-children'].includes(type)) return null

  const pageId = c.pageId
  if (!pageId) return null

  const base = { pageId } as Record<string, unknown>

  if (type === 'add-obj') {
    if (!c.id || !c.obj) return null
    return { ...base, type, id: c.id, obj: c.obj, frameId: c.frameId, parentId: c.parentId, index: c.index } as AddObjChange
  }
  if (type === 'mod-obj') {
    if (!c.id || !Array.isArray(c.operations)) return null
    return { ...base, type, id: c.id, operations: c.operations } as ModObjChange
  }
  if (type === 'del-obj') {
    if (!c.id) return null
    return { ...base, type, id: c.id } as DelObjChange
  }
  if (type === 'reorder-children') {
    if (!c.parentId || !Array.isArray(c.shapes)) return null
    return { ...base, type, parentId: c.parentId, shapes: c.shapes } as ReorderChildrenChange
  }
  return null
}

/** Data structure for processChanges: pages-index keyed by page-id */
export interface PagesIndexData {
  pagesIndex: Record<string, IndexedPage>
}

function getChildrenIds(objects: Record<string, PenpotNode>, shapeId: string): string[] {
  const shape = objects[shapeId]
  if (!shape || !shape.shapes) return []
  const result: string[] = []
  const stack = [...shape.shapes]
  while (stack.length > 0) {
    const id = stack.pop()!
    result.push(id)
    const child = objects[id]
    if (child?.shapes) stack.push(...child.shapes)
  }
  return result
}

function insertAtIndex(arr: string[], index: number, items: string[]): string[] {
  const copy = [...arr]
  copy.splice(index, 0, ...items)
  return copy
}

function processOperation(shape: PenpotNode, op: Operation): PenpotNode {
  if (op.type === 'assign') {
    const value = op.value as Record<string, unknown>
    return { ...shape, ...value } as PenpotNode
  }
  if (op.type === 'set') {
    return { ...shape, [op.attr]: op.val } as PenpotNode
  }
  return shape
}

function processAddObj(
  page: IndexedPage,
  change: AddObjChange
): IndexedPage {
  const { id, obj, frameId, parentId, index } = change
  const objects = { ...page.objects }

  const effectiveParentId = parentId ?? frameId ?? ZERO_UUID
  const effectiveFrameId = frameId ?? (objects[effectiveParentId] ? effectiveParentId : ZERO_UUID)

  const shapeWithRefs = {
    ...obj,
    id,
    'frame-id': effectiveFrameId in objects ? effectiveFrameId : ZERO_UUID,
    'parent-id': effectiveParentId in objects ? effectiveParentId : ZERO_UUID,
  } as PenpotNode

  objects[id] = shapeWithRefs

  const parent = objects[effectiveParentId]
  if (parent) {
    const shapes = parent.shapes ?? []
    const newShapes =
      index != null
        ? insertAtIndex(shapes, index, [id])
        : [...shapes, id]
    objects[effectiveParentId] = { ...parent, shapes: newShapes } as PenpotNode
  }

  return { ...page, objects }
}

function processModObj(
  page: IndexedPage,
  change: ModObjChange
): IndexedPage {
  const { id, operations } = change
  const objects = { ...page.objects }
  const shape = objects[id]
  if (!shape) return page

  let updated = shape
  for (const op of operations) {
    updated = processOperation(updated, op)
  }
  objects[id] = updated
  return { ...page, objects }
}

function processDelObj(
  page: IndexedPage,
  change: DelObjChange
): IndexedPage {
  const { id } = change
  const objects = { ...page.objects }
  const target = objects[id]
  if (!target) return page

  const childrenIds = getChildrenIds(objects, id)
  const toRemove = new Set([id, ...childrenIds])

  const newObjects: Record<string, PenpotNode> = {}
  for (const [k, v] of Object.entries(objects)) {
    if (!toRemove.has(k)) newObjects[k] = v
  }

  const parentId = (target as { 'parent-id'?: string })['parent-id'] ?? (target as { 'frame-id'?: string })['frame-id']
  if (parentId && newObjects[parentId]) {
    const parent = newObjects[parentId]
    const shapes = (parent.shapes ?? []).filter((sid) => !toRemove.has(sid))
    newObjects[parentId] = { ...parent, shapes } as PenpotNode
  }

  return { ...page, objects: newObjects }
}

function processReorderChildren(
  page: IndexedPage,
  change: ReorderChildrenChange
): IndexedPage {
  const { parentId, shapes: newOrder } = change
  const objects = { ...page.objects }
  const parent = objects[parentId]
  if (!parent) return page

  const oldShapes = parent.shapes ?? []
  const idToIdx = new Map<string, number>()
  newOrder.forEach((id, idx) => idToIdx.set(id, idx))

  const sorted = [...oldShapes].sort(
    (a, b) => (idToIdx.get(a) ?? -1) - (idToIdx.get(b) ?? -1)
  )

  if (JSON.stringify(sorted) === JSON.stringify(oldShapes)) return page

  objects[parentId] = { ...parent, shapes: sorted } as PenpotNode
  return { ...page, objects }
}

function getPageId(change: Change): string | undefined {
  return (change as { pageId?: string }).pageId
}

function processChange(
  data: PagesIndexData,
  change: Change
): PagesIndexData {
  const pageId = getPageId(change)
  if (!pageId) return data

  const page = data.pagesIndex[pageId]
  if (!page) return data

  let newPage: IndexedPage
  switch (change.type) {
    case 'add-obj':
      newPage = processAddObj(page, change)
      break
    case 'mod-obj':
      newPage = processModObj(page, change)
      break
    case 'del-obj':
      newPage = processDelObj(page, change)
      break
    case 'reorder-children':
      newPage = processReorderChildren(page, change)
      break
    default:
      return data
  }

  return {
    ...data,
    pagesIndex: {
      ...data.pagesIndex,
      [pageId]: newPage,
    },
  }
}

/**
 * Apply a sequence of changes to the pages-index data.
 * Returns updated data. Does not mutate input.
 * Accepts IndexChange[] (from common) or Change[] (internal).
 */
export function processChanges(
  data: PagesIndexData,
  changes: IndexChange[] | Change[]
): PagesIndexData {
  const normalized = changes
    .map((c) => normalizeChange(c as IndexChange))
    .filter((c): c is Change => c != null)
  return normalized.reduce((acc, change) => processChange(acc, change), data)
}
