/**
 * Component sync — an edit to a main instance fanning out into its copies.
 *
 * Pure and read-only: this never commits. It inspects the page changes a commit
 * is *about* to apply, works out which copies must follow, and returns the extra
 * redo/undo vectors. `commitChanges` folds them into the same history frame as
 * the edit that triggered them, so one Cmd+Z reverts the main edit and every
 * copy it updated — the arrangement token propagation already uses
 * (tokens/propagation.ts, folded by tokens/crud.ts).
 *
 * Upstream Penpot instead watches the commit stream and fires a *follow-up*
 * event per affected component (`watch-component-changes` in
 * frontend/src/app/main/data/workspace/libraries.cljs). Folding into the
 * triggering frame is the deliberate difference: it keeps undo atomic without a
 * second pass over the document.
 *
 * The fan-out is emitted as bulk changes (see changes/bulk-changes.ts). Every
 * copy of a given node receives an identical assign, so N copies cost one change
 * rather than N — the compression matters because the history frame is what the
 * session retains.
 *
 * Out of scope here, by phase: geometry (see UNSYNCED_GROUPS in ./sync-attrs),
 * structure (children added, removed or reordered — P6), and nested copies
 * inside a main.
 */
import { snapshot } from 'valtio'
import { docProxy } from '../store/doc-proxy'
import { bulkAssignByValue, type LocalChange } from '../../changes/bulk-changes'
import {
  APPLIED_TOKENS_ATTR,
  appliedTokenGroup,
  changedTokenProps,
  resolveSyncGroup,
  UNSYNCED_GROUPS,
} from './sync-attrs'
import type { IndexedShape } from '../../worker/types'
import type { Change, PenpotNode } from 'penpot-exporter/types'

export interface ComponentSyncResult {
  redoChanges: LocalChange[]
  undoChanges: LocalChange[]
}

const EMPTY: ComponentSyncResult = { redoChanges: [], undoChanges: [] }

/** Attribute writes a change carries for one shape, flattened from its operations. */
type AttrWrites = Record<string, unknown>

interface ShapeWrites {
  pageId: string
  /** Everything written, whatever the source — drives the fan-out into copies. */
  attrs: AttrWrites
  /**
   * Only what the *user* wrote: operations flagged `ignoreTouched` are excluded.
   * Drives override marking, so that resetting an override (which re-pulls the
   * main's values onto the copy) doesn't immediately re-mark it as overridden.
   */
  userAttrs: AttrWrites
}

/** Collect `id -> { attr: value }` from the assign/set operations in `changes`. */
function collectWrites(
  changes: readonly Change[],
  fallbackPageId: string | null | undefined,
): Map<string, ShapeWrites> {
  const out = new Map<string, ShapeWrites>()
  for (const change of changes) {
    if (change.type !== 'mod-obj') continue
    const pageId = change.pageId ?? fallbackPageId
    if (!pageId) continue
    const entry = out.get(change.id) ?? { pageId, attrs: {}, userAttrs: {} }
    for (const op of change.operations ?? []) {
      const system = (op as { ignoreTouched?: boolean }).ignoreTouched === true
      if (op.type === 'assign') {
        const value = (op as { value?: AttrWrites }).value ?? {}
        Object.assign(entry.attrs, value)
        if (!system) Object.assign(entry.userAttrs, value)
      } else if (op.type === 'set') {
        const setOp = op as { attr?: string; val?: unknown }
        if (setOp.attr != null) {
          entry.attrs[setOp.attr] = setOp.val
          if (!system) entry.userAttrs[setOp.attr] = setOp.val
        }
      }
      // set-touched / set-remote-synced are bookkeeping, never synced onward.
    }
    if (Object.keys(entry.attrs).length > 0) out.set(change.id, entry)
  }
  return out
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge a main's token-binding change into one copy, key by key.
 *
 * Only the keys that actually changed on the main are carried over, and any key
 * the copy has overridden is left alone. A key the main dropped is dropped from
 * the copy too — the map is replaced wholesale by the assign, so omitting the key
 * is how deletion is expressed.
 *
 * Returns null when the copy ends up with what it already had.
 */
function mergeAppliedTokens(
  mainBefore: Record<string, string> | undefined,
  mainAfter: Record<string, string> | undefined,
  copy: PenpotNode,
  touched: ReadonlySet<string>,
): { next: Record<string, string>; previous: Record<string, string> } | null {
  const changed = changedTokenProps(mainBefore, mainAfter)
  if (changed.length === 0) return null

  const current = (copy.appliedTokens ?? {}) as Record<string, string>
  const merged: Record<string, string> = { ...current }
  const after = mainAfter ?? {}
  for (const prop of changed) {
    if (touched.has(appliedTokenGroup(prop))) continue
    if (after[prop] == null) delete merged[prop]
    else merged[prop] = after[prop]
  }
  if (jsonEqual(merged, current)) return null
  return { next: merged, previous: { ...current } }
}

/**
 * Override marking: a user edit to a node inside a copy freezes that
 * attribute's whole group on that node, so later main edits leave it alone.
 *
 * Two things are deliberately not marked. A write that changes nothing marks
 * nothing — re-applying the value a shape already has is not an override. And
 * geometry on a copy *root* is never an override, because every copy sits at its
 * own position by construction; without that carve-out, moving a copy once would
 * freeze its geometry against the main forever.
 */
function collectOverrideMarks(
  writes: Map<string, ShapeWrites>,
  pages: Map<string, { objects: Record<string, IndexedShape> }>,
): { redo: Map<string, Array<{ id: string; assign: AttrWrites }>>; undo: Map<string, Array<{ id: string; assign: AttrWrites }>> } {
  const redo = new Map<string, Array<{ id: string; assign: AttrWrites }>>()
  const undo = new Map<string, Array<{ id: string; assign: AttrWrites }>>()

  for (const [id, { pageId, userAttrs }] of writes) {
    if (Object.keys(userAttrs).length === 0) continue
    const node = pages.get(pageId)?.objects[id] as PenpotNode | undefined
    if (!node || node.shapeRef == null) continue

    const existing = new Set<string>((node.touched as string[] | undefined) ?? [])
    const next = new Set(existing)
    const isCopyRoot = node.componentRoot === true
    for (const [attr, value] of Object.entries(userAttrs)) {
      if (attr === APPLIED_TOKENS_ATTR) {
        // One group per rebound key, so overriding a copy's fill token doesn't
        // freeze its stroke token as well.
        for (const prop of changedTokenProps(
          node.appliedTokens,
          value as Record<string, string> | undefined,
        )) {
          next.add(appliedTokenGroup(prop))
        }
        continue
      }
      const group = resolveSyncGroup(node.type, attr)
      if (group == null) continue
      if (group === 'geometry-group' && isCopyRoot) continue
      if (jsonEqual((node as unknown as Record<string, unknown>)[attr], value)) continue
      next.add(group)
    }
    if (next.size === existing.size) continue

    const redoList = redo.get(pageId) ?? []
    redoList.push({ id, assign: { touched: [...next].sort() } })
    redo.set(pageId, redoList)
    const undoList = undo.get(pageId) ?? []
    undoList.push({
      id,
      assign: { touched: existing.size > 0 ? [...existing].sort() : undefined },
    })
    undo.set(pageId, undoList)
  }
  return { redo, undo }
}

/**
 * Walk up from `nodeId` to decide whether it lives inside a main instance.
 *
 * Returns the main's root id, or null. A copy root encountered on the way up
 * ends the search: a copy nested inside a main is its own thing, and syncing
 * through it is P6's problem, not this pass's.
 */
function enclosingMainRoot(
  objects: Record<string, IndexedShape>,
  nodeId: string,
): string | null {
  let current = objects[nodeId] as PenpotNode | undefined
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.mainInstance === true && current.componentId != null) return current.id
    if (current.componentRoot === true && current.mainInstance !== true) return null
    const parentId: string | undefined = current.parentId
    current = parentId ? (objects[parentId] as PenpotNode | undefined) : undefined
  }
  return null
}

/** Every copied node in the document, indexed by the main node it mirrors. */
function indexCopiesByRef(
  pages: Map<string, { objects: Record<string, IndexedShape> }>,
): Map<string, Array<{ pageId: string; node: PenpotNode }>> {
  const index = new Map<string, Array<{ pageId: string; node: PenpotNode }>>()
  for (const [pageId, page] of pages) {
    for (const node of Object.values(page.objects)) {
      const shape = node as PenpotNode
      const ref = shape.shapeRef
      if (ref == null) continue
      const list = index.get(ref)
      if (list) list.push({ pageId, node: shape })
      else index.set(ref, [{ pageId, node: shape }])
    }
  }
  return index
}

/**
 * Work out everything a commit implies for components: main edits fanning into
 * copies, and user edits to copies marking overrides.
 *
 * Both are folded into the triggering commit, so a single undo reverts the edit
 * along with the copies it moved and the override flags it set.
 *
 * `changes` must be the *expanded* page changes about to be applied, read before
 * they land — the previous values that make up the undo vector are taken from the
 * document as it still stands.
 */
export function collectComponentEffects(
  changes: readonly Change[],
  fallbackPageId: string | null | undefined,
): ComponentSyncResult {
  // Cheap gate first: a document with no components can never need this, which
  // is every document until the user makes one. Reads the live proxy rather than
  // a snapshot precisely so the common case costs nothing.
  const components = docProxy.meta?.components
  if (components == null || Object.keys(components).length === 0) return EMPTY

  const writes = collectWrites(changes, fallbackPageId)
  if (writes.size === 0) return EMPTY

  // Snapshot once: the values below end up inside history frames, and a valtio
  // proxy there would both leak reactivity and break the structuredClone the undo
  // vector performs.
  const snap = snapshot(docProxy)
  const pages = snap.pageMap as unknown as Map<string, { objects: Record<string, IndexedShape> }>

  // A user edit landing inside a copy freezes that group there. Independent of
  // the fan-out below: a commit can do one, the other, or neither.
  const marks = collectOverrideMarks(writes, pages)

  // Which of the written nodes are inside a main? Usually none.
  const mainNodes: Array<{ id: string; attrs: AttrWrites; pageId: string }> = []
  for (const [id, { pageId, attrs }] of writes) {
    const objects = pages.get(pageId)?.objects
    if (!objects) continue
    if (enclosingMainRoot(objects, id) == null) continue
    mainNodes.push({ id, attrs, pageId })
  }
  if (mainNodes.length === 0) return buildResult(new Map(), new Map(), marks)

  const copiesByRef = indexCopiesByRef(pages)

  // Grouped per page, because changes are applied per page.
  const redoByPage = new Map<string, Array<{ id: string; assign: AttrWrites }>>()
  const undoByPage = new Map<string, Array<{ id: string; assign: AttrWrites }>>()

  for (const main of mainNodes) {
    const targets = copiesByRef.get(main.id)
    if (!targets) continue
    const mainBefore = pages.get(main.pageId)?.objects[main.id] as PenpotNode | undefined
    for (const { pageId, node } of targets) {
      const touched = new Set<string>((node.touched as string[] | undefined) ?? [])
      const next: AttrWrites = {}
      const previous: AttrWrites = {}
      for (const [attr, value] of Object.entries(main.attrs)) {
        if (attr === APPLIED_TOKENS_ATTR) {
          // Token bindings merge key by key, so a copy that overrode one binding
          // keeps tracking the main on all the others.
          const merged = mergeAppliedTokens(
            mainBefore?.appliedTokens,
            value as Record<string, string> | undefined,
            node,
            touched,
          )
          if (merged) {
            next[attr] = merged.next
            previous[attr] = merged.previous
          }
          continue
        }
        const group = resolveSyncGroup(node.type, attr)
        // Not a synced attribute, not synced yet, or the user has overridden this
        // group on this node — in all three cases the copy keeps what it has.
        if (group == null || UNSYNCED_GROUPS.has(group) || touched.has(group)) continue
        next[attr] = value
        previous[attr] = (node as unknown as Record<string, unknown>)[attr]
      }
      if (Object.keys(next).length === 0) continue
      const redo = redoByPage.get(pageId) ?? []
      redo.push({ id: node.id, assign: next })
      redoByPage.set(pageId, redo)
      const undo = undoByPage.get(pageId) ?? []
      undo.push({ id: node.id, assign: previous })
      undoByPage.set(pageId, undo)
    }
  }

  return buildResult(redoByPage, undoByPage, marks)
}

/**
 * Assemble the final vectors. Every generated write is flagged `ignoreTouched`:
 * these are the system's edits, and a copy updated by sync has not been
 * overridden by the user.
 */
function buildResult(
  syncRedo: Map<string, Array<{ id: string; assign: AttrWrites }>>,
  syncUndo: Map<string, Array<{ id: string; assign: AttrWrites }>>,
  marks: ReturnType<typeof collectOverrideMarks>,
): ComponentSyncResult {
  const redoChanges: LocalChange[] = []
  const undoChanges: LocalChange[] = []
  const system = { ignoreTouched: true }

  for (const [pageId, entries] of syncRedo) {
    redoChanges.push(...bulkAssignByValue(pageId, entries, system))
  }
  for (const [pageId, entries] of marks.redo) {
    redoChanges.push(...bulkAssignByValue(pageId, entries, system))
  }
  for (const [pageId, entries] of syncUndo) {
    undoChanges.push(...bulkAssignByValue(pageId, entries, system))
  }
  for (const [pageId, entries] of marks.undo) {
    undoChanges.push(...bulkAssignByValue(pageId, entries, system))
  }
  if (redoChanges.length === 0) return EMPTY
  return { redoChanges, undoChanges }
}
