/**
 * Worker-specific types. Shared types (Point, Line, Change) come from common.
 */

import type { PenpotNode, Selrect, Matrix } from 'penpot-exporter/types'
import type { Change } from 'penpot-exporter/types'
import type { Point } from '@skia-rs-wasm/common/types'
import type { Quadtree } from './quadtree'
import type { PageInteractions } from '../renderer/interactions/ir'
import type { Scene3DDocument } from '../renderer/three/scene3d-store'

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

/** Payload for configure command. */
export interface WorkerConfigurePayload {
  config: WorkerConfig
}

/** Payload for index/initialize command. */
export interface WorkerIndexInitializePayload {
  page: IndexedPage
}

/** Payload for index/update command (full page replacement). */
export interface WorkerIndexUpdatePayload {
  pageId: string
  page: IndexedPage
}

/** Payload for index/update command (incremental changes). */
export interface WorkerIndexUpdateWithChangesPayload {
  pageId: string
  changes: Change[]
}

/** Payload for index/update-text-rect command. */
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

/** Payload for index/clear-hit-transforms: drop the hit-transform overlay for a page. */
export interface WorkerClearHitTransformsPayload {
  pageId: string
}

/** Indexed shape: PenpotNode with optional child-id list (flat structure). Uses camelCase parentId/frameId from ShapeBaseAttributes. */
export type IndexedShape = PenpotNode & {
  shapes?: string[]
  /**
   * Embedded 3D scene (camera + environment + objects). Serializable, stored on
   * the scene container node so 3D state lives in the document: undoable via
   * mod-obj and carried by flatten/unflatten + any future save. Opaque to WASM —
   * `setObject` reads only known keys, so this field is never forwarded.
   */
  scene3d?: Scene3DDocument
}

/** Shape payload stored in selection quadtree (IndexedShape + frame, clipParents, parents). */
export type SelectionIndexShape = IndexedShape & {
  frame?: PenpotNode
  clipParents: PenpotNode[]
  parents: string[]
  /** Modifier-aware hit-test overlay: rest -> animated affine, set while a paused motion preview displaces the shape. */
  hitTransform?: Matrix
}

/** Alias for IndexedShape; canonical node type in indexed page model. */
export type IndexedNode = IndexedShape

/** Internal indexed page (flat objects map) used for selection/index state. Carries page metadata like PenpotPage. */
export interface IndexedPage {
  id: string
  name?: string
  background?: string
  objects: Record<string, IndexedShape>
  /** Per-page interactions (Build mode). Carried through flatten/unflatten. */
  interactions?: PageInteractions
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
  pagesIndex: Record<string, IndexedPage>
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

/** Payload shapes for WorkerClient.sendMessage by command. */
export type WorkerSendPayload =
  | WorkerConfigurePayload
  | WorkerIndexInitializePayload
  | WorkerIndexUpdatePayload
  | WorkerIndexUpdateWithChangesPayload
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
  addPage(page: IndexedPage): Promise<void>
  updatePage(pageId: string, page: IndexedPage): Promise<void>
  updatePageWithChanges(pageId: string, changes: Change[]): Promise<void>
  onMessage(callback: (message: WorkerMessage) => void): () => void
  destroy(): void
}

export { flattenPageToIndexed, unflattenIndexedPageToPage } from './flatten'
export { ZERO_UUID, makeSelrect } from '@skia-rs-wasm/common/conversions'
