/** Page name / background edits, plus the WASM canvas background. */
import { mod, type Page } from '../../doc'
import { commitChanges } from '../store/commit'
import { useWorkspaceStore } from '../store/workspace-store'

export async function commitPageMetadataUpdate(
  pageId: string,
  partial: Partial<Pick<Page, 'name' | 'background'>>,
): Promise<void> {
  await commitChanges({ changes: [mod('page', pageId, partial)] })
  if ('background' in partial) {
    useWorkspaceStore.getState().renderer?.setBackground(partial.background ?? '#FFFFFF')
  }
}
