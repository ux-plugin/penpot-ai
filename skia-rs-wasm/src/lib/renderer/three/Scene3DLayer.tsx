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
  type Scene3DDocument,
} from './scene3d-store'
import {
  buildSceneInstance,
  applyDocToInstance,
  readTransformFromObject,
  pickObject,
} from './three-scene'
import { commitObjectTransform } from './scene3d-commit'
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
  const rafRef = useRef(0)
  const selRectRef = useRef<ScreenRect | null>(null)
  // The redraw effect captures a stale draw closure (empty deps), so reading the
  // canvasSize prop / edit state directly would use initial values. Read live
  // values from refs instead.
  const canvasSizeRef = useRef(canvasSize)
  canvasSizeRef.current = canvasSize

  const snap = useSnapshot(scene3dProxy)
  const { editingSceneId, gizmoMode, exit } = useScene3dEditing()
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

    const orbit = new OrbitControls(inst.camera, surface)
    orbit.enableDamping = false
    orbit.enablePan = false
    orbit.addEventListener('change', scheduleDraw)

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

    // Raycast pick: clicking an object's body focuses it; empty space orbits and
    // leaves focus untouched. Skip when the pointer is on a gizmo handle.
    const onPick = (e: PointerEvent) => {
      if (tc.axis) return
      const r = surface.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1
      const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1)
      const hit = pickObject(inst, ndcX, ndcY)
      if (hit) setFocusedObject(hit)
    }
    surface.addEventListener('pointerdown', onPick)
    scheduleDraw()

    return () => {
      surface.removeEventListener('pointerdown', onPick)
      inst.scene.remove(tc.getHelper())
      tc.detach()
      tc.dispose()
      orbit.dispose()
      gizmoRef.current = null
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

      const tl = worldToScreen(vp, world.cx - world.w / 2, world.cy - world.h / 2)
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
      inst.camera.aspect = sw / sh
      inst.camera.updateProjectionMatrix()

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

  // Esc exits edit mode.
  useEffect(() => {
    if (!editingSceneId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingSceneId, exit])

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
