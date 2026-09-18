/**
 * Penpot-shaped commit pipeline: apply Change[] to docProxy, record the undo
 * frame synchronously, then emit a `changes-applied` event whose subscribers
 * (renderer-sync, selection-sync, worker-sync) consume it independently — see
 * `change-emitter.ts`.
 *
 * History is recorded synchronously here (not as a subscriber) so the undo frame
 * exists before `commitChanges` yields at its first await — interaction code can
 * then group edits with plain begin/commit boundaries without racing the async
 * render. The renderer/worker side-effects stay async.
 */

import type { IndexedPage } from '../../worker/types'
import type { Change } from 'penpot-exporter/types'
import { processChanges } from '../../worker/process-changes'
import { useWorkspaceStore } from './workspace-store'
import type { CommitChangesParams } from '../../changes/commit-types'
import { expandBulkChanges } from '../../changes/bulk-changes'
import { collectComponentEffects } from '../component/component-sync'
import { assertValidAddObjChange } from '../../common/shape-id'
import { docProxy, getActiveOrSinglePageId } from './doc-proxy'
import {
  emitChangesApplied,
  onChangesApplied,
  type ChangesAppliedPagePayload,
} from '../../changes/change-emitter'
import {
  type DocMetaChange,
  processDocMetaChanges,
} from '../../changes/doc-meta-change'
import { rendererSyncHandler, syncRendererAfterUpdate } from './renderer-sync'
import { selectionSyncHandler } from './selection-sync'
import { workerSyncHandler } from '../../worker/worker-sync'
import { scene3dSyncHandler } from '../three/scene3d-sync'
import { augmentCropResizeChanges } from '../three/scene3d-crop-resize'
import { recordHistoryFrame } from '../../history/history-sync'

// Subscriber registration — explicit, ordered, single source of truth.
// renderer-sync must run first so WASM has the new state before selection-sync
// queries it; selection-sync runs before worker for symmetry with overlay
// timing; worker is fire-and-forget. History is NOT a subscriber — it's recorded
// synchronously in `commitChanges` (see below). Centralizing here also insulates
// ordering from arbitrary import paths.
onChangesApplied(rendererSyncHandler)
onChangesApplied(selectionSyncHandler)
onChangesApplied(workerSyncHandler)
// scene3d-sync reconciles the in-memory 3D read-cache (scene3dProxy) from
// `node.scene3d` after every commit, incl. undo/redo. It only reads the already
// updated page + mutates the proxy (no new changes), so order vs the others is
// immaterial; placed last among the document subscribers.
onChangesApplied(scene3dSyncHandler)

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
 * Apply doc-meta changes synchronously to `docProxy.meta`. No subscribers run
 * here — the library panels read `docProxy.meta` reactively via Valtio and
 * re-render on the assignment below.
 */
function applyDocMetaChangesLocally(changes: readonly DocMetaChange[]): void {
  if (changes.length === 0) return
  if (!docProxy.meta) return
  docProxy.meta = processDocMetaChanges(docProxy.meta, changes)
}

/**
 * Apply Change[] to docProxy and dispatch a `changes-applied` event.
 * Subscribers handle renderer sync, worker indexes, and history.
 *
 * Commits may carry doc-meta changes alongside page changes (e.g. a library
 * sync edits a paint style AND rewrites the cached color on every referencing
 * fill). Doc-meta is applied first, synchronously, against `docProxy.meta`;
 * page changes follow on the existing per-page path; one frame is recorded.
 */
export async function commitChanges(params: CommitChangesParams): Promise<void> {
  const {
    redoChanges: inputRedoChanges,
    undoChanges: inputUndoChanges = [],
    docMetaRedoChanges = [],
    docMetaUndoChanges = [],
    pageId: explicitPageId,
    saveUndo,
    fromHistory,
    ignoreRendererSync,
    groupId,
  } = params

  // A crop-mode 3D scene pins its view frame while its box resizes, so the frame write
  // rides along in THIS change set — same commit, same undo frame as the geometry. Undo
  // and redo already carry it in their recorded frames, so they must not be augmented
  // again. Returns null (and costs a scan) unless such a scene was actually resized.
  const augmented = fromHistory
    ? null
    : augmentCropResizeChanges(inputRedoChanges, inputUndoChanges)
  const redoChanges = augmented?.redoChanges ?? inputRedoChanges
  const undoChanges = augmented?.undoChanges ?? inputUndoChanges

  const hasPageChanges = redoChanges.length > 0
  const hasDocMetaChanges = docMetaRedoChanges.length > 0
  if (!hasPageChanges && !hasDocMetaChanges) return

  // Component sync: if this commit edits a main instance, its copies follow in
  // the SAME frame, so one undo reverts both. Skipped on undo/redo replay —
  // those frames already carry the copy updates recorded here. Reads the
  // document as it still stands, before anything below applies. Returns empty
  // immediately for a document with no components, which is the common case.
  const componentSync = fromHistory
    ? { redoChanges: [], undoChanges: [] }
    : collectComponentEffects(
        expandBulkChanges(redoChanges),
        explicitPageId ?? getActiveOrSinglePageId(),
      )
  const framedRedo =
    componentSync.redoChanges.length > 0
      ? [...redoChanges, ...componentSync.redoChanges]
      : redoChanges
  // Mirrors redo backwards: the copies revert, then the main edit does.
  const framedUndo =
    componentSync.undoChanges.length > 0
      ? [...componentSync.undoChanges, ...undoChanges]
      : undoChanges

  // Bulk changes are a history-frame representation only: expand them here so
  // the reducer, the renderer sync, the worker and every other subscriber keep
  // seeing plain per-shape changes, while the frame recorded below keeps the
  // compact form. See changes/bulk-changes.ts.
  const applyRedo = expandBulkChanges(framedRedo)
  const applyUndo = expandBulkChanges(framedUndo)

  for (const c of applyRedo) {
    if (c.type === 'add-obj') {
      assertValidAddObjChange(c)
    }
  }

  // Doc-meta first so subscribers and post-commit reads observe the new
  // library state in sync with any cascading page rewrites in the same frame.
  applyDocMetaChangesLocally(docMetaRedoChanges)

  const pages: ChangesAppliedPagePayload[] = []
  if (hasPageChanges) {
    const fallbackPageId = explicitPageId ?? getActiveOrSinglePageId()
    const byPage = groupChangesByPageId(applyRedo, fallbackPageId)
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
    // No page actually got changes (e.g. all changes had unknown pageIds and
    // no fallback): still proceed if doc-meta has work; otherwise abort.
    if (pages.length === 0 && !hasDocMetaChanges) return
  }

  const resolvedFromHistory = fromHistory ?? false
  const resolvedSaveUndo =
    saveUndo ?? (framedUndo.length > 0 || docMetaUndoChanges.length > 0)

  // Record the undo frame SYNCHRONOUSLY, before the async dispatch — so it
  // exists the instant docProxy is mutated and `commitChanges` yields.
  recordHistoryFrame({
    redoChanges: framedRedo,
    undoChanges: framedUndo,
    docMetaRedoChanges,
    docMetaUndoChanges,
    fromHistory: resolvedFromHistory,
    saveUndo: resolvedSaveUndo,
    groupId,
  })

  await emitChangesApplied({
    redoChanges: applyRedo,
    undoChanges: applyUndo,
    docMetaRedoChanges,
    docMetaUndoChanges,
    pages,
    fromHistory: resolvedFromHistory,
    saveUndo: resolvedSaveUndo,
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
