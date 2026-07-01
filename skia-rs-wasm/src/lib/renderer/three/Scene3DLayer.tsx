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

import { useEffect, useRef } from 'react'
import { useSnapshot, subscribe } from 'valtio'
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { effect } from '@preact/signals-core'
import { viewport, movePreviewWorldDelta } from '../signals/pointer'
import { worldToScreen } from '../viewport'
import { useWorkspaceStore } from '../store/workspace-store'
import { docProxy, getNode } from '../store/doc-proxy'
import {
  scene3dProxy,
  getInstance,
  setInstance,
  isScene3D,
  setFocusedObject,
  patchObjectTransformLocal,
  dollyBounds,
  frameDistanceForRadius,
  sceneFrameViewRequest,
  SCENE3D_EDIT_BACKDROP,
  type Scene3DDocument,
} from './scene3d-store'
import {
  buildSceneInstance,
  applyDocToInstance,
  readTransformFromObject,
  pickObject,
} from './three-scene'
import { commitObjectTransform } from './scene3d-commit'
import { resolveScene3dPointerDown } from './scene3d-pointer'
import { useScene3dEditing } from './use-scene3d-editing'

interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
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

  // Focus is meaningful only inside edit mode; clear it whenever 3D-edit ends so
  // keyboard/command exits (Esc / V, via runCommand) match the menu's exit(), which
  // also clears focus. Keeps the "no focus outside edit" invariant in one place.
  useEffect(() => {
    if (!editingSceneId) setFocusedObject(null)
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
    // must not wait a frame — build the instance and its objects eagerly so the
    // gizmo can attach to a just-added object this tick.
    let inst = getInstance(sceneId)
    if (!inst) {
      inst = buildSceneInstance(renderer, doc)
      setInstance(sceneId, inst)
    }
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
    }
    if (camUserData.homeDistance == null) {
      // Capture the home pose once — before any orbit/dolly — so Frame-view's
      // "reset to home" and the dolly clamp stay stable across exit/re-enter.
      camUserData.homeDistance = orbit.getDistance()
      camUserData.homePos = inst.camera.position.clone()
      camUserData.homeTarget = orbit.target.clone()
    }
    const bounds = dollyBounds(camUserData.homeDistance)
    orbit.minDistance = bounds.min
    orbit.maxDistance = bounds.max
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
  }, [editingSceneId, snap.focusedObjectId])

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
      const fit = frameDistanceForRadius(sphere.radius, cam.fov)
      const dist = Math.min(Math.max(fit, orbit.minDistance), orbit.maxDistance)
      const dir = cam.position.clone().sub(orbit.target)
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1)
      dir.normalize()
      orbit.target.copy(sphere.center)
      cam.position.copy(sphere.center).addScaledVector(dir, dist)
    } else {
      const ud = cam.userData as { homePos?: THREE.Vector3; homeTarget?: THREE.Vector3 }
      if (ud.homePos && ud.homeTarget) {
        cam.position.copy(ud.homePos)
        orbit.target.copy(ud.homeTarget)
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

    // Full-canvas clear (scissor stays on for per-scene rendering).
    renderer.setScissorTest(false)
    renderer.clear()
    renderer.setScissorTest(true)
    let selRect: ScreenRect | null = null

    for (const [sceneId, sceneSnap] of scene3dProxy.scenes) {
      const doc = sceneSnap as Scene3DDocument
      const isSel = sceneId === selId
      const world = sceneRectWorld(sceneId, isSel)
      if (!world) continue

      const boxLeftWorld = world.cx - world.w / 2
      const boxTopWorld = world.cy - world.h / 2
      const tl = worldToScreen(vp, boxLeftWorld, boxTopWorld)
      const sw = world.w * vp.zoom
      const sh = world.h * vp.zoom
      if (sw < 1 || sh < 1) continue
      if (isSel || sceneId === editingId) selRect = { x: tl.x, y: tl.y, w: sw, h: sh }

      let inst = getInstance(sceneId)
      if (!inst) {
        inst = buildSceneInstance(renderer, doc)
        setInstance(sceneId, inst)
      }
      // While the gizmo owns the focused object's transform, don't fight it.
      const skipTransformFor = sceneId === editingId ? focusedId : null
      applyDocToInstance(inst, doc, skipTransformFor)

      // Edit-only backdrop: fill the peephole with a solid colour while editing so
      // the scene region reads apart from the document canvas (which otherwise shows
      // through the transparent container). Outside edit mode the scene stays
      // transparent so it composites over the document. (Lighting is unaffected —
      // `scene.background` is purely the visual backdrop, not the IBL environment.)
      if (sceneId === editingId) {
        const hex = doc.background ?? SCENE3D_EDIT_BACKDROP
        if (inst.scene.background instanceof THREE.Color) inst.scene.background.set(hex)
        else inst.scene.background = new THREE.Color(hex)
      } else if (inst.scene.background) {
        inst.scene.background = null
      }

      // Plain centered perspective viewport: the box's full frame IS the camera (not a
      // frustum-extending peephole). The optical axis runs through the box centre and
      // the vertical FOV is fixed, so the effective FOV depends only on the aspect —
      // never on the box's absolute size. Shapes therefore grow naturally toward you on
      // dolly (no shear) and there's no wide-angle edge stretch; resizing reframes like
      // a normal 3D window. Aspect = the box's on-screen aspect (sw/sh); zoom cancels.
      inst.camera.aspect = sw / sh
      inst.camera.clearViewOffset() // also recomputes the projection with the new aspect

      // three multiplies these by pixelRatio internally — pass CSS/logical px.
      const glX = tl.x
      const glY = cssH - (tl.y + sh)
      renderer.setViewport(glX, glY, sw, sh)
      renderer.setScissor(glX, glY, sw, sh)
      renderer.render(inst.scene, inst.camera)
    }

    selRectRef.current = selRect
    positionEditSurface(selRect, editingId != null)
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
    </>
  )
}
