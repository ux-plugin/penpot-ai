/**
 * scene3d-sync — reconcile `scene3dProxy.scenes` from the document.
 *
 * `node.scene3d` (a Scene3DDocument on the scene container node) is the source
 * of truth. This subscriber runs on EVERY commit, including undo/redo, so the
 * three.js read-cache tracks the document both ways. It never emits changes.
 */
import type { ChangesAppliedEvent } from '../../doc/commit'
import { get, records, type Node } from '../../doc'
import { scene3dProxy, removeScene, type Scene3DDocument } from './scene3d-store'

function clonePlain(doc: Scene3DDocument): Scene3DDocument {
  return JSON.parse(JSON.stringify(doc)) as Scene3DDocument
}

function reconcile(id: string): void {
  const doc = get('node', id)?.scene3d
  if (doc) scene3dProxy.scenes.set(id, clonePlain(doc))
  else if (scene3dProxy.scenes.has(id)) removeScene(id)
}

export function scene3dSyncHandler(event: ChangesAppliedEvent): void {
  const ids = new Set<string>()
  for (const a of event.applied) {
    const c = a.change
    if (c.kind !== 'node') continue
    if (c.op === 'mod') {
      if ('scene3d' in c.set) ids.add(c.id)
    } else ids.add(c.op === 'add' ? c.record.id : c.id)
  }
  for (const id of ids) reconcile(id)
}

/** Rebuild the read-cache from every node. Document load. */
export function hydrateScene3dFromDocument(): void {
  for (const id of Array.from(scene3dProxy.scenes.keys())) removeScene(id)
  for (const n of records('node')) {
    const doc = (n as Node).scene3d
    if (doc) scene3dProxy.scenes.set(n.id, clonePlain(doc))
  }
  scene3dProxy.focusedObjectId = null
}
