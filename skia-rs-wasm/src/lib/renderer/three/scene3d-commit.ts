/**
 * scene3d-commit — write 3D-object state into the document (undoable).
 *
 * The serializable `Scene3DEntry` lives on the placeholder rect as `node.scene3d`
 * (see worker/types.ts). All edits flow through the same `mod-obj` pipeline the
 * 2D inspector uses (`commitNodePartialUpdate`), so each edit is one history frame
 * with a paired inverse — Cmd-Z restores the prior 3D state. `scene3d` is treated
 * as an opaque attribute: snapshotted for undo, assigned for redo, never sent to
 * WASM. `scene3dProxy` is kept in sync from the document by `scene3d-sync.ts`, so
 * callers here don't touch the proxy — they commit, the sync handler reconciles.
 */

import type { PenpotNode } from 'penpot-exporter/types'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../properties/commit-node-properties'
import { getActiveOrSinglePageId } from '../store/doc-proxy'
import type { Scene3DEntry } from './scene3d-store'

/** The committed entry on the node (plain clone, detached from the valtio proxy). */
function currentEntry(id: string): Scene3DEntry | null {
  const node = getCommittedNodeOnActivePage(id) as { scene3d?: Scene3DEntry } | null
  const entry = node?.scene3d
  return entry ? (structuredClone(entry) as Scene3DEntry) : null
}

/** Commit a full Scene3DEntry onto the node as one undoable `mod-obj`. */
export async function commitScene3d(id: string, next: Scene3DEntry): Promise<void> {
  const before = getCommittedNodeOnActivePage(id)
  const pid = getActiveOrSinglePageId()
  if (!before || !pid) return
  await commitNodePartialUpdate(id, before, { scene3d: next } as Partial<PenpotNode>, pid)
}

export async function commitTransform3d(
  id: string,
  patch: Partial<Scene3DEntry['transform3d']>,
): Promise<void> {
  const entry = currentEntry(id)
  if (!entry) return
  Object.assign(entry.transform3d, patch)
  await commitScene3d(id, entry)
}

export async function commitMaterial(
  id: string,
  patch: Partial<Scene3DEntry['material']>,
): Promise<void> {
  const entry = currentEntry(id)
  if (!entry) return
  Object.assign(entry.material, patch)
  await commitScene3d(id, entry)
}

export async function commitCamera(
  id: string,
  patch: Partial<Scene3DEntry['camera']>,
): Promise<void> {
  const entry = currentEntry(id)
  if (!entry) return
  Object.assign(entry.camera, patch)
  await commitScene3d(id, entry)
}

export async function commitEnv(
  id: string,
  patch: Partial<Scene3DEntry['env']>,
): Promise<void> {
  const entry = currentEntry(id)
  if (!entry) return
  Object.assign(entry.env, patch)
  await commitScene3d(id, entry)
}
