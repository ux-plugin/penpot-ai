/**
 * Point query for node selection.
 * Mirrors frontend: small rect around cursor, then pick topmost node by z-order.
 */

import type { WorkerClient } from '../../worker/types'
import { makeSelrect } from '../../worker/types'
import { descendants } from '../../doc'
import { screenToWorld, type ViewportData } from '../viewport'

const POINT_QUERY_SIZE_SCREEN = 5
/** Minimum half-size in world units so hit-test has tolerance after zoom/pan. */
const MIN_HALF_WORLD = 12

/**
 * Build a small world rect around the point (mirror frontend center->rect point (/ 5 zoom)).
 * Returns ids of nodes overlapping that rect.
 * Uses a minimum world-space half size so selection remains reliable after zoom.
 */
export async function queryNodesAtPoint(
  workerClient: WorkerClient,
  pageId: string,
  viewport: ViewportData,
  screenX: number,
  screenY: number,
): Promise<string[]> {
  const center = screenToWorld(viewport, screenX, screenY)
  const half = Math.max(POINT_QUERY_SIZE_SCREEN / viewport.zoom, MIN_HALF_WORLD)
  const rect = makeSelrect(
    center.x - half,
    center.y - half,
    half * 2,
    half * 2
  )
  const result = await workerClient.sendMessage('index/query-selection', {
    pageId,
    rect,
    includeFrames: true,
    fullFrame: false,
    usingSelrect: false,
  })
  if (result === null || !Array.isArray(result)) return []
  return result
}

/**
 * From the set of overlapping ids, return the one that appears last in depth-first order (topmost).
 */
export function pickTopmostNode(pageId: string | null | undefined, ids: string[]): string | null {
  if (!pageId || !ids.length) return null
  // Depth first, parents before children: draw order, last = top.
  const order = descendants(pageId)
  let lastIndex = -1
  let topId: string | null = null
  for (const id of ids) {
    const idx = order.indexOf(id)
    if (idx > lastIndex) {
      lastIndex = idx
      topId = id
    }
  }
  return topId
}
