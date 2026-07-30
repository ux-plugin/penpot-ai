/**
 * CRUD operations for document and pages.
 * Delegates to DocumentModel orchestration backed by Valtio document state.
 */

import { documentModel } from './renderer/store/document-model'
import { commitChanges } from './renderer/store/commit'
import { LOCAL_ACTOR, useJournalStore, type Txn } from './history/journal/journal-store'
import {
  canvasLens,
  collapseRedoLens,
  localCtx,
  pickRedo,
  pickUndo,
  scopeLens,
  type HistoryLens,
} from './history/journal/lens'
import { rebase, resolve } from './history/journal/rebase'
import { invertAll } from './history/journal/op'
import { toChanges } from './history/journal/codec'
import { activeScope } from './history/journal/scope'
import { flushFocusPending } from './history/focus-pending'
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

/**
 * The lens both entry points read through — Cmd+Z and the toolbar alike.
 *
 * Deliberately derived from the open scope rather than passed in. If Cmd+Z
 * routed to the focus lens while the toolbar stayed on the canvas lens, a
 * toolbar click during a focus session would canvas-undo a transaction the
 * user's own focus edits are built on top of — the destructive create-undo
 * case, reachable with a single actor. One resolver, one answer.
 */
function currentLens(): HistoryLens {
  const tag = activeScope()
  return tag === undefined ? canvasLens : scopeLens(tag)
}

/**
 * Revert `target` by committing its rebased inverse forward as an ordinary
 * transaction carrying an `undoes` back-pointer. Shared by undo and redo — they
 * differ only in which query found the target, which is the point of the model.
 */
async function revert(target: Txn, lens: HistoryLens): Promise<void> {
  const gap = useJournalStore.getState().since(target.seq)
  const { ops } = resolve(rebase(invertAll(target.ops), gap), lens.conflict, LOCAL_ACTOR)

  if (ops.length > 0) {
    const { changes, docMetaChanges } = toChanges(ops)
    await commitChanges({
      redoChanges: changes,
      docMetaRedoChanges: docMetaChanges,
      saveUndo: false,
      fromHistory: true,
    })
  }
  // Recorded even when nothing applied — the entry is what marks the target
  // reverted, and without it the next undo would pick the same target forever.
  useJournalStore.getState().append({ ops, undoes: target.seq, scope: target.scope })
}

export async function undo(): Promise<void> {
  // A focus stage's live draft is not in the log until it flushes, so a Cmd+Z
  // moments after typing must commit it first or it would be skipped over.
  await flushFocusPending()
  // An in-flight gesture becomes the transaction this undo targets.
  useJournalStore.getState().flush()

  const lens = currentLens()
  const target = pickUndo(useJournalStore.getState().txns, lens, localCtx())
  if (!target) return
  await revert(target, lens)
}

export async function redo(): Promise<void> {
  await flushFocusPending()
  useJournalStore.getState().flush()

  const lens = currentLens()
  const txns = useJournalStore.getState().txns
  const ctx = localCtx()
  // Redo is undo at the opposite chain parity: reverting the undo re-applies
  // what it took away. There is no redo stack to pop.
  let target = pickRedo(txns, lens, ctx)

  // Redo — and ONLY redo — reaches outside the scope when it has nothing of its
  // own. Exiting a session, undoing it from the canvas, then stepping back in
  // leaves the entry to redo canvas-scoped and therefore invisible from inside,
  // so the press would otherwise do nothing at all.
  //
  // The reach is deliberately one entry wide: the undo of THIS session's own
  // collapse, never the canvas at large. Falling back to `canvasLens` let a redo
  // pressed inside a shader stage restore an unrelated shape's rename.
  //
  // Undo does not reach out at all: reverting canvas work from inside a session
  // is a surprise, whereas restoring what you just undid is not.
  const tag = activeScope()
  if (!target && tag !== undefined) target = pickRedo(txns, collapseRedoLens(tag, txns), ctx)

  if (!target) return
  await revert(target, lens)
}
