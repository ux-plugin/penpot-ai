/**
 * Path-edit session cleanup — wired as the `exit` action of the machine's
 * `pathEditing` state. It runs exactly once on EVERY way of leaving an edit
 * session (done / Escape / tool-switch / click-away), so no exit can skip it:
 * the single authoritative point enforcing "a path with no edges must not
 * persist" (a lone dot / isolated nodes render nothing).
 *
 * This replaces the old scattered enforcement (a `useEffect` watching a transient
 * `isPathEditing && !inPen` state), which the "done" exit jumped past.
 */

import { del, endGroup, getNode } from '../../doc'
import { getSelectedIdsSet, setSelectedIds } from '../store/document-selection'
import { vnFromContent } from '../geom/vn-from-content'
import { applyChanges } from '../../page-crud'

/**
 * Remove the just-edited path if it ended the session with no edges. Reads the
 * committed node by id — the machine passes `context.pathEditingShapeId`, which is
 * still set when the exit action runs (XState runs a state's exit actions before
 * the transition's own actions clear it).
 */
export function dropDegeneratePathOnExit(shapeId: string | null): void {
  if (!shapeId) return
  const node = getNode(shapeId)
  if (!node) return
  if (vnFromContent((node as { content?: unknown }).content).edges.length > 0) return

  // A pen-create dot abandoned before any edge still holds its open undo
  // group — close it so the delete stands on its own.
  endGroup()
  const sel = getSelectedIdsSet()
  if (sel.has(shapeId)) {
    const next = new Set(sel)
    next.delete(shapeId)
    setSelectedIds(next)
  }
  void applyChanges([del('node', shapeId)])
}
