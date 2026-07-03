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
  setFocusedObject,
  patchObjectTransformLocal,
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
  pickObject,
} from './three-scene'
import { isOrtho, isPersp, orthoFrustum } from './camera3d'
import { recenterOnScene } from './scene3d-recenter'
import { editPlacement, effectiveDim, exitFocus, focusRegion, focusDim, reveal } from './scene3d-focus'
import {
  scene3dResizePreview,
  applyResize,
  commitSceneBounds,
  type ResizeHandle,
  type Bounds,
} from './scene3d-resize'
import { commitObjectTransform } from './scene3d-commit'
import { resolveScene3dPointerDown } from './scene3d-pointer'
import { useScene3dEditing } from './use-scene3d-editing'

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
  const wantOrtho = activeCamera(doc).projection === 'orthographic'
  let inst = getInstance(sceneId)
  if (inst && isOrtho(inst.camera) !== wantOrtho) {
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
  const focusScrimRef = useRef<HTMLDivElement>(null)
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
      void focusDim.value // scrim strength
      void reveal.value // sampling-worktree reveal
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
    if (!editingSceneId) setFocusedObject(null)
  }, [editingSceneId])

  // Focus mode is opt-in per edit session: entering (or switching) a scene always
  // starts in-place, so a stale "focus" from a previous session can't carry over.
  useEffect(() => {
    exitFocus()
  }, [editingSceneId])

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

    const tc = new TransformControls(inst.camera, surface)
    tc.setMode(gizmoMode)
    tc.addEventListener('change', scheduleDraw)
    tc.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value
      orbit.enabled = !dragging
      // Live edits run through the local preview (smooth). On drag end, persist
      // the final transform as ONE undoable mod-obj; scene3d-sync re-seeds the proxy.
      const objId = scene3dProxy.focusedObjectId
      const obj = objId ? inst.objects.get(objId) : null
      if (!dragging && objId && obj) void commitObjectTransform(sceneId, objId, readTransformFromObject(obj))
    })
    tc.addEventListener('objectChange', () => {
      const objId = scene3dProxy.focusedObjectId
      const obj = objId ? inst.objects.get(objId) : null
      if (objId && obj) patchObjectTransformLocal(sceneId, objId, readTransformFromObject(obj))
    })
    inst.scene.add(tc.getHelper())
    gizmoRef.current = tc

    // Attach the gizmo to the focused object.
    const focusObj = snap.focusedObjectId ? inst.objects.get(snap.focusedObjectId) : undefined
    if (focusObj) tc.attach(focusObj)

    // Pointer-down resolution runs through the mode-guarded resolver (the click
    // analogue of dispatchKey): gizmo handle → TransformControls; object → focus;
    // empty → orbit. Centralised + guarded so it can't drift from the machine mode.
    const onPick = (e: PointerEvent) => {
      if (e.button !== 0) return // left button only; right/middle drive pan/dolly
      const r = surface.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1
      const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1)
      resolveScene3dPointerDown(ndcX, ndcY, {
        actor,
        instance: inst,
        gizmoActive: tc.axis != null,
        pick: pickObject,
      })
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
      surface.removeEventListener('pointerdown', onPick)
      surface.removeEventListener('wheel', onWheel)
      inst.scene.remove(tc.getHelper())
      tc.detach()
      tc.dispose()
      orbit.dispose()
      gizmoRef.current = null
      orbitRef.current = null
      scheduleDraw()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSceneId, snap.focusedObjectId, editingProjection])

  // Gizmo sub-tool (Move/Rotate/Scale) is machine state — apply it without
  // tearing down the controls.
  useEffect(() => {
    gizmoRef.current?.setMode(gizmoMode)
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

    for (const [sceneId, sceneSnap] of scene3dProxy.scenes) {
      const doc = sceneSnap as Scene3DDocument
      const isSel = sceneId === selId
      const isEditing = sceneId === editingId

      // The edited scene in focus mode renders into a fixed centred region (decoupled
      // from its placed box); everything else uses the box's on-screen rect.
      let screen: ScreenRect | null = null
      if (isEditing && focused) {
        screen = focusRegion(cssW, cssH)
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

      const inst = syncedInstance(sceneId, doc, renderer)
      // While the gizmo owns the focused object's transform, don't fight it.
      const skipTransformFor = isEditing ? focusedId : null
      applyDocToInstance(inst, doc, skipTransformFor)

      // Edit-only backdrop fills the box while editing so the scene reads apart from the
      // document; every other scene stays transparent and composites over it. Drawn as an
      // explicit scissored clear in renderSceneIntoBox (never scene.background).
      const backdrop = isEditing ? (doc.background ?? SCENE3D_EDIT_BACKDROP) : null

      // three multiplies viewport/scissor by pixelRatio internally — pass CSS/logical px.
      const glX = screen.x
      const glY = cssH - (screen.y + screen.h)
      renderSceneIntoBox(renderer, inst, glX, glY, screen.w, screen.h, backdrop)
    }

    selRectRef.current = selRect
    positionEditSurface(selRect, editingId != null)
    // Locator + resize are in-place affordances: focus centres the scene (no off-screen)
    // and resizes the render region, not the placed box — so hide them while focused.
    positionOffscreenLocator(selRect, editingId != null && !focused)
    positionResizeBox(selRect, editingId != null && !focused)
    positionFocusScrim(selRect, focused)
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

  /** Dim everything outside the focus region via a huge box-shadow spread from a
   *  transparent rect over the region (the "hole"). Opacity tracks the focus dim. */
  function positionFocusScrim(rect: ScreenRect | null, focused: boolean) {
    const scrim = focusScrimRef.current
    if (!scrim) return
    if (focused && rect) {
      scrim.style.display = 'block'
      scrim.style.left = `${rect.x}px`
      scrim.style.top = `${rect.y}px`
      scrim.style.width = `${rect.w}px`
      scrim.style.height = `${rect.h}px`
      scrim.style.boxShadow = `0 0 0 9999px rgba(15, 17, 23, ${effectiveDim()})`
    } else {
      scrim.style.display = 'none'
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
      {/* Focus-mode scrim — dims everything outside the focus region (below the 3D
          canvas so the region itself stays clear). Positioned imperatively in draw(). */}
      <div
        ref={focusScrimRef}
        aria-hidden
        style={{ position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: 4, borderRadius: 8 }}
      />

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
