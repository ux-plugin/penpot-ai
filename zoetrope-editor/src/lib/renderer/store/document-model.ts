/**
 * DocumentModel orchestrates document and page lifecycle: load, page switch,
 * add and delete pages, and the renderer / worker handoff for each.
 */
import type { PenpotDocument } from 'penpot-exporter/types'
import { applyAll } from '../../doc/apply'
import { rebuildDerived } from '../../doc/derived'
import {
  add,
  clearHistory,
  clearTables,
  count,
  currentPageId,
  del,
  exportDocument,
  get,
  getNode,
  ids,
  importDocument,
  meta,
  nodesOfPage,
  pageObjects,
  pagesInOrder,
  tables,
  type LocalChange,
  type Node,
  type Page,
  type PageId,
} from '../../doc'
import { useWorkspaceStore } from './workspace-store'
import { viewport } from '../signals/pointer'
import { commitChanges } from './commit'
import { positionDataChanges } from './enrich-position-data'
import { clearSelection } from './document-selection'
import { hydrateScene3dFromDocument } from '../three/scene3d-sync'

export class DocumentModel {
  getDocument(): PenpotDocument | null {
    return exportDocument()
  }

  getPage(id: string): Page | undefined {
    return get('page', id)
  }

  /** The page shown, or the only one. */
  getActiveOrSinglePageId(): PageId | null {
    const current = currentPageId.peek()
    if (current) return current
    if (count('page') === 1) return ids('page').next().value ?? null
    return null
  }

  getNode(id: string): Node | undefined {
    return getNode(id)
  }

  getSelectedNodes(selectedIds: Iterable<string>): Node[] {
    const out: Node[] = []
    for (const id of selectedIds) {
      const n = getNode(id)
      if (n) out.push(n)
    }
    return out
  }

  /** Push a page to the renderer and worker, then store its text layout. */
  private async showPage(pageId: PageId): Promise<void> {
    const state = useWorkspaceStore.getState()
    const page = get('page', pageId)
    if (!page || !state.renderer) return
    await state.renderer.initPage({ background: page.background, objects: pageObjects(pageId) })
    viewport.value = { panX: 0, panY: 0, zoom: 1 }
    if (state.wasmModule) {
      const changes = positionDataChanges(state.wasmModule, nodesOfPage(pageId))
      if (changes.length) await commitChanges({ changes, saveUndo: false, ignoreRendererSync: true })
    }
  }

  async loadDocument(doc: PenpotDocument): Promise<void> {
    clearHistory()
    const imported = importDocument(doc)
    clearTables()
    applyAll(tables, [...imported.pages.map((p) => add('page', p)), ...imported.nodes.map((n) => add('node', n))])
    rebuildDerived()
    meta.value = imported.meta
    const firstPageId = imported.pages[0]?.id ?? null
    currentPageId.value = firstPageId

    hydrateScene3dFromDocument()
    clearSelection()

    const state = useWorkspaceStore.getState()
    for (const page of imported.pages) {
      await state.workerClient?.initPage({ id: page.id, objects: pageObjects(page.id) })
    }
    if (firstPageId) await this.showPage(firstPageId)
  }

  async setActivePage(pageId: string): Promise<void> {
    if (!get('page', pageId)) return
    clearHistory()
    currentPageId.value = pageId
    clearSelection()
    await this.showPage(pageId)
  }

  async addPage(page: Page, nodes: readonly Node[] = []): Promise<void> {
    if (!meta.peek()) return
    const changes: LocalChange[] = [add('page', page), ...nodes.map((n) => add('node', n))]
    await commitChanges({ changes, saveUndo: false, ignoreRendererSync: true })
    await useWorkspaceStore.getState().workerClient?.initPage({ id: page.id, objects: pageObjects(page.id) })
    if (this.getActiveOrSinglePageId() == null && useWorkspaceStore.getState().renderer?.isInitialized()) {
      await this.setActivePage(page.id)
    }
  }

  async deletePage(pageId: string): Promise<void> {
    if (!get('page', pageId)) return
    clearHistory()
    const wasCurrent = currentPageId.peek() === pageId
    await commitChanges({ changes: [del('page', pageId)], saveUndo: false, ignoreRendererSync: true })
    if (!wasCurrent) return
    const next = pagesInOrder()[0]?.id ?? null
    currentPageId.value = next
    clearSelection()
    if (next) await this.showPage(next)
  }

  async applyChanges(changes: readonly LocalChange[]): Promise<void> {
    if (changes.length === 0) return
    await commitChanges({ changes })
  }
}

export const documentModel = new DocumentModel()
