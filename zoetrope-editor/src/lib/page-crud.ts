/**
 * CRUD operations for document and pages. Delegates to DocumentModel.
 */
import type { PenpotDocument, PenpotPage } from 'penpot-exporter/types'
import { documentModel } from './renderer/store/document-model'
import { commitChanges, type CommitParams } from './renderer/store/commit'
import { importPage, orderBetween, pagesInOrder, type LocalChange } from './doc'

export { undo, redo } from './doc'

export function createNewDocument(): PenpotDocument {
  const initialPage: PenpotPage = {
    id: crypto.randomUUID(),
    name: 'Page 1',
    children: [],
    background: '#FFFFFF',
  }
  return {
    name: 'Untitled',
    children: [initialPage],
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  }
}

export async function setDocument(document: PenpotDocument): Promise<void> {
  await documentModel.loadDocument(document)
}

export async function setActivePage(pageId: string): Promise<void> {
  await documentModel.setActivePage(pageId)
}

/** Add an exporter page after the last one. */
export async function addPage(page: PenpotPage): Promise<void> {
  const last = pagesInOrder().at(-1)
  const { page: record, nodes } = importPage(page, orderBetween(last?.order, undefined))
  await documentModel.addPage(record, nodes)
}

export async function deletePage(pageId: string): Promise<void> {
  await documentModel.deletePage(pageId)
}

export async function applyChanges(changes: readonly LocalChange[]): Promise<void> {
  await documentModel.applyChanges(changes)
}

/** Full commit: changes, doc-meta arm, history flags. */
export async function commitChangesPublic(params: CommitParams): Promise<void> {
  await commitChanges(params)
}
