/**
 * CRUD operations for document and pages.
 * Delegates to DocumentModel orchestration backed by Valtio document state.
 */

import { documentModel } from './renderer/store/document-model'
import { commitChanges } from './renderer/store/commit'
import { useHistoryStore } from './history/history-store'
import type { IndexedPage } from './worker/types'
import { flattenPageToIndexed } from './worker/types'
import type { PenpotDocument, PenpotNode, PenpotPage, Change } from 'penpot-exporter/types'
import type { CommitChangesParams } from './changes/commit-types'

export function createNewDocument(): PenpotDocument {
  const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
  const rootFrame: PenpotNode = {
    id: ROOT_UUID,
    name: 'Root',
    type: 'frame',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    parentId: undefined,
    selrect: { x: 0, y: 0, width: 800, height: 600, x1: 0, y1: 0, x2: 800, y2: 600 },
    points: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }],
  }
  const initialPage: PenpotPage = {
    id: crypto.randomUUID(),
    name: 'Page 1',
    children: [rootFrame],
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

export async function addPage(page: IndexedPage | PenpotPage): Promise<void> {
  const indexed: IndexedPage =
    'objects' in page && page.objects ? (page as IndexedPage) : flattenPageToIndexed(page as PenpotPage)
  await documentModel.addPage(indexed)
}

export async function deletePage(pageId: string): Promise<void> {
  await documentModel.deletePage(pageId)
}

export async function applyChanges(
  changes: Change[],
  options?: { pageId?: string; undoChanges?: Change[] }
): Promise<void> {
  await documentModel.applyChanges(changes, options)
}

/** Full commit with optional undo vector (Penpot-shaped pipeline + history). */
export async function commitChangesPublic(params: CommitChangesParams): Promise<void> {
  await commitChanges(params)
}

export async function undo(): Promise<void> {
  // While a focus stage's sub-history buffer is open the canvas reader is
  // disabled — Cmd+Z is handled by focusUndo (App.tsx routes it). Guard here too
  // so menu/toolbar/programmatic paths can't bypass the router.
  if (useHistoryStore.getState().focusBuffer) return
  // An in-flight gesture (open transaction) becomes the frame this undo pops.
  useHistoryStore.getState().flushTransactions()
  // One frame = one step: a focus session lands one folded frame, a transaction
  // one merged frame, an ordinary edit its own. `undoChanges` is already the
  // full newest-first inverse, so applying it reverts the frame's whole effect.
  const frame = useHistoryStore.getState().popUndoFrame()
  if (!frame) return
  await commitChanges({
    redoChanges: frame.undoChanges,
    docMetaRedoChanges: frame.docMetaUndoChanges,
    saveUndo: false,
    fromHistory: true,
  })
  useHistoryStore.getState().pushRedoFrame(frame)
}

export async function redo(): Promise<void> {
  if (useHistoryStore.getState().focusBuffer) return
  useHistoryStore.getState().flushTransactions()
  const frame = useHistoryStore.getState().popRedoFrame()
  if (!frame) return
  await commitChanges({
    redoChanges: frame.redoChanges,
    docMetaRedoChanges: frame.docMetaRedoChanges,
    saveUndo: false,
    fromHistory: true,
  })
  useHistoryStore.getState().pushUndoFrame(frame)
}
