/**
 * Component sync — an edit to a main instance fanning out into its copies.
 *
 * An effect of `commitChanges`: it inspects the node writes a commit is about
 * to apply, works out which copies must follow, and returns the extra changes.
 * They land in the same frame, so one Cmd+Z reverts the main edit and every
 * copy it updated.
 *
 * Out of scope here, by phase: geometry (see UNSYNCED_GROUPS in ./sync-attrs),
 * structure (children added, removed or reordered — P6), and nested copies
 * inside a main.
 */
import type { PenpotNode } from 'penpot-exporter/types'
import type { Change, Effect, LocalChange, Node } from '../../doc'
import { get, meta, modsByValue, readersOf } from '../../doc'
import {
  APPLIED_TOKENS_ATTR,
  appliedTokenGroup,
  changedTokenProps,
  resolveSyncGroup,
  UNSYNCED_GROUPS,
} from './sync-attrs'

type AttrWrites = Record<string, unknown>

interface ShapeWrites {
  /** Everything written, whatever the source — drives the fan-out into copies. */
  attrs: AttrWrites
  /** Only what the *user* wrote (`system` changes excluded) — drives override marking. */
  userAttrs: AttrWrites
}

function collectWrites(changes: readonly Change[]): Map<string, ShapeWrites> {
  const out = new Map<string, ShapeWrites>()
  for (const c of changes) {
    if (c.op !== 'mod' || c.kind !== 'node') continue
    const entry = out.get(c.id) ?? { attrs: {}, userAttrs: {} }
    Object.assign(entry.attrs, c.set)
    if (!c.system) Object.assign(entry.userAttrs, c.set)
    if (Object.keys(entry.attrs).length > 0) out.set(c.id, entry)
  }
  return out
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge a main's token-binding change into one copy, key by key. Only the keys
 * that changed on the main carry over; keys the copy overrode stay.
 */
function mergeAppliedTokens(
  mainBefore: Record<string, string> | undefined,
  mainAfter: Record<string, string> | undefined,
  copy: PenpotNode,
  touched: ReadonlySet<string>,
): Record<string, string> | null {
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
  return jsonEqual(merged, current) ? null : merged
}

/**
 * Override marking: a user edit to a node inside a copy freezes that
 * attribute's group on that node. A write that changes nothing marks nothing,
 * and geometry on a copy root is never an override.
 */
function collectOverrideMarks(writes: Map<string, ShapeWrites>): Array<{ id: string; set: Partial<Node> }> {
  const out: Array<{ id: string; set: Partial<Node> }> = []
  for (const [id, { userAttrs }] of writes) {
    if (Object.keys(userAttrs).length === 0) continue
    const node = get('node', id)
    if (!node || node.shapeRef == null) continue
    const existing = new Set<string>((node.touched as string[] | undefined) ?? [])
    const next = new Set(existing)
    const isCopyRoot = node.componentRoot === true
    for (const [attr, value] of Object.entries(userAttrs)) {
      if (attr === APPLIED_TOKENS_ATTR) {
        for (const prop of changedTokenProps(node.appliedTokens, value as Record<string, string> | undefined)) {
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
    out.push({ id, set: { touched: [...next].sort() } as Partial<Node> })
  }
  return out
}

/** The main root enclosing `nodeId`, or null. A copy root on the way up ends the search. */
function enclosingMainRoot(nodeId: string): string | null {
  let current = get('node', nodeId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.mainInstance === true && current.componentId != null) return current.id
    if (current.componentRoot === true && current.mainInstance !== true) return null
    current = current.parentId ? get('node', current.parentId) : undefined
  }
  return null
}

/** The copied nodes that mirror `mainId`. */
function copiesOf(mainId: string): Node[] {
  const out: Node[] = []
  for (const id of readersOf('node', 'shapeRef', mainId)) {
    const n = get('node', id)
    if (n) out.push(n)
  }
  return out
}

export const componentSyncEffect: Effect = (changes) => {
  const components = meta.peek()?.components
  if (components == null || Object.keys(components).length === 0) return []

  const writes = collectWrites(changes)
  if (writes.size === 0) return []

  const marks = collectOverrideMarks(writes)

  const mainNodes: Array<{ id: string; attrs: AttrWrites }> = []
  for (const [id, { attrs }] of writes) {
    if (enclosingMainRoot(id) == null) continue
    mainNodes.push({ id, attrs })
  }

  const fanOut: Array<{ id: string; set: Partial<Node> }> = []
  if (mainNodes.length > 0) {
    for (const main of mainNodes) {
      const targets = copiesOf(main.id)
      const mainBefore = get('node', main.id)
      for (const node of targets) {
        const touched = new Set<string>((node.touched as string[] | undefined) ?? [])
        const next: AttrWrites = {}
        for (const [attr, value] of Object.entries(main.attrs)) {
          if (attr === APPLIED_TOKENS_ATTR) {
            const merged = mergeAppliedTokens(
              mainBefore?.appliedTokens,
              value as Record<string, string> | undefined,
              node,
              touched,
            )
            if (merged) next[attr] = merged
            continue
          }
          const group = resolveSyncGroup(node.type, attr)
          if (group == null || UNSYNCED_GROUPS.has(group) || touched.has(group)) continue
          next[attr] = value
        }
        if (Object.keys(next).length > 0) fanOut.push({ id: node.id, set: next as Partial<Node> })
      }
    }
  }

  const out: LocalChange[] = []
  if (fanOut.length) out.push(...modsByValue('node', fanOut, true))
  if (marks.length) out.push(...modsByValue('node', marks, true))
  return out
}
