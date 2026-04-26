/**
 * Subscriber that updates the worker spatial index after changes commit.
 *
 * Receives a `ChangesAppliedEvent` and feeds the worker per-page. Was inlined
 * inside `commitChanges` as a `for` loop over `byPage`; relocated here so the
 * commit step doesn't own worker concerns.
 *
 * The worker call is fire-and-forget at the page level (the spatial index is
 * only needed for hit-testing and can lag a frame behind), but the outer
 * subscriber still resolves so the change-emitter's sequential dispatch
 * doesn't return until each page has been queued.
 */

import type { Change } from 'penpot-exporter/types'
import type { ChangesAppliedEvent } from '../changes/change-emitter'
import { useWorkspaceStore } from '../renderer/store/workspace-store'
import type { IndexedPage, WorkerClient } from './types'

/** Public helper kept for callers that need to push a page-level update directly. */
export async function updateWorkerIndexes(
  workerClient: WorkerClient | null,
  pageId: string,
  changes: Change[],
  updatedPage: IndexedPage,
): Promise<void> {
  if (!workerClient) return
  if (changes.length > 0) {
    await workerClient.updatePageWithChanges(pageId, changes)
  } else {
    await workerClient.updatePage(pageId, updatedPage)
  }
}

export function workerSyncHandler(event: ChangesAppliedEvent): void {
  const { workerClient } = useWorkspaceStore.getState()
  if (!workerClient) return
  // Fire each page update in the background — don't block the commit transaction.
  // cleanModifiers() runs as soon as commitChanges returns; the spatial index
  // is only needed for hit-testing and can catch up a frame later.
  for (const page of event.pages) {
    updateWorkerIndexes(workerClient, page.pageId, page.changes, page.updatedPage).catch(
      console.error,
    )
  }
}
