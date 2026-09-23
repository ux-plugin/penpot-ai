/**
 * Subscriber that feeds the hit-index worker the node changes of a commit,
 * grouped by page. Fire-and-forget: the index may lag a frame.
 */
import type { ChangesAppliedEvent } from '../doc/commit'
import type { Change, Node } from '../doc'
import { useWorkspaceStore } from '../renderer/store/workspace-store'

export function workerSyncHandler(event: ChangesAppliedEvent): void {
  const { workerClient } = useWorkspaceStore.getState()
  if (!workerClient) return
  const byPage = new Map<string, Change[]>()
  for (const a of event.applied) {
    if (a.change.kind !== 'node') continue
    const pageId = ((a.after ?? a.before) as Node | undefined)?.page
    if (!pageId) continue
    let list = byPage.get(pageId)
    if (!list) byPage.set(pageId, (list = []))
    list.push(a.change)
  }
  for (const [pageId, changes] of byPage) {
    workerClient.applyChanges(pageId, changes).catch(console.error)
  }
}
