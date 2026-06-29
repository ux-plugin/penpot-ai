/**
 * create-3d-scene — the creation flow for an embedded 3D scene.
 *
 * Drops a real container `rect` (invisible fill) into the document via the node
 * factory, with a default Scene3DDocument (one starter cube + a shared camera and
 * environment) riding on it as `node.scene3d`. The rect is the document source of
 * truth for the scene's bounds/selection/move/undo; the three.js overlay paints
 * the whole scene into the rect's screen region. Creation drops you straight into
 * 3D-edit mode (Spline-style), focused on the starter object.
 */

import { applyChanges } from '../../page-crud'
import { createRect } from '../node-factory'
import { setSelectedIds } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { viewport } from '../signals/pointer'
import { screenToWorld } from '../viewport'
import type { AddObjChange } from 'penpot-exporter/types'
import { defaultSceneDocument, setEditingScene } from './scene3d-store'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
const DEFAULT_WIDTH = 360
const DEFAULT_HEIGHT = 260

/** Visible centre of the current viewport in world coords (falls back if no canvas). */
function viewportCenterWorld(): { x: number; y: number } {
  // The viewport signal is null until a document loads or the user interacts;
  // fall back to the app's own default view (panX:0, panY:0, zoom:1).
  const vp = viewport.value ?? { panX: 0, panY: 0, zoom: 1 }
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
  const cw = canvas?.clientWidth ?? 800
  const ch = canvas?.clientHeight ?? 600
  return screenToWorld(vp, cw / 2, ch / 2)
}

/**
 * Create a 3D scene (with a default cube) at the centre of the viewport and enter
 * edit mode. Returns the scene container rect's id, or null if there's no active page.
 */
export async function create3DScene(): Promise<string | null> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const page = getPage(pageId)
  if (!page) return null

  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID

  const center = viewportCenterWorld()
  const rect = createRect({
    x: center.x - DEFAULT_WIDTH / 2,
    y: center.y - DEFAULT_HEIGHT / 2,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    parentId: rootId,
    name: '3D scene',
    // Invisible fill — the three.js overlay paints the scene over this region.
    fillColor: '#000000',
    fillOpacity: 0,
  })

  // The serializable scene rides on the rect as `node.scene3d`, so 3D state lives
  // in the document from creation onward. scene3d-sync upserts it into the proxy
  // when this add-obj commits.
  const objectId = crypto.randomUUID()
  const sceneDoc = defaultSceneDocument(rect.id, objectId)

  const addChange: AddObjChange = {
    type: 'add-obj',
    id: rect.id,
    obj: { ...rect, scene3d: sceneDoc } as AddObjChange['obj'],
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  await applyChanges([addChange])

  setSelectedIds(new Set([rect.id]))
  setEditingScene(rect.id)
  return rect.id
}
