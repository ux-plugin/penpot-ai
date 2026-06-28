/**
 * create-3d-object — the creation flow for an embedded 3D object.
 *
 * Mirrors the rectangle draw path (`handlers/draw-shape.ts`): build a real
 * `rect` node (invisible fill) via the node factory, commit it with
 * `applyChanges`, then register the serializable 3D spec and select it. The
 * rect is the document source of truth for bounds/selection/move/undo; the
 * three.js overlay paints the 3D into the rect's screen region.
 */

import { applyChanges } from '../../page-crud'
import { createRect } from '../node-factory'
import { setSelectedIds } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { viewport } from '../signals/pointer'
import { screenToWorld } from '../viewport'
import type { AddObjChange } from 'penpot-exporter/types'
import { add3DObject, defaultEntry, setSelected3D, type Source3D } from './scene3d-store'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
const DEFAULT_SIZE = 240

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
 * Create a 3D object (default: a cube) at the centre of the viewport.
 * Returns the placeholder rect's id, or null if there's no active page.
 */
export async function create3DObject(
  source: Source3D = { kind: 'primitive', ref: 'cube' },
): Promise<string | null> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const page = getPage(pageId)
  if (!page) return null

  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID

  const center = viewportCenterWorld()
  const size = DEFAULT_SIZE
  const rect = createRect({
    x: center.x - size / 2,
    y: center.y - size / 2,
    width: size,
    height: size,
    parentId: rootId,
    name: '3D object',
    // Invisible fill (alpha 0) — present so the rect still hit-tests for
    // selection, but the three.js overlay paints over it. If click-selection
    // turns out not to hit a 0-alpha fill, fall back to overlay-forwarded
    // selection (see plan).
    fillColor: '#000000',
    fillOpacity: 0,
  })

  const addChange: AddObjChange = {
    type: 'add-obj',
    id: rect.id,
    obj: rect,
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  await applyChanges([addChange])

  add3DObject(defaultEntry(rect.id, source))
  setSelectedIds(new Set([rect.id]))
  setSelected3D(rect.id)
  return rect.id
}
