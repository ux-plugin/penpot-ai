/**
 * Worker-specific types. Node and change types come from `doc`.
 */

import type { PenpotNode, Selrect, Matrix } from 'penpot-exporter/types'
import type { Point } from '@zoetrope-editor/common/types'
import type { Quadtree } from './quadtree'
import type { Change, PageObjects, TreeNode } from '../doc'

/** Worker configuration (keys logged only; shape extensible). */
export type WorkerConfig = Record<string, unknown>

/** Dimensions for index/update-text-rect. */
export interface WorkerTextRectDimensions {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** In-memory text rect cache value (dimensions plus optional layout data). */
export type WorkerTextRectCacheValue = WorkerTextRectDimensions & {
  positionData?: unknown
  points?: unknown
  selrect?: unknown
}

export interface WorkerConfigurePayload {
  config: WorkerConfig
}

/** Payload for index/initialize: a whole page. */
export interface WorkerIndexInitializePayload {
  page: WorkerPage
}

/** Payload for index/apply: node changes of one page. */
export interface WorkerIndexApplyPayload {
  pageId: string
  changes: Change[]
}

export interface WorkerUpdateTextRectPayload {
  pageId: string
  shapeId: string
  dimensions: WorkerTextRectDimensions
}

/** Payload for index/hit-transforms: per-shape rest->animated matrices overlaid on the index (paused motion). */
export interface WorkerHitTransformsPayload {
  pageId: string
  transforms: Array<[string, Matrix]>
}

export interface WorkerClearHitTransformsPayload {
  pageId: string
}

/** The worker's copy of a page: nodes by id with child lists and the synthetic root. */
export interface WorkerPage {
  id: string
  objects: PageObjects
}

/** Shape payload stored in selection quadtree (node + frame, clipParents, parents). */
export type SelectionIndexShape = TreeNode & {
  frame?: PenpotNode
  clipParents: PenpotNode[]
  parents: string[]
  /** Modifier-aware hit-test overlay: rest -> animated affine, set while a paused motion preview displaces the shape. */
  hitTransform?: Matrix
}

export interface QueryParams {
  pageId: string
  rect: Selrect
  frameId?: string
  fullFrame?: boolean
  includeFrames?: boolean
  ignoreGroups?: boolean
  clipChildren?: boolean
  usingSelrect?: boolean
}

export interface SelectionIndex {
  index: Quadtree<SelectionIndexShape>
  bounds: Selrect
  parentsIndex: Record<string, Set<string>>
  clipIndex: Record<string, PenpotNode[]>
}

export interface WorkerState {
  pages: Record<string, WorkerPage>
  selection: Record<string, SelectionIndex>
  textRect?: Record<string, Record<string, WorkerTextRectCacheValue>>
  /** Per-page set of ids currently carrying a hit-transform overlay (to restore on clear/update). */
  hitIds?: Record<string, Set<string>>
}

/** Request/response correlation ID. Client generates unique values: client_${Date.now()}_${counter} */
export interface WorkerMessage {
  cmd: string
  replyTo: string
  payload?: unknown
  buffer?: boolean
}

export interface SerializedMessage {
  cmd: string
  replyTo: string
  payload?: unknown
  buffer?: boolean
}

export type Line = [Point, Point]

export type WorkerSendPayload =
  | WorkerConfigurePayload
  | WorkerIndexInitializePayload
  | WorkerIndexApplyPayload
  | QueryParams
  | WorkerUpdateTextRectPayload
  | WorkerHitTransformsPayload
  | WorkerClearHitTransformsPayload
  | undefined

/** Response from worker handlers (null or array of node ids for query-selection). */
export type WorkerResponse = null | string[]

export interface WorkerClient {
  sendMessage(cmd: string, payload?: WorkerSendPayload): Promise<WorkerResponse>
  configure(config: WorkerConfig): Promise<void>
  /** Load or replace a page. */
  initPage(page: WorkerPage): Promise<void>
  /** Apply node changes to a loaded page. */
  applyChanges(pageId: string, changes: Change[]): Promise<void>
  onMessage(callback: (message: WorkerMessage) => void): () => void
  destroy(): void
}

export { ZERO_UUID, makeSelrect } from '@zoetrope-editor/common/conversions'
