/**
 * Scene3DLayer — the transparent three.js overlay over the Skia canvas.
 *
 * One WebGLRenderer; each 3D scene is painted into its container node's screen
 * region via a per-scene scissor viewport, with the scene's shared camera. The
 * camera is slaved to the 2D viewport: pan/zoom/move the container and the 3D
 * tracks it. While a scene is in edit mode (the `scene3dEditing` canvasMachine
 * state) it renders live and owns the pointer (gizmo on the focused object · orbit
 * · raycast pick); the contextual add/gizmo menu lives in the bottom toolbar
 * (ShapeToolbar), like the pen flyout. Redraw is on-demand.
 */

import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useSnapshot, subscribe } from 'valtio'
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { effect } from '@preact/signals-core'
import { viewport, movePreviewWorldDelta } from '../signals/pointer'
import { worldToScreen, screenToWorld } from '../viewport'
import { useWorkspaceStore } from '../store/workspace-store'
import { docProxy, getNode } from '../store/doc-proxy'
import {
  scene3dProxy,
  getInstance,
  setInstance,
  deleteInstance,
  isScene3D,
  activeCamera,
  sceneCameras,
  setFocusedObject,
  setSelectedCamera,
  patchObjectTransformLocal,
  patchCameraTransformLocal,
  dollyBounds,
  frameDistanceForRadius,
  sceneFrameViewRequest,
  SCENE3D_EDIT_BACKDROP,
  type Scene3DDocument,
  type Scene3DInstance,
} from './scene3d-store'
import {
  buildSceneInstance,
  applyDocToInstance,
  readTransformFromObject,
  readCameraPose,
  defaultCameraPose,
  pickScene3d,
} from './three-scene'
import { isOrtho, isPersp, orthoFrustum } from './camera3d'
import { syncCameraHelpers } from './scene3d-camera-helpers'
import { recenterOnScene } from './scene3d-recenter'
import { editPlacement, exitFocus, focusViewportRect } from './scene3d-focus'
import { beginEditSession, endEditSession, markEditDirty } from './edit-history'
import {
  scene3dResizePreview,
  applyResize,
  commitSceneBounds,
  type ResizeHandle,
  type Bounds,
} from './scene3d-resize'
import { commitCameraPatch, commitObjectTransform } from './scene3d-commit'
import { useScene3dEditing } from './use-scene3d-editing'
import {
  isBakeEnabled,
  isLiveEditEnabled,
  bakeSceneToNode,
  bakeEditingScene,
  unbakeNodeFill,
  reconcileBakes,
} from './scene3d-bake'

interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

/** The 8 edit-mode resize handles: corner/edge, CSS offset within the box, and cursor. */
const RESIZE_HANDLES: { h: ResizeHandle; pos: CSSProperties; cursor: string }[] = [
  { h: 'nw', pos: { top: -5, left: -5 }, cursor: 'nwse-resize' },
  { h: 'n', pos: { top: -5, left: 'calc(50% - 5px)' }, cursor: 'ns-resize' },
  { h: 'ne', pos: { top: -5, right: -5 }, cursor: 'nesw-resize' },
  { h: 'e', pos: { top: 'calc(50% - 5px)', right: -5 }, cursor: 'ew-resize' },
  { h: 'se', pos: { bottom: -5, right: -5 }, cursor: 'nwse-resize' },
  { h: 's', pos: { bottom: -5, left: 'calc(50% - 5px)' }, cursor: 'ns-resize' },
  { h: 'sw', pos: { bottom: -5, left: -5 }, cursor: 'nesw-resize' },
  { h: 'w', pos: { top: 'calc(50% - 5px)', left: -5 }, cursor: 'ew-resize' },
]

/**
 * The scene's live instance, rebuilt if its camera type no longer matches the active
 * projection (a persp⇄ortho swap). Rebuilding resets the view pose — acceptable until
 * persisted camera pose lands (Phase 1b-ii); everything else reconciles from the doc.
 */
function syncedInstance(
  sceneId: string,
  doc: Scene3DDocument,
  renderer: THREE.WebGLRenderer,
): Scene3DInstance {
  const active = activeCamera(doc)
  const wantOrtho = active.projection === 'orthographic'
  let inst = getInstance(sceneId)
  // Rebuild when the projection class flips (persp⇄ortho) OR the look-through camera
  // changes — either way the new camera's pose/projection/fov must take, and the
  // orbit/gizmo controls (bound to inst.camera) rebind via the effect below.
  if (inst && (isOrtho(inst.camera) !== wantOrtho || inst.activeCamId !== active.id)) {
    deleteInstance(sceneId)
    inst = undefined
  }
  if (!inst) {
    inst = buildSceneInstance(renderer, doc)
    setInstance(sceneId, inst)
  }
  return inst
}

/**
 * Render one scene into its scissored screen box with FULLY-EXPLICIT GL state, so no
 * state leaks in or out — the single choke point for touching the renderer per scene.
 * `backdrop` is the edit-mode fill colour (null = transparent, composites over the 2D
 * canvas). We deliberately do NOT use `scene.background`: a Color background makes three
 * mutate the renderer's *shared* clear colour behind our back (that side effect is what
 * leaked the backdrop to the whole overlay). Instead the backdrop is a plain clear,
 * scoped to the scissor box, with the clear colour set explicitly every render.
 */
function renderSceneIntoBox(
  renderer: THREE.WebGLRenderer,
  inst: Scene3DInstance,
  glX: number,
  glY: number,
  sw: number,
  sh: number,
  backdrop: string | null,
): void {
  const aspect = sw / sh
  if (isPersp(inst.camera)) {
    // Plain centered camera: the box's full frame IS the camera. Vertical FOV is fixed,
    // so the effective FOV depends only on aspect (never the box's absolute size), and
    // shapes grow naturally on dolly with no shear; resize reframes like a 3D window.
    inst.camera.aspect = aspect
    inst.camera.clearViewOffset()
  } else {
    // Orthographic: rebuild the frustum from the stored world half-height + aspect each
    // frame (zoom is applied separately by OrbitControls via camera.zoom).
    const halfH = (inst.camera.userData.orthoHalfHeight as number | undefined) ?? 1
    const f = orthoFrustum(halfH, aspect)
    inst.camera.left = f.left
    inst.camera.right = f.right
    inst.camera.top = f.top
    inst.camera.bottom = f.bottom
    inst.camera.updateProjectionMatrix()
  }

  inst.scene.background = null // never rely on three's background (it mutates clearColor)
  renderer.setViewport(glX, glY, sw, sh)
  renderer.setScissor(glX, glY, sw, sh)
  renderer.setScissorTest(true)
  renderer.setClearColor(backdrop ? new THREE.Color(backdrop) : 0x000000, backdrop ? 1 : 0)
  renderer.clear(true, true, false) // colour + depth, scoped to the scissor box
  renderer.render(inst.scene, inst.camera)
}

/** The single selected scene id (when exactly one 3D scene is selected), else null. */
function selectedSceneId(): string | null {
  const sel = docProxy.selectedIds
  if (sel.size !== 1) return null
  const id = sel.values().next().value as string
  return isScene3D(id) ? id : null
}

export function Scene3DLayer({ canvasSize }: { canvasSize: { width: number; height: number } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editSurfaceRef = useRef<HTMLDivElement>(null)
  const locatorRef = useRef<HTMLButtonElement>(null)
  const resizeBoxRef = useRef<HTMLDivElement>(null)
  const resizeStateRef = useRef<{ handle: ResizeHandle; sceneId: string; startWorld: { x: number; y: number }; startBounds: Bounds } | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const gizmoRef = useRef<TransformControls | null>(null)
  const orbitRef = useRef<OrbitControls | null>(null)
  const rafRef = useRef(0)
  const selRectRef = useRef<ScreenRect | null>(null)
  // The redraw effect captures a stale draw closure (empty deps), so reading the
  // canvasSize prop / edit state directly would use initial values. Read live
  // values from refs instead.
  const canvasSizeRef = useRef(canvasSize)
  canvasSizeRef.current = canvasSize

  const snap = useSnapshot(scene3dProxy)
  const { actor, editingSceneId, gizmoMode, exit } = useScene3dEditing()
  const editingIdRef = useRef(editingSceneId)
  editingIdRef.current = editingSceneId

  // Active projection of the scene being edited — a persp⇄ortho toggle flips it. The
  // controls effect re-runs on this so orbit/gizmo rebind to the rebuilt camera.
  const editingDoc = editingSceneId
    ? (snap.scenes.get(editingSceneId) as Scene3DDocument | undefined)
    : undefined
  const editingProjection = editingDoc ? activeCamera(editingDoc).projection : null
  // The look-through camera of the edited scene — the controls effect re-runs on a
  // switch so orbit/gizmo rebind to the rebuilt camera at its own pose.
  const editingActiveCameraId = editingDoc ? activeCamera(editingDoc).id : null

  // --- init renderer once ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)
    renderer.autoClear = false
    renderer.setScissorTest(true)
    rendererRef.current = renderer
    scheduleDraw()
    return () => {
      renderer.dispose()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- keep the drawing buffer in lockstep with the WASM canvas ---
  useEffect(() => {
    rendererRef.current?.setSize(canvasSize.width, canvasSize.height, false)
    scheduleDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasSize.width, canvasSize.height])

  // --- redraw on 2D viewport (pan/zoom), model changes, and selection changes ---
  useEffect(() => {
    const disposeVp = effect(() => {
      void viewport.value // pan/zoom
      void movePreviewWorldDelta.value // live move-drag translation (and reset on commit)
      void scene3dResizePreview.value // live resize-drag bounds
      void editPlacement.value // in-place ⇄ focus
      void focusViewportRect.value // central-hole bounds (panels resized)
      scheduleDraw()
    })
    const unsubModel = subscribe(scene3dProxy, scheduleDraw)
    const unsubSel = subscribe(docProxy.selectedIds, scheduleDraw)
    return () => {
      disposeVp()
      unsubModel()
      unsubSel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redraw when edit mode toggles (it gates the edit surface + selRect).
  useEffect(() => {
    scheduleDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSceneId])

  // If the edited scene disappears (e.g. an undo deletes it), exit edit mode
  // cleanly — the store can't reach the machine actor, so the overlay reconciles.
  useEffect(() => {
    if (editingSceneId && !snap.scenes.has(editingSceneId)) exit()
  }, [editingSceneId, snap.scenes, exit])

  // 3D-edit follows the selection. Entering edit always sets the selection to exactly
  // the scene ({sceneId}) first (every enter site does this), so if the selection
  // later stops being that one scene — another Layers-panel row, a different node
  // clicked on the canvas, a cleared or multi-selection — 3D-edit is stale and we
  // exit. Making exit a function of *selection state* (not of which widget got the
  // click) is the one rule that covers every path uniformly, so it can't be bypassed
  // by selecting through the Layers panel the way a canvas-only click-away was.
  // Reads the editing scene fresh from the actor (not a captured value) so a
  // scene→scene switch — exit A + enter B in the same tick — never races on a stale
  // id: by the time valtio flushes this microtask, editingSceneId is already B.
  useEffect(() => {
    return subscribe(docProxy.selectedIds, () => {
      const editId = actor.getSnapshot().context.scene3dEditingId
      if (!editId) return
      const sel = docProxy.selectedIds
      if (sel.size === 1 && sel.has(editId)) return // still editing the selected scene
      exit()
    })
  }, [actor, exit])

  // Focus is meaningful only inside edit mode; clear it whenever 3D-edit ends so
  // keyboard/command exits (Esc / V, via runCommand) match the menu's exit(), which
  // also clears focus. Keeps the "no focus outside edit" invariant in one place.
  useEffect(() => {
    if (!editingSceneId) {
      setFocusedObject(null)
      setSelectedCamera(null)
    }
  }, [editingSceneId])

  // Focus mode is opt-in per edit session: entering (or switching) a scene always
  // starts in-place, so a stale "focus" from a previous session can't carry over.
  useEffect(() => {
    exitFocus()
  }, [editingSceneId])

  // Edit-history: open a session while editing; on exit (cleanup) record it if it was
  // substantial (dwelled or did work) so it can be resumed without the layers tree.
  useEffect(() => {
    const sceneId = editingSceneId
    if (!sceneId) return
    beginEditSession(sceneId)
    return () => {
      const name = (getNode(sceneId) as { name?: string } | undefined)?.name ?? '3D scene'
      endEditSession({ kind: 'scene3d', targetId: sceneId, name })
    }
  }, [editingSceneId])

  // "Did real work" once an object is focused/manipulated (dwell covers pure looking).
  useEffect(() => {
    if (snap.focusedObjectId) markEditDirty()
  }, [snap.focusedObjectId])

  // Frame / reset view (F) — driven by the store's request signal, outside the
  // redraw path. frameView() guards on edit state, so the immediate subscribe call
  // (and any request fired while not editing) is a no-op.
  useEffect(() => {
    return sceneFrameViewRequest.subscribe(() => frameView())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- attach gizmo + orbit + raycast pick while editing a scene ---
  useEffect(() => {
    const sceneId = editingSceneId
    if (!sceneId) return
    const renderer = rendererRef.current
    const surface = editSurfaceRef.current
    const doc = scene3dProxy.scenes.get(sceneId) as Scene3DDocument | undefined
    if (!renderer || !surface || !doc) return

    // draw() builds instances lazily on RAF, but entering edit / adding an object
    // must not wait a frame — build the instance and its objects eagerly so the gizmo
    // can attach to a just-added object this tick. syncedInstance also rebuilds it when
    // the active projection was toggled (persp⇄ortho), so the controls below bind the
    // correct camera type.
    const inst = syncedInstance(sceneId, doc, renderer)
    applyDocToInstance(inst, doc)

    // Left-drag orbits; right-drag pans (slides the whole scene within the peephole);
    // scroll / pinch / middle-drag dollies — the 3D "zoom": it moves the camera toward
    // or away from the scene (the render scale itself is fixed by the peephole, so
    // content keeps its size; dolly changes the camera distance / parallax).
    // screenSpacePanning keeps the pan parallel to the screen. View pose is
    // per-session; durable persistence is a follow-up alongside the persisted anchor.
    const orbit = new OrbitControls(inst.camera, surface)
    orbit.enableDamping = false
    orbit.enablePan = true
    orbit.screenSpacePanning = true
    orbit.enableZoom = true
    // zoomToCursor off: each scene renders into a scissor sub-rect with a
    // setViewOffset crop, so cursor-anchored zoom would unproject to the wrong world
    // point; plain dolly-toward-target is position-independent and correct here.
    orbit.zoomToCursor = false
    // buildCamera restored the camera's position + orientation from the persisted
    // pose, but the orbit PIVOT isn't in the model. Reconstruct it on the camera's
    // forward ray at the scene-centre depth so the first drag doesn't snap and
    // orbiting stays centred on the content. For a fresh camera (which looks at the
    // origin) this yields ~origin — i.e. unchanged behaviour.
    {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(inst.camera.quaternion)
      const pivotDist = Math.max(0.5, -inst.camera.position.dot(fwd))
      orbit.target.copy(inst.camera.position).addScaledVector(fwd, pivotDist)
      orbit.update()
    }
    // Clamp the dolly to the scene's home distance (captured once on the camera, so
    // it survives dolly + edit-exit/re-enter without ratcheting the bounds inward).
    const camUserData = inst.camera.userData as {
      homeDistance?: number
      homePos?: THREE.Vector3
      homeTarget?: THREE.Vector3
      homeOrthoHalfHeight?: number
    }
    if (camUserData.homeDistance == null) {
      // Capture the home pose once — before any orbit/dolly — so Frame-view's
      // "reset to home" and the dolly clamp stay stable across exit/re-enter.
      camUserData.homeDistance = orbit.getDistance()
      camUserData.homePos = inst.camera.position.clone()
      camUserData.homeTarget = orbit.target.clone()
      if (isOrtho(inst.camera)) {
        camUserData.homeOrthoHalfHeight = inst.camera.userData.orthoHalfHeight as number
      }
    }
    const bounds = dollyBounds(camUserData.homeDistance)
    orbit.minDistance = bounds.min
    orbit.maxDistance = bounds.max
    // Orthographic "dolly" is a zoom (OrbitControls scales camera.zoom, not distance),
    // so clamp zoom rather than distance for an ortho camera.
    if (isOrtho(inst.camera)) {
      orbit.minZoom = 0.2
      orbit.maxZoom = 5
    }
    orbit.addEventListener('change', scheduleDraw)
    orbitRef.current = orbit

    // Persist the view pose (position + aim) so a reload restores where the user
    // left the camera. Live nav runs through the three camera (smooth); OrbitControls
    // fires 'end' once per gesture (orbit/pan/dolly). Debounce so a scroll burst of
    // many 'end's collapses toward ONE undoable mod-obj, mirroring the gizmo's
    // commit-on-drag-end. A pending write is flushed on edit-exit (cleanup).
    // Target THIS instance's camera id (not "whatever is active now") — the effect
    // re-runs on a look-through switch, so a pending pose can't leak onto the camera
    // the user just switched TO.
    const poseCamId = inst.activeCamId
    let poseTimer = 0
    const persistPose = () => {
      if (poseTimer) clearTimeout(poseTimer)
      poseTimer = window.setTimeout(() => {
        poseTimer = 0
        void commitCameraPatch(sceneId, poseCamId, { transform3d: readCameraPose(inst.camera) })
      }, 350)
    }
    // Drop a still-pending write when a new gesture starts: the next 'end' supersedes it
    // anyway, and letting it land MID-drag would push a stale pose into the doc, which
    // applyDocToInstance would then snap the camera back to.
    orbit.addEventListener('start', () => {
      if (poseTimer) {
        clearTimeout(poseTimer)
        poseTimer = 0
      }
    })
    orbit.addEventListener('end', persistPose)

    // A selected CAMERA (grab it in space) or the focused OBJECT is the gizmo target —
    // mutually exclusive. Scale is meaningless for a camera, so clamp scale→translate
    // while one is selected.
    const selCam = snap.selectedCameraId
      ? sceneCameras(doc).find((c) => c.id === snap.selectedCameraId)
      : undefined
    // Assigned in the attach block below; the drag handlers close over it (they only run
    // once a drag starts, long after it's set).
    let cameraProxy: THREE.Object3D | null = null

    const tc = new TransformControls(inst.camera, surface)
    tc.setMode(selCam && gizmoMode === 'scale' ? 'translate' : gizmoMode)
    tc.addEventListener('change', scheduleDraw)
    tc.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value
      orbit.enabled = !dragging
      if (dragging) return
      // On drag end, persist the final transform as ONE undoable mod-obj; scene3d-sync
      // re-seeds the proxy. (Live edits run through the local preview during the drag.)
      const objId = scene3dProxy.focusedObjectId
      const obj = objId ? inst.objects.get(objId) : null
      if (objId && obj) void commitObjectTransform(sceneId, objId, readTransformFromObject(obj))
      if (selCam && cameraProxy) void commitCameraPatch(sceneId, selCam.id, { transform3d: readCameraPose(cameraProxy) })
    })
    tc.addEventListener('objectChange', () => {
      const objId = scene3dProxy.focusedObjectId
      const obj = objId ? inst.objects.get(objId) : null
      if (objId && obj) patchObjectTransformLocal(sceneId, objId, readTransformFromObject(obj))
      // Camera grab: write the doc live so the camera's frustum follows the drag.
      if (selCam && cameraProxy) patchCameraTransformLocal(sceneId, selCam.id, readCameraPose(cameraProxy))
    })
    inst.scene.add(tc.getHelper())
    gizmoRef.current = tc

    // Attach to a camera PROXY (an empty at the camera's pose — a camera isn't a scene
    // object) or the focused object.
    if (selCam) {
      const pose = selCam.transform3d ?? defaultCameraPose()
      cameraProxy = new THREE.Object3D()
      cameraProxy.position.fromArray(pose.position)
      cameraProxy.rotation.set(
        THREE.MathUtils.degToRad(pose.rotationEuler[0]),
        THREE.MathUtils.degToRad(pose.rotationEuler[1]),
        THREE.MathUtils.degToRad(pose.rotationEuler[2]),
      )
      inst.scene.add(cameraProxy)
      tc.attach(cameraProxy)
    } else {
      const focusObj = snap.focusedObjectId ? inst.objects.get(snap.focusedObjectId) : undefined
      if (focusObj) tc.attach(focusObj)
    }

    // Click to select — an object (focus) or a camera frustum (select). A gizmo-handle
    // press is owned by TransformControls; an empty press leaves the selection and lets
    // OrbitControls drive the drag. The Layers tree stays a parallel way to select.
    const onPick = (e: PointerEvent) => {
      if (e.button !== 0) return // left button only; right/middle pan/dolly
      if (tc.axis != null) return // a gizmo handle is engaged
      const r = surface.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1
      const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1)
      const hit = pickScene3d(inst, ndcX, ndcY, inst.camera)
      if (hit?.kind === 'object') setFocusedObject(hit.id)
      else if (hit?.kind === 'camera') setSelectedCamera(hit.id)
      // empty → leave the selection as-is; OrbitControls handles the drag.
    }
    surface.addEventListener('pointerdown', onPick)

    // In edit mode the overlay (sized to the scene box) OWNS the wheel: OrbitControls
    // dollies, and stopping propagation keeps the event from bubbling to the 2D
    // canvas — so scrolling over the box zooms the scene, not the document. Outside
    // the box the overlay isn't hit, so the document keeps its normal wheel-zoom.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    scheduleDraw()

    return () => {
      // Flush a still-pending pose write so leaving edit within the debounce window
      // doesn't drop the last navigation (pending ⇒ nav happened since the last commit).
      if (poseTimer) {
        clearTimeout(poseTimer)
        void commitCameraPatch(sceneId, poseCamId, { transform3d: readCameraPose(inst.camera) })
      }
      surface.removeEventListener('pointerdown', onPick)
      surface.removeEventListener('wheel', onWheel)
      inst.scene.remove(tc.getHelper())
      tc.detach()
      tc.dispose()
      if (cameraProxy) inst.scene.remove(cameraProxy)
      orbit.dispose()
      gizmoRef.current = null
      orbitRef.current = null
      scheduleDraw()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSceneId, snap.focusedObjectId, snap.selectedCameraId, editingProjection, editingActiveCameraId])

  // Gizmo sub-tool (Move/Rotate/Scale) is machine state — apply it without
  // tearing down the controls. Scale is meaningless for a camera, so clamp it.
  useEffect(() => {
    const isCam = scene3dProxy.selectedCameraId != null
    gizmoRef.current?.setMode(isCam && gizmoMode === 'scale' ? 'translate' : gizmoMode)
    scheduleDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoMode])

  /** Frame the focused object (recenter the pivot + dolly to fit, keeping the view
   *  angle), or reset to the scene's home pose when nothing is focused. */
  function frameView() {
    const orbit = orbitRef.current
    const editingId = editingIdRef.current
    if (!orbit || !editingId) return
    const inst = getInstance(editingId)
    if (!inst) return
    const cam = inst.camera
    const focusedId = scene3dProxy.focusedObjectId
    const obj = focusedId ? inst.objects.get(focusedId) : null
    if (obj) {
      const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere())
      if (isPersp(cam)) {
        const fit = frameDistanceForRadius(sphere.radius, cam.fov)
        const dist = Math.min(Math.max(fit, orbit.minDistance), orbit.maxDistance)
        const dir = cam.position.clone().sub(orbit.target)
        if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1)
        dir.normalize()
        orbit.target.copy(sphere.center)
        cam.position.copy(sphere.center).addScaledVector(dir, dist)
      } else {
        // Ortho: distance doesn't change apparent size — fit via the frustum
        // half-height (draw() rebuilds left/right/top/bottom from it) and reset zoom.
        orbit.target.copy(sphere.center)
        cam.userData.orthoHalfHeight = Math.max(sphere.radius * 1.25, 1e-3)
        cam.zoom = 1
      }
    } else {
      const ud = cam.userData as {
        homePos?: THREE.Vector3
        homeTarget?: THREE.Vector3
        homeOrthoHalfHeight?: number
      }
      if (ud.homePos && ud.homeTarget) {
        cam.position.copy(ud.homePos)
        orbit.target.copy(ud.homeTarget)
      }
      if (isOrtho(cam)) {
        cam.zoom = 1
        if (typeof ud.homeOrthoHalfHeight === 'number') {
          cam.userData.orthoHalfHeight = ud.homeOrthoHalfHeight
        }
      }
    }
    // The camera is centered (no peephole crop), so aiming orbit.target at the object
    // already lands it in the middle of the visible box.
    orbit.update()
    scheduleDraw()
  }

  function scheduleDraw() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }

  /** World bounds of a scene container, preferring WASM's live selection rect. */
  function sceneRectWorld(
    sceneId: string,
    isSel: boolean,
  ): { cx: number; cy: number; w: number; h: number } | null {
    // While a resize handle is being dragged, the live preview bounds win so the 3D
    // reframes with the box in real time (document bounds only update on commit).
    const rp = scene3dResizePreview.value
    if (rp && rp.sceneId === sceneId) {
      const b = rp.bounds
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h }
    }
    const wsRenderer = useWorkspaceStore.getState().renderer
    const rect = isSel ? (wsRenderer?.getSelectionRect([sceneId]) ?? null) : null
    if (rect && rect.width > 0 && rect.height > 0) {
      return { cx: rect.center.x, cy: rect.center.y, w: rect.width, h: rect.height }
    }
    const node = getNode(sceneId) as
      | { x?: number; y?: number; width?: number; height?: number }
      | undefined
    if (node && typeof node.x === 'number' && typeof node.width === 'number' && node.width > 0) {
      const w = node.width
      const h = node.height ?? w
      // Document bounds only update on commit, so add the live move-drag delta for
      // the selected scene to track the pointer in real time.
      const md = isSel ? movePreviewWorldDelta.value : { x: 0, y: 0 }
      return { cx: node.x + md.x + w / 2, cy: (node.y ?? 0) + md.y + h / 2, w, h }
    }
    return null
  }

  function draw() {
    const renderer = rendererRef.current
    if (!renderer) return
    const vp = viewport.value ?? { panX: 0, panY: 0, zoom: 1 }
    const cssH = canvasSizeRef.current.height
    const selId = selectedSceneId()
    const editingId = editingIdRef.current
    const focusedId = scene3dProxy.focusedObjectId

    // Full-canvas clear to transparent (scissor off so it covers the whole buffer).
    // Re-assert the clear colour every frame: rendering a scene whose `scene.background`
    // is a Color (the edit backdrop) leaves three's GL clear colour set to that colour,
    // so without this reset the next full-canvas clear would repaint the ENTIRE overlay
    // with the backdrop — the edit backdrop "leaking" past its box to the whole screen.
    renderer.setScissorTest(false)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.setScissorTest(true)
    const cssW = canvasSizeRef.current.width
    const focused = editingId != null && editPlacement.value === 'focus'
    let selRect: ScreenRect | null = null
    let didBake = false

    // The canvas viewport in document coords — drives viewport-clipped baking (render only
    // a zoomed-in scene's on-screen slice at native resolution).
    const vtl = screenToWorld(vp, 0, 0)
    const vbr = screenToWorld(vp, cssW, cssH)
    const visibleWorld = { left: vtl.x, top: vtl.y, right: vbr.x, bottom: vbr.y }

    for (const [sceneId, sceneSnap] of scene3dProxy.scenes) {
      const doc = sceneSnap as Scene3DDocument
      const isSel = sceneId === selId
      const isEditing = sceneId === editingId

      // The edited scene in focus mode renders into a fixed centred region (decoupled
      // from its placed box); everything else uses the box's on-screen rect.
      let screen: ScreenRect | null = null
      if (isEditing && focused) {
        // Focus FILLS the central canvas hole (between the panels) edge-to-edge and
        // resizes with it — never spilling onto the rails/timeline (the panels paint
        // above the canvas). No inset, no dim: the hole IS the scene.
        screen = focusViewportRect.value ?? { x: 0, y: 0, w: cssW, h: cssH }
      } else {
        const world = sceneRectWorld(sceneId, isSel)
        if (world) {
          const tl = worldToScreen(vp, world.cx - world.w / 2, world.cy - world.h / 2)
          const sw = world.w * vp.zoom
          const sh = world.h * vp.zoom
          if (sw >= 1 && sh >= 1) screen = { x: tl.x, y: tl.y, w: sw, h: sh }
        }
      }
      if (!screen) continue
      if (isSel || isEditing) selRect = screen

      // Path 1: composite a PLACED (non-editing) scene INTO Skia in z-order via its node's
      // image fill, and skip the overlay for it — a 2D shape above the node now occludes
      // the 3D, and it exports. The edited scene keeps the live overlay (gizmos, backdrop,
      // orbit). Flag-gated (window.__scene3dBake) while it's verified against a real render
      // target; off ⇒ the overlay path below runs for every scene as before.
      // A PLACED scene composites into Skia in z-order → skip the overlay entirely.
      if (isBakeEnabled() && !isEditing) {
        // Bake at the resolution the current zoom needs (crisp when zoomed in), not the
        // node's doc size — a rendered scene is raster, so this is how it matches vector
        // sharpness at any zoom.
        if (bakeSceneToNode(sceneId, doc, vp.zoom, visibleWorld)) {
          didBake = true
          continue
        }
      }

      const inst = syncedInstance(sceneId, doc, renderer)
      // While the gizmo owns the focused object's transform, don't fight it.
      const skipTransformFor = isEditing ? focusedId : null
      applyDocToInstance(inst, doc, skipTransformFor)

      // Frustums for the cameras you're NOT looking through — editor chrome, so only
      // while this scene is edited (never in the composited/preview render).
      syncCameraHelpers(inst, doc, {
        visible: isEditing,
        aspect: screen.w / screen.h,
        selectedCameraId: scene3dProxy.selectedCameraId,
      })

      // three multiplies viewport/scissor by pixelRatio internally — pass CSS/logical px.
      const glX = screen.x
      const glY = cssH - (screen.y + screen.h)

      // LIVE EDIT (in-place, not focus): composite the meshes into Skia mirroring the live
      // overlay camera/objects, so the 3D stays STACKED with the 2D while you orbit/drag —
      // then draw ONLY the edit chrome (gizmo + frustums) on the overlay above it.
      // The backdrop is a SCENE parameter, so it applies wherever the meshes actually
      // render — the bake while live-editing, the overlay otherwise. A placed scene stays
      // transparent so it composites over the canvas.
      const backdrop = isEditing ? (doc.background ?? SCENE3D_EDIT_BACKDROP) : null

      const liveEdit = isEditing && isBakeEnabled() && isLiveEditEnabled() && !focused
      // Only hand the meshes to the bake if the bake actually SUCCEEDED. It can fail for
      // ordinary reasons (no `_update_image_from_texture` in the loaded wasm, an FBO that
      // won't allocate), and hiding them regardless would leave the scene nowhere at all:
      // not in Skia, not on the overlay — an empty box with only the gizmo. On failure we
      // fall through to the overlay, exactly like the placed path above.
      const bakedEdit = liveEdit && bakeEditingScene(sceneId, doc, inst, vp.zoom, backdrop)
      if (bakedEdit) {
        didBake = true
        const restore: boolean[] = []
        for (const o of inst.objects.values()) {
          restore.push(o.visible)
          o.visible = false
        }
        renderSceneIntoBox(renderer, inst, glX, glY, screen.w, screen.h, null)
        let i = 0
        for (const o of inst.objects.values()) o.visible = restore[i++]
      } else {
        // Classic full overlay (focus mode, bake/live-edit off, or a bake that failed).
        // Clear any stale baked fill so Skia doesn't draw it under the overlay.
        if (isEditing && isBakeEnabled()) unbakeNodeFill(sceneId)
        renderSceneIntoBox(renderer, inst, glX, glY, screen.w, screen.h, backdrop)
      }
    }

    // Free bake resources for scenes that were deleted (no longer in the proxy).
    reconcileBakes(new Set(scene3dProxy.scenes.keys()))

    // A baked scene lives in Skia's document, so ask Skia to composite the fresh fill.
    if (didBake) useWorkspaceStore.getState().renderer?.requestRenderFrame()

    selRectRef.current = selRect
    positionEditSurface(selRect, editingId != null)
    // Locator + resize are in-place affordances: focus centres the scene (no off-screen)
    // and resizes the render region, not the placed box — so hide them while focused.
    positionOffscreenLocator(selRect, editingId != null && !focused)
    positionResizeBox(selRect, editingId != null && !focused)
  }

  function positionEditSurface(rect: ScreenRect | null, editing: boolean) {
    const surface = editSurfaceRef.current
    if (!surface) return
    if (rect && editing) {
      surface.style.display = 'block'
      surface.style.left = `${rect.x}px`
      surface.style.top = `${rect.y}px`
      surface.style.width = `${rect.w}px`
      surface.style.height = `${rect.h}px`
    } else {
      surface.style.display = 'none'
    }
  }

  /** Show a violet edge chip pointing at the edited scene when its box is fully
   *  off-screen (panned away). Positioned/rotated imperatively; click = recenter. */
  function positionOffscreenLocator(rect: ScreenRect | null, editing: boolean) {
    const btn = locatorRef.current
    if (!btn) return
    const cw = canvasSizeRef.current.width
    const ch = canvasSizeRef.current.height
    const onScreen =
      rect != null && rect.x + rect.w > 0 && rect.x < cw && rect.y + rect.h > 0 && rect.y < ch
    if (!editing || !rect || onScreen) {
      btn.style.display = 'none'
      return
    }
    const scx = rect.x + rect.w / 2
    const scy = rect.y + rect.h / 2
    const pad = 20
    const px = Math.max(pad, Math.min(cw - pad, scx))
    const py = Math.max(pad, Math.min(ch - pad, scy))
    const angle = (Math.atan2(scy - py, scx - px) * 180) / Math.PI
    btn.style.display = 'flex'
    btn.style.left = `${px - 14}px`
    btn.style.top = `${py - 14}px`
    btn.style.transform = `rotate(${angle}deg)`
  }

  function positionResizeBox(rect: ScreenRect | null, editing: boolean) {
    const box = resizeBoxRef.current
    if (!box) return
    if (rect && editing) {
      box.style.display = 'block'
      box.style.left = `${rect.x}px`
      box.style.top = `${rect.y}px`
      box.style.width = `${rect.w}px`
      box.style.height = `${rect.h}px`
    } else {
      box.style.display = 'none'
    }
  }


  /** Pointer client coords → world, via the overlay canvas origin + current viewport. */
  function pointerToWorld(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const vp = viewport.value
    const canvas = canvasRef.current
    if (!vp || !canvas) return null
    const r = canvas.getBoundingClientRect()
    return screenToWorld(vp, e.clientX - r.left, e.clientY - r.top)
  }

  function onResizeMove(e: PointerEvent) {
    const st = resizeStateRef.current
    const world = pointerToWorld(e)
    if (!st || !world) return
    const dx = world.x - st.startWorld.x
    const dy = world.y - st.startWorld.y
    scene3dResizePreview.value = {
      sceneId: st.sceneId,
      bounds: applyResize(st.handle, st.startBounds, dx, dy),
    }
  }

  function onResizeUp() {
    const st = resizeStateRef.current
    const preview = scene3dResizePreview.value
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeUp)
    resizeStateRef.current = null
    scene3dResizePreview.value = null
    // Persist the final bounds as one undoable mod-obj; the overlay then reads them
    // back from the document (preview cleared above).
    if (st && preview) void commitSceneBounds(st.sceneId, preview.bounds)
  }

  function startResize(e: ReactPointerEvent, handle: ResizeHandle) {
    e.preventDefault()
    e.stopPropagation()
    const sceneId = editingIdRef.current
    const start = pointerToWorld(e)
    const box = sceneId ? sceneRectWorld(sceneId, true) : null
    if (!sceneId || !start || !box) return
    resizeStateRef.current = {
      handle,
      sceneId,
      startWorld: start,
      startBounds: { x: box.cx - box.w / 2, y: box.cy - box.h / 2, w: box.w, h: box.h },
    }
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeUp)
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />

      {/* Full-viewport edit frame — a viewport-anchored accent border shown while any
          3D scene is being edited. Independent of the scene box's position, so it stays
          a clear "you are in 3D-edit" signal even when the box is panned off-screen. */}
      {editingSceneId && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 6,
            boxShadow: 'inset 0 0 0 2px rgba(139, 92, 246, 0.9)',
          }}
        />
      )}

      {/* Pointer-capture surface for the gizmo/orbit/raycast, sized to the editing
          scene's viewport (positioned imperatively in draw()). */}
      <div
        ref={editSurfaceRef}
        style={{
          position: 'absolute',
          display: 'none',
          touchAction: 'none',
          pointerEvents: editingSceneId ? 'all' : 'none',
          zIndex: 6,
          cursor: 'grab',
        }}
      />

      {/* Resize handles — 8 grips on the edited scene's box (positioned imperatively in
          draw()). The box is pointer-transparent so orbit/gizmo still work inside; only
          the grips capture, dragging the underlying rect (live preview + commit). */}
      <div
        ref={resizeBoxRef}
        style={{ position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: 7 }}
      >
        {RESIZE_HANDLES.map((hd) => (
          <div
            key={hd.h}
            onPointerDown={(e) => startResize(e, hd.h)}
            style={{
              position: 'absolute',
              width: 10,
              height: 10,
              borderRadius: 2,
              background: '#fff',
              border: '1.5px solid rgba(139, 92, 246, 0.95)',
              pointerEvents: 'auto',
              cursor: hd.cursor,
              ...hd.pos,
            }}
          />
        ))}
      </div>

      {/* Off-screen locator — a violet edge chip pointing at the edited scene when it's
          panned out of view; click recenters. Positioned/rotated imperatively in draw(). */}
      <button
        ref={locatorRef}
        type="button"
        title="Recenter scene"
        aria-label="Recenter scene (off-screen)"
        onClick={() => {
          const id = editingIdRef.current
          if (id) recenterOnScene(id)
        }}
        style={{
          position: 'absolute',
          display: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(139, 92, 246, 0.95)',
          color: '#fff',
          cursor: 'pointer',
          boxShadow: '0 1px 4px rgba(0,0,0,.25)',
          pointerEvents: 'auto',
          zIndex: 7,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </>
  )
}
