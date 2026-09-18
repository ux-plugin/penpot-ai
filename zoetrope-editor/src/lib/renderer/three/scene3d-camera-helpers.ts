/**
 * scene3d-camera-helpers — draw the cameras you are NOT looking through.
 *
 * Cameras are the only viewpoints: you render THROUGH one, so the rest are invisible
 * unless we draw them. Each gets a wireframe frustum (THREE.CameraHelper) plus a small
 * body, which is what makes a camera something you can see — and grab — in space. The
 * camera being looked through is skipped (you'd be sitting inside its own frustum).
 *
 * EDITOR CHROME: helpers are added only while the scene is being edited and removed
 * otherwise, so they can never leak into the composited/preview render.
 *
 * The frustum deliberately does NOT use the camera's real far plane (CAM_FAR = 100) —
 * that would draw a cone spanning the whole world. A stand-in camera carries the same
 * pose + lens with a short far plane, so the frustum reads as a compact cone.
 */

import * as THREE from 'three'
import {
  activeCamera,
  sceneCameras,
  type Camera3DEntry,
  type Scene3DCameraHelper,
  type Scene3DDocument,
  type Scene3DInstance,
} from './scene3d-store'
import { applyCameraPose, disposeObject } from './three-scene'
import { orthoFrustum, perspHalfHeightAtDistance } from './camera3d'

/** Depth of the drawn frustum, in world units (objects here are ~1.3 across). */
const FRUSTUM_NEAR = 0.06
const FRUSTUM_FAR = 1.25
/** Home distance the default ortho size derives from (matches three-scene's CAM_HOME_POS). */
const HOME_DIST = Math.hypot(2.4, 1.8, 2.8)

const COLOR_IDLE = 0x6d5ee6
const COLOR_SELECTED = 0xa78bfa

/** What the helper GEOMETRY depends on — a change here rebuilds it. The pose is not
 *  included: it's cheap to re-apply on every sync. */
function lensKeyOf(cam: Camera3DEntry, aspect: number, selected: boolean): string {
  const size = cam.projection === 'orthographic' ? (cam.orthoSize ?? null) : null
  return `${cam.projection}|${cam.fov}|${size}|${aspect.toFixed(3)}|${selected}`
}

function buildHelper(cam: Camera3DEntry, aspect: number, selected: boolean): Scene3DCameraHelper {
  const color = selected ? COLOR_SELECTED : COLOR_IDLE
  let proxy: THREE.PerspectiveCamera | THREE.OrthographicCamera
  if (cam.projection === 'orthographic') {
    const halfH = cam.orthoSize ?? perspHalfHeightAtDistance(cam.fov, HOME_DIST)
    const f = orthoFrustum(halfH, aspect)
    proxy = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, FRUSTUM_NEAR, FRUSTUM_FAR)
  } else {
    proxy = new THREE.PerspectiveCamera(cam.fov, aspect, FRUSTUM_NEAR, FRUSTUM_FAR)
  }

  const helper = new THREE.CameraHelper(proxy)
  // CameraHelper colours per-vertex; paint every part one colour so the frustum reads as
  // a single object rather than three.js's default multi-coloured debug rig.
  const c = new THREE.Color(color)
  helper.setColors(c, c, c, c, c)

  // A small unlit body at the apex so the camera is visible head-on (and pickable later).
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.1, 0.18),
    new THREE.MeshBasicMaterial({ color }),
  )
  body.name = 'camera-body'

  // The group stays at identity: the helper positions itself from the proxy camera's
  // world matrix, and the body is posed in world space to match.
  const group = new THREE.Group()
  group.name = `camera-helper:${cam.id}`
  group.add(helper, body)

  return { group, cam: proxy, helper, lensKey: lensKeyOf(cam, aspect, selected) }
}

function disposeHelper(h: Scene3DCameraHelper): void {
  disposeObject(h.group)
}

/** Re-pose the stand-in camera + body from the entry and refresh the frustum lines. */
function poseHelper(h: Scene3DCameraHelper, cam: Camera3DEntry): void {
  applyCameraPose(h.cam, cam)
  // The helper reads the camera's matrixWorld, and the proxy isn't in the scene graph,
  // so nothing else would compute it.
  h.cam.updateMatrixWorld(true)
  h.helper.update()
  const body = h.group.getObjectByName('camera-body')
  if (body) {
    body.position.copy(h.cam.position)
    body.quaternion.copy(h.cam.quaternion)
  }
}

/**
 * Bring the instance's camera helpers in line with the document: one per camera except
 * the looked-through one, or none at all when `visible` is false (not editing).
 */
export function syncCameraHelpers(
  inst: Scene3DInstance,
  doc: Scene3DDocument,
  opts: { visible: boolean; aspect: number; selectedCameraId: string | null },
): void {
  const activeId = activeCamera(doc).id
  const wanted = opts.visible ? sceneCameras(doc).filter((c) => c.id !== activeId) : []
  const wantedIds = new Set(wanted.map((c) => c.id))

  // Drop helpers for cameras that are gone, now active, or no longer shown.
  for (const [id, h] of inst.cameraHelpers) {
    if (!wantedIds.has(id)) {
      inst.scene.remove(h.group)
      disposeHelper(h)
      inst.cameraHelpers.delete(id)
    }
  }

  for (const cam of wanted) {
    const lensKey = lensKeyOf(cam, opts.aspect, cam.id === opts.selectedCameraId)
    let h = inst.cameraHelpers.get(cam.id)
    if (h && h.lensKey !== lensKey) {
      // Lens/aspect/selection changed — the frustum geometry itself differs, so rebuild.
      inst.scene.remove(h.group)
      disposeHelper(h)
      inst.cameraHelpers.delete(cam.id)
      h = undefined
    }
    if (!h) {
      h = buildHelper(cam, opts.aspect, cam.id === opts.selectedCameraId)
      inst.cameraHelpers.set(cam.id, h)
      inst.scene.add(h.group)
    }
    poseHelper(h, cam)
  }
}
