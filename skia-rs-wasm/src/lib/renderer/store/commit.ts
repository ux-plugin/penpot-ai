/**
 * Penpot-shaped commit pipeline: apply Change[] to docProxy and emit a
 * `changes-applied` event. Three subscribers (renderer-sync, worker-sync,
 * history-sync) consume the event independently — see `change-emitter.ts`.
 *
 * `commitChanges` itself does no renderer/worker/history work.
 */

import type { IndexedPage } from '../../worker/types'
import type { Change } from 'penpot-exporter/types'
import { processChanges } from '../../worker/process-changes'
import { useWorkspaceStore } from './workspace-store'
import type { CommitChangesParams } from '../../changes/commit-types'
import { assertValidAddObjChange } from '../../common/shape-id'
import { docProxy, getActiveOrSinglePageId } from './doc-proxy'
import {
  emitChangesApplied,
  onChangesApplied,
  type ChangesAppliedPagePayload,
} from '../../changes/change-emitter'
import { rendererSyncHandler, syncRendererAfterUpdate } from './renderer-sync'
import { selectionSyncHandler } from './selection-sync'
import { workerSyncHandler } from '../../worker/worker-sync'
import { historySyncHandler } from '../../history/history-sync'

// Subscriber registration — explicit, ordered, single source of truth.
// renderer-sync must run first so WASM has the new state before
// selection-sync queries it; selection-sync runs before worker / history
// for symmetry with overlay timing; worker is fire-and-forget so its order
// vs. history doesn't matter; history runs last. Centralizing here also
// insulates ordering from arbitrary import paths.
onChangesApplied(rendererSyncHandler)
onChangesApplied(selectionSyncHandler)
onChangesApplied(workerSyncHandler)
onChangesApplied(historySyncHandler)

function toPlainPage(page: IndexedPage): IndexedPage {
  try {
    return structuredClone(page)
  } catch {
    return JSON.parse(JSON.stringify(page)) as IndexedPage
  }
}

function changePageId(c: Change): string | undefined {
  return (c as { pageId?: string }).pageId
}

/** Group changes by `pageId`, using fallback when absent on a change. */
export function groupChangesByPageId(
  changes: Change[],
  fallbackPageId: string | null | undefined
): Map<string, Change[]> {
  const map = new Map<string, Change[]>()
  for (const c of changes) {
    const pid = changePageId(c) ?? fallbackPageId
    if (!pid) continue
    const list = map.get(pid) ?? []
    list.push(c)
    map.set(pid, list)
  }
  return map
}

export interface ApplyChangesLocallyParams {
  pageId: string
  redoChanges: Change[]
}

/**
 * Apply redo changes to docProxy for one page. Pure mutation — no renderer
 * sync, no worker sync, no history. Returns the resulting page (also written
 * into `docProxy.pageMap`) plus the snapshot of the page before the apply,
 * which the renderer subscriber needs for its diff.
 */
export interface ApplyChangesLocallyResult {
  oldPage: IndexedPage | undefined
  updatedPage: IndexedPage
}

export function applyChangesLocally(
  params: ApplyChangesLocallyParams,
): ApplyChangesLocallyResult | undefined {
  const { pageId, redoChanges } = params
  if (redoChanges.length === 0) return undefined

  const page = docProxy.pageMap.get(pageId)
  if (!page) return undefined

  const oldPage = toPlainPage(page)
  /** Clone so `processChanges` does not mutate live page shapes; renderer/worker diffs read by reference and JSON. */
  const updatedPage = processChanges(toPlainPage(page), redoChanges)
  docProxy.pageMap.set(pageId, updatedPage)
  return { oldPage, updatedPage }
}

/**
 * Apply Change[] to docProxy and dispatch a `changes-applied` event.
 * Subscribers handle renderer sync, worker indexes, and history.
 */
export async function commitChanges(params: CommitChangesParams): Promise<void> {
  const {
    redoChanges,
    undoChanges = [],
    pageId: explicitPageId,
    saveUndo,
    fromHistory,
    ignoreRendererSync,
  } = params

  if (redoChanges.length === 0) return

  for (const c of redoChanges) {
    if (c.type === 'add-obj') {
      assertValidAddObjChange(c)
    }
  }

  const fallbackPageId = explicitPageId ?? getActiveOrSinglePageId()
  const byPage = groupChangesByPageId(redoChanges, fallbackPageId)
  if (byPage.size === 0) return

  const pages: ChangesAppliedPagePayload[] = []
  for (const [pageId, pageChanges] of byPage) {
    const result = applyChangesLocally({ pageId, redoChanges: pageChanges })
    if (!result) continue
    pages.push({
      pageId,
      changes: pageChanges,
      oldPage: result.oldPage,
      updatedPage: result.updatedPage,
    })
  }

  if (pages.length === 0) return

  await emitChangesApplied({
    redoChanges,
    undoChanges,
    pages,
    fromHistory: fromHistory ?? false,
    saveUndo: saveUndo ?? undoChanges.length > 0,
    ignoreRendererSync: ignoreRendererSync ?? false,
  })
}

export interface PageCommitPayload {
  pageId: string
  updatedPage: IndexedPage
}

export interface PageCommitWithChangesPayload {
  pageId: string
  changes: Change[]
}

/**
 * Page-metadata path: replace a whole page (no Change[] involved).
 * Bypasses the change-emitter and updates renderer/worker directly.
 */
export async function commitPageUpdate(payload: PageCommitPayload): Promise<void> {
  const { pageId, updatedPage } = payload
  const state = useWorkspaceStore.getState()
  const { workerClient, renderer } = state
  const oldPage = docProxy.pageMap.get(pageId)
  const plainUpdatedPage = toPlainPage(updatedPage)
  docProxy.pageMap.set(pageId, plainUpdatedPage)
  if (workerClient) await workerClient.updatePage(pageId, plainUpdatedPage)
  if (renderer) await syncRendererAfterUpdate(renderer, oldPage ? toPlainPage(oldPage) : undefined, plainUpdatedPage)
}

export async function commitPageUpdateWithChanges(payload: PageCommitWithChangesPayload): Promise<void> {
  await commitChanges({
    redoChanges: payload.changes,
    undoChanges: [],
    pageId: payload.pageId,
    saveUndo: false,
  })
}
