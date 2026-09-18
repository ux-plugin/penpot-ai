/**
 * Local overrides on a copy — inspecting them, and giving them back.
 *
 * Marking is not here: it happens automatically inside the commit pipeline
 * (`collectComponentEffects` in ./component-sync), because an override is
 * whatever the user did to a copy, through whichever editing path. This module
 * owns the deliberate acts: asking what has been overridden, and undoing that.
 *
 * Reset is surgical rather than wholesale. A node's `touched` groups say exactly
 * which attributes drifted, so only those are re-pulled from the main; a copy
 * that overrode a fill and nothing else keeps everything but its fill.
 */
import { snapshot } from 'valtio'
import { docProxy, getActiveOrSinglePageId } from '../store/doc-proxy'
import { commitChanges } from '../store/commit'
import { subtreeWithRoot } from '../../common/subtree'
import { isComponentCopyRoot } from '../../worker/geometry/shapes'
import { bulkAssignByValue } from '../../changes/bulk-changes'
import { appliedTokenProp, attrsInGroups, UNSYNCED_GROUPS } from './sync-attrs'
import type { IndexedShape } from '../../worker/types'
import type { PenpotNode } from 'penpot-exporter/types'

function readObjects(pageId: string): Record<string, IndexedShape> | undefined {
  return snapshot(docProxy).pageMap.get(pageId)?.objects as
    | Record<string, IndexedShape>
    | undefined
}

/** Find a main node by id across every page — a copy may live away from its main. */
function findMainNode(nodeId: string): PenpotNode | undefined {
  const pages = snapshot(docProxy).pageMap as unknown as Map<
    string,
    { objects: Record<string, IndexedShape> }
  >
  for (const page of pages.values()) {
    const found = page.objects[nodeId]
    if (found) return found as PenpotNode
  }
  return undefined
}

/** Nodes in this copy that carry local overrides, with the groups they froze. */
export function listOverrides(copyRootId: string): Array<{ id: string; groups: string[] }> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return []
  const objects = readObjects(pageId)
  if (!objects) return []
  if (!isComponentCopyRoot(objects[copyRootId] as PenpotNode | undefined)) return []

  const out: Array<{ id: string; groups: string[] }> = []
  for (const id of subtreeWithRoot(objects, copyRootId)) {
    const touched = (objects[id] as { touched?: string[] } | undefined)?.touched
    if (touched && touched.length > 0) out.push({ id, groups: [...touched] })
  }
  return out
}

export function hasOverrides(copyRootId: string): boolean {
  return listOverrides(copyRootId).length > 0
}

/**
 * Drop every local override on a copy and take the main's values back.
 *
 * One history frame, so a single undo restores the overrides the user had. The
 * writes are flagged `ignoreTouched`, which is what stops the commit pipeline
 * from reading this as a fresh round of user edits and immediately re-marking
 * everything it just cleared.
 *
 * Geometry is excluded for the same reason it is not synced yet: a copy's box is
 * its own until rebasing lands (see UNSYNCED_GROUPS in ./sync-attrs).
 */
export async function resetOverrides(copyRootId: string): Promise<boolean> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return false
  const objects = readObjects(pageId)
  if (!objects) return false
  if (!isComponentCopyRoot(objects[copyRootId] as PenpotNode | undefined)) return false

  const redoEntries: Array<{ id: string; assign: Record<string, unknown> }> = []
  const undoEntries: Array<{ id: string; assign: Record<string, unknown> }> = []

  for (const id of subtreeWithRoot(objects, copyRootId)) {
    const node = objects[id] as PenpotNode | undefined
    const touched = (node as { touched?: string[] } | undefined)?.touched
    if (!node || !touched || touched.length === 0) continue

    const groups = new Set(touched.filter((g) => !UNSYNCED_GROUPS.has(g as never)))
    const main = node.shapeRef != null ? findMainNode(node.shapeRef) : undefined

    const restore: Record<string, unknown> = { touched: undefined }
    const previous: Record<string, unknown> = { touched: [...touched] }
    if (main) {
      for (const attr of attrsInGroups(node.type, groups)) {
        restore[attr] = (main as unknown as Record<string, unknown>)[attr]
        previous[attr] = (node as unknown as Record<string, unknown>)[attr]
      }

      // Token bindings are held one group per key, so restore them key by key.
      // Only the overridden keys come back from the main; bindings the copy never
      // touched are already tracking it and must not be disturbed.
      const tokenProps = touched
        .map(appliedTokenProp)
        .filter((prop): prop is string => prop != null)
      if (tokenProps.length > 0) {
        const current = (node.appliedTokens ?? {}) as Record<string, string>
        const mainTokens = (main.appliedTokens ?? {}) as Record<string, string>
        const merged: Record<string, string> = { ...current }
        for (const prop of tokenProps) {
          if (mainTokens[prop] == null) delete merged[prop]
          else merged[prop] = mainTokens[prop]
        }
        restore.appliedTokens = merged
        previous.appliedTokens = { ...current }
      }
    }
    redoEntries.push({ id, assign: restore })
    undoEntries.push({ id, assign: previous })
  }

  // Declared prop values are the other half of "this instance differs from its
  // component", so resetting clears them too. The attributes they drove are
  // already covered above: setting a prop marks the target's group as touched,
  // exactly like a freeform edit.
  const rootNode = objects[copyRootId] as { propValues?: Record<string, unknown> } | undefined
  const propValues = rootNode?.propValues
  if (propValues != null && Object.keys(propValues).length > 0) {
    const existing = redoEntries.find((entry) => entry.id === copyRootId)
    if (existing) {
      existing.assign.propValues = {}
      undoEntries.find((entry) => entry.id === copyRootId)!.assign.propValues = { ...propValues }
    } else {
      redoEntries.push({ id: copyRootId, assign: { propValues: {} } })
      undoEntries.push({ id: copyRootId, assign: { propValues: { ...propValues } } })
    }
  }

  if (redoEntries.length === 0) return false

  await commitChanges({
    pageId,
    redoChanges: bulkAssignByValue(pageId, redoEntries, { ignoreTouched: true }),
    undoChanges: bulkAssignByValue(pageId, undoEntries, { ignoreTouched: true }),
  })
  return true
}
