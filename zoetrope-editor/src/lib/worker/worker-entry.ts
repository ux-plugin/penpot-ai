/**
 * Main worker entry point: the hit-test index. Holds its own copy of each
 * page (`page-store.ts`) fed by the document's change ops.
 */

import type {
  WorkerState,
  WorkerPage,
  QueryParams,
  WorkerMessage,
  SerializedMessage,
  WorkerUpdateTextRectPayload,
  WorkerIndexApplyPayload,
} from './types'
import type { Point, Matrix } from 'penpot-exporter/types'
import { applyToPage } from './page-store'
import { handler, registerHandler } from './impl'
import { encode, decode } from './messages'
import * as selection from './selection'
import { makeRect, rectToPoints, pointsToRect } from './geometry/rect'
import { shapeToCenter } from './geometry/shapes'
import { point } from './geometry/point'

const state: WorkerState = {
  pages: {},
  selection: {},
  textRect: {},
  hitIds: {},
}

function identityTransform(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

function transformPoint(pt: Point, transform: Matrix): Point {
  const { a, b, c, d, e, f } = transform
  return point(a * pt.x + c * pt.y + e, b * pt.x + d * pt.y + f)
}

registerHandler('index/clear', () => {
  state.pages = {}
  state.selection = {}
  state.textRect = {}
  return null
})

registerHandler('index/initialize', (message: WorkerMessage) => {
  const page = (message.payload as { page?: WorkerPage } | undefined)?.page
  if (!page) return null
  try {
    state.pages[page.id] = page
    state.selection = selection.addPage(state.selection, page.id, page.objects)
    return null
  } catch (error) {
    console.error('Error initializing page index:', error)
    return null
  }
})

registerHandler('index/apply', (message: WorkerMessage) => {
  const payload = message.payload as WorkerIndexApplyPayload | undefined
  if (!payload?.pageId || !payload.changes?.length) return null
  try {
    const page = state.pages[payload.pageId]
    if (!page) return null
    const objects = applyToPage(page, payload.changes)
    state.pages[payload.pageId] = { id: page.id, objects }
    state.selection = selection.updatePage(state.selection, page.id, page.objects, objects)
    return null
  } catch (error) {
    console.error('Error updating page index:', error)
    return null
  }
})

registerHandler('index/query-selection', (message: WorkerMessage) => {
  const params = message.payload as QueryParams
  if (!params) return []
  try {
    return Array.from(selection.query(state.selection, params))
  } catch (error) {
    console.error('Error querying selection:', error)
    return []
  }
})

registerHandler('index/update-text-rect', (message: WorkerMessage) => {
  const payload = message.payload as WorkerUpdateTextRectPayload | undefined
  const { pageId, shapeId, dimensions } = payload ?? {}
  if (!pageId || !shapeId || !dimensions) return null

  try {
    const page = state.pages[pageId]
    const shape = page?.objects[shapeId]
    if (!page || !shape) return null

    const center = shapeToCenter(shape)
    if (!center) return null
    const transform = shape.transform || identityTransform()
    const rect = makeRect(dimensions.x ?? 0, dimensions.y ?? 0, dimensions.width ?? 0, dimensions.height ?? 0)
    const rectPoints = rectToPoints(rect)
    if (!rectPoints) return null
    const points = rectPoints.map((pt) => {
      const t = transformPoint(pt, transform)
      return point(t.x + center.x, t.y + center.y)
    })
    const selrect = pointsToRect(points)
    if (!selrect) return null

    const updatedShape = { ...shape, positionData: undefined, points, selrect }
    const objects = { ...page.objects, [shapeId]: updatedShape }
    state.pages[pageId] = { id: pageId, objects }

    state.textRect ??= {}
    state.textRect[pageId] ??= {}
    state.textRect[pageId][shapeId] = { positionData: undefined, points, selrect }

    const pageSelection = state.selection[pageId]
    if (pageSelection) {
      state.selection[pageId] = selection.updateIndexSingle(pageSelection, objects, updatedShape)
    }
    return null
  } catch (error) {
    console.error('Error updating text rect:', error)
    return null
  }
})

registerHandler('index/hit-transforms', (message: WorkerMessage) => {
  const payload = message.payload as { pageId?: string; transforms?: Array<[string, Matrix]> } | undefined
  const pageId = payload?.pageId
  const transforms = payload?.transforms
  if (!pageId || !transforms) return null

  const page = state.pages[pageId]
  let pageSel = state.selection[pageId]
  if (!page || !pageSel) return null
  const objects = page.objects

  const prev = state.hitIds?.[pageId] ?? new Set<string>()
  const nextIds = new Set<string>(transforms.map(([id]) => id).filter((id) => objects[id]))

  for (const id of prev) {
    if (!nextIds.has(id) && objects[id]) pageSel = selection.updateIndexSingle(pageSel, objects, objects[id])
  }
  for (const [id, matrix] of transforms) {
    const base = objects[id]
    if (!base) continue
    pageSel = selection.updateIndexSingle(pageSel, objects, { ...base, hitTransform: matrix })
  }

  state.selection[pageId] = pageSel
  state.hitIds ??= {}
  state.hitIds[pageId] = nextIds
  return null
})

registerHandler('index/clear-hit-transforms', (message: WorkerMessage) => {
  const pageId = (message.payload as { pageId?: string } | undefined)?.pageId
  if (!pageId) return null
  const prev = state.hitIds?.[pageId]
  const page = state.pages[pageId]
  let pageSel = state.selection[pageId]
  if (prev && page && pageSel) {
    for (const id of prev) {
      if (page.objects[id]) pageSel = selection.updateIndexSingle(pageSel, page.objects, page.objects[id])
    }
    state.selection[pageId] = pageSel
  }
  if (state.hitIds) state.hitIds[pageId] = new Set()
  return null
})

self.addEventListener('message', (event: MessageEvent) => {
  const raw = event.data as SerializedMessage
  const replyTo = raw?.replyTo
  try {
    const message = decode(raw)
    const result = handler(message)
    if (replyTo) {
      self.postMessage(encode({ cmd: message.cmd, replyTo, payload: result ?? null }))
    }
  } catch (error) {
    console.error('Error handling worker message:', error)
    self.postMessage({
      cmd: 'error',
      replyTo: replyTo ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

export { state, handler }
