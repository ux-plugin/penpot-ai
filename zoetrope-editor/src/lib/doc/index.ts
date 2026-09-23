export { ROOT } from './ids'
export type { NodeId, PageId, ParentKey } from './ids'
export type { Kind, Node, Page, RecordOf, AnyRecord, Cell, Binding, Rule, ShapeMotion, Store } from './schema'
export { KINDS } from './schema'
export { tables, currentPageId, get, sig, has, ids, count, records, field, clearTables } from './store'
export { meta } from './meta'
export type { DocumentMeta } from './meta'
export { add, del, mod, mods, modsByValue, expand, idOf } from './changes'
export type { Change, LocalChange, AddChange, DelChange, ModChange, ModsChange } from './changes'
export { commitChanges, onChangesApplied, registerEffect } from './commit'
export type { CommitParams, ChangesAppliedEvent, Effect } from './commit'
export type { Applied } from './apply'
export { childrenOf, children, descendants, readersOf, ownedBy, dangling, ofType, rowsOf, countUnder, derived } from './derived'
export type { Row, Owned, Dangling, Derived } from './derived'
export { refFields, refsOf, remap, idsIn } from './registry'
export {
  addNode,
  addSubtree,
  deleteNodes,
  moveNodes,
  reorderChildren,
  placeNode,
  frameFor,
  isFrame,
  siblingIndex,
  ancestors,
  parentKey,
} from './tree'
export type { Placement } from './tree'
export { orderBetween, orderAt, initialOrders } from './order'
export { pageObjects, nodesOfPage, treeOf, exportDocument, exportPage, exportRecords, rootFrame, toWasmNode, pagesInOrder } from './export'
export type { PageObjects, TreeNode, DepthNode } from './export'
export { importDocument, importPage, loadImported, addsOf, BEHAVIOUR_KINDS } from './import'
export type { Imported, DocumentRecords, BehaviourKind } from './import'
export {
  undo,
  redo,
  canUndo,
  canRedo,
  beginGroup,
  endGroup,
  markInteraction,
  fork,
  merge,
  discard,
  inScratch,
  clearHistory,
  onBeforeUndo,
} from './undo'
export { useSignal, useRecord, useNode, useField, useChildren, useCurrentPageId, useMeta, useMembership } from './react'

import { get, currentPageId, count, ids } from './store'
import type { Node, Page } from './schema'
import type { NodeId, PageId } from './ids'

export function getNode(id: NodeId | null | undefined): Node | undefined {
  return id ? get('node', id) : undefined
}

export function getPage(id: PageId | null | undefined): Page | undefined {
  return id ? get('page', id) : undefined
}

export function getCurrentPage(): Page | undefined {
  return getPage(currentPageId.peek())
}

/** The page the editor shows, or the only one. */
export function getActiveOrSinglePageId(): PageId | null {
  const current = currentPageId.peek()
  if (current) return current
  if (count('page') === 1) return ids('page').next().value ?? null
  return null
}
