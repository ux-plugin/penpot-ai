/**
 * Local overrides on a copy — inspecting them, and giving them back.
 *
 * Marking is not here: it happens automatically inside the commit pipeline
 * (`componentSyncEffect` in ./component-sync), because an override is whatever
 * the user did to a copy, through whichever editing path. This module owns the
 * deliberate acts: asking what has been overridden, and undoing that.
 *
 * Reset is surgical rather than wholesale. A node's `touched` groups say exactly
 * which attributes drifted, so only those are re-pulled from the main; a copy
 * that overrode a fill and nothing else keeps everything but its fill.
 */
import { commitChanges } from '../store/commit'
import { descendants, getNode, modsByValue, type Node } from '../../doc'
import { isComponentCopyRoot } from '../../worker/geometry/shapes'
import { appliedTokenProp, attrsInGroups, UNSYNCED_GROUPS } from './sync-attrs'

/** Nodes in this copy that carry local overrides, with the groups they froze. */
export function listOverrides(copyRootId: string): Array<{ id: string; groups: string[] }> {
  if (!isComponentCopyRoot(getNode(copyRootId))) return []

  const out: Array<{ id: string; groups: string[] }> = []
  for (const id of [copyRootId, ...descendants(copyRootId)]) {
    const touched = getNode(id)?.touched as string[] | undefined
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
 * writes are `system`, which is what stops the commit pipeline from reading
 * this as a fresh round of user edits and immediately re-marking everything it
 * just cleared.
 *
 * Geometry is excluded for the same reason it is not synced yet: a copy's box is
 * its own until rebasing lands (see UNSYNCED_GROUPS in ./sync-attrs).
 */
export async function resetOverrides(copyRootId: string): Promise<boolean> {
  const rootNode = getNode(copyRootId)
  if (!isComponentCopyRoot(rootNode)) return false

  const entries: Array<{ id: string; set: Partial<Node> }> = []

  for (const id of [copyRootId, ...descendants(copyRootId)]) {
    const node = getNode(id)
    const touched = node?.touched as string[] | undefined
    if (!node || !touched || touched.length === 0) continue

    const groups = new Set(touched.filter((g) => !UNSYNCED_GROUPS.has(g as never)))
    const main = getNode(node.shapeRef)

    const restore: Record<string, unknown> = { touched: undefined }
    if (main) {
      for (const attr of attrsInGroups(node.type, groups)) {
        restore[attr] = (main as unknown as Record<string, unknown>)[attr]
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
      }
    }
    entries.push({ id, set: restore as Partial<Node> })
  }

  // Declared prop values are the other half of "this instance differs from its
  // component", so resetting clears them too. The attributes they drove are
  // already covered above: setting a prop marks the target's group as touched,
  // exactly like a freeform edit.
  const propValues = (rootNode as { propValues?: Record<string, unknown> }).propValues
  if (propValues != null && Object.keys(propValues).length > 0) {
    const existing = entries.find((entry) => entry.id === copyRootId)
    if (existing) existing.set = { ...existing.set, propValues: {} } as Partial<Node>
    else entries.push({ id: copyRootId, set: { propValues: {} } as Partial<Node> })
  }

  if (entries.length === 0) return false

  await commitChanges({ changes: modsByValue('node', entries, true) })
  return true
}
