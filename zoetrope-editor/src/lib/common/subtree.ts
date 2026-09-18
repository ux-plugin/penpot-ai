/**
 * Subtree walking over a page's `objects` map.
 *
 * Deliberately structural: it asks only for `{ shapes?: string[] }`, so it works
 * for `IndexedShape`, `PenpotNode`, a valtio snapshot, or a plain test fixture
 * without dragging in the worker types.
 */

interface HasChildren {
  shapes?: string[]
}

/**
 * Every descendant id of `rootId`, excluding it, depth-first.
 *
 * Cycle-safe: a malformed document whose child list loops back on an ancestor
 * would otherwise spin forever here.
 */
export function subtreeOf(
  objects: Record<string, HasChildren | undefined>,
  rootId: string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>([rootId])
  const stack = [...(objects[rootId]?.shapes ?? [])]
  while (stack.length) {
    const id = stack.pop()
    if (id == null || seen.has(id)) continue
    const node = objects[id]
    if (!node) continue
    seen.add(id)
    out.push(id)
    for (const child of node.shapes ?? []) stack.push(child)
  }
  return out
}

/** `rootId` followed by every descendant — the whole subtree, root first. */
export function subtreeWithRoot(
  objects: Record<string, HasChildren | undefined>,
  rootId: string,
): string[] {
  return [rootId, ...subtreeOf(objects, rootId)]
}
