/**
 * Scene3DLayer — the transparent three.js overlay that paints embedded 3D
 * objects on top of the Skia/render-wasm canvas.
 *
 * - One WebGLRenderer, alpha, scissor-test on. Each 3D object renders into its
 *   own sub-viewport, computed from the backing rect's world bounds
 *   (`renderer.getSelectionRect`) and the 2D `viewport` (pan/zoom).
 * - Redraw is on-demand: scheduled on viewport change, model change, or a
 *   gizmo/orbit 'change' event, coalesced to one RAF.
 * - Edit mode attaches TransformControls + OrbitControls to an invisible
 *   "edit surface" div sized to the selected object's sub-viewport, so the
 *   controls' pointer→NDC mapping matches the scissored camera exactly.
 */

import { useEffect, useRef, useState } from 'react'
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
  is3DObject,
  setSelected3D,
  setEditing,
  setTransform3d,
  type Scene3DEntry,
} from './scene3d-store'
import { buildInstance, applyEntryToInstance, readTransformFromInstance } from './three-scene'

type GizmoMode = 'translate' | 'rotate' | 'scale'
interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export function Scene3DLayer({ canvasSize }: { canvasSize: { width: number; height: number } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editSurfaceRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const gizmoRef = useRef<TransformControls | null>(null)
  const rafRef = useRef(0)
  const selRectRef = useRef<ScreenRect | null>(null)
  // The redraw effect captures a stale draw closure (empty deps), so reading the
  // canvasSize prop directly in draw() would use the initial default size and
  // mis-place the Y-flip. Read the live size from this ref instead.
  const canvasSizeRef = useRef(canvasSize)
  canvasSizeRef.current = canvasSize

  const snap = useSnapshot(scene3dProxy)
  const [mode, setMode] = useState<GizmoMode>('translate')

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

  // --- redraw on 2D viewport (pan/zoom) and on model changes ---
  useEffect(() => {
    const disposeVp = effect(() => {
      viewport.value // pan/zoom
      movePreviewWorldDelta.value // live move-drag translation (and reset on commit)
      scheduleDraw()
    })
    const unsub = subscribe(scene3dProxy, scheduleDraw)
    return () => {
      disposeVp()
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- mirror the document selection into the 3D model ---
  useEffect(() => {
    const sync = () => {
      const ids = docProxy.selectedIds
      if (ids.size === 1) {
        const id = ids.values().next().value as string
        setSelected3D(is3DObject(id) ? id : null)
      } else {
        setSelected3D(null)
      }
    }
    sync()
    return subscribe(docProxy.selectedIds, sync)
  }, [])

  // --- attach gizmo + orbit while editing the selected object ---
  useEffect(() => {
    if (!snap.editing || !snap.selectedId) return
    const id = snap.selectedId
    const inst = getInstance(id)
    const surface = editSurfaceRef.current
    if (!inst || !surface) return

    const orbit = new OrbitControls(inst.camera, surface)
    orbit.enableDamping = false
    orbit.enablePan = false
    orbit.addEventListener('change', scheduleDraw)

    const tc = new TransformControls(inst.camera, surface)
    tc.setMode(mode)
    tc.attach(inst.root)
    tc.addEventListener('change', scheduleDraw)
    tc.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !(e as unknown as { value: boolean }).value
    })
    tc.addEventListener('objectChange', () => {
      setTransform3d(id, readTransformFromInstance(inst))
    })
    inst.scene.add(tc.getHelper())
    gizmoRef.current = tc
    scheduleDraw()

    return () => {
      inst.scene.remove(tc.getHelper())
      tc.detach()
      tc.dispose()
      orbit.dispose()
      gizmoRef.current = null
      scheduleDraw()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.editing, snap.selectedId, mode])

  function scheduleDraw() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }

  function draw() {
    const renderer = rendererRef.current
    if (!renderer) return
    // viewport signal is null until a document loads / first interaction; use
    // the app's default view so 3D objects render immediately on creation.
    const vp = viewport.value ?? { panX: 0, panY: 0, zoom: 1 }
    const wsRenderer = useWorkspaceStore.getState().renderer
    const cssH = canvasSizeRef.current.height
    const editing = scene3dProxy.editing
    const selectedId = scene3dProxy.selectedId

    // Full-canvas clear: scissor test stays on for per-object rendering, but a
    // scissored clear() would only clear the last object's box and leave ghost
    // trails of previous frames.
    renderer.setScissorTest(false)
    renderer.clear()
    renderer.setScissorTest(true)
    let selRect: ScreenRect | null = null

    for (const entry of scene3dProxy.objects.values()) {
      const e = entry as Scene3DEntry
      const isSel = e.shapeId === selectedId
      // The WASM selection rect already includes live move/resize modifiers, so
      // prefer it for the selected object (and only call WASM for that one).
      let rect = isSel ? (wsRenderer?.getSelectionRect([e.shapeId]) ?? null) : null
      const fromWasm = rect != null && rect.width > 0 && rect.height > 0
      if (!fromWasm) {
        const node = getNode(e.shapeId) as
          | { x?: number; y?: number; width?: number; height?: number }
          | undefined
        if (node && typeof node.x === 'number' && typeof node.width === 'number' && node.width > 0) {
          const w = node.width
          const h = node.height ?? w
          // Document bounds only update on commit, so add the live move-drag
          // delta for the selected object to track the pointer in real time.
          const md = isSel ? movePreviewWorldDelta.value : { x: 0, y: 0 }
          rect = {
            width: w,
            height: h,
            center: { x: node.x + md.x + w / 2, y: (node.y ?? 0) + md.y + h / 2 },
            transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          }
        } else {
          rect = null
        }
      }
      if (!rect) continue
      const tl = worldToScreen(vp, rect.center.x - rect.width / 2, rect.center.y - rect.height / 2)
      const sw = rect.width * vp.zoom
      const sh = rect.height * vp.zoom
      if (sw < 1 || sh < 1) continue

      if (isSel) selRect = { x: tl.x, y: tl.y, w: sw, h: sh }

      let inst = getInstance(e.shapeId)
      if (!inst) {
        inst = buildInstance(renderer, e)
        setInstance(e.shapeId, inst)
      }
      // While the gizmo owns the selected object's transform, don't fight it.
      applyEntryToInstance(inst, e, !(editing && isSel))
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
    positionOverlays(selRect, editing)
  }

  function positionOverlays(rect: ScreenRect | null, editing: boolean) {
    const toolbar = toolbarRef.current
    if (toolbar) {
      if (rect) {
        toolbar.style.display = 'flex'
        toolbar.style.left = `${rect.x + rect.w / 2}px`
        toolbar.style.top = `${rect.y - 10}px`
      } else {
        toolbar.style.display = 'none'
      }
    }
    const surface = editSurfaceRef.current
    if (surface) {
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
  }

  // Esc exits edit mode.
  useEffect(() => {
    if (!snap.editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap.editing])

  const hasSelection = snap.selectedId != null
  const editing = snap.editing

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

      {/* Pointer-capture surface for the gizmo/orbit, sized to the selected
          object's sub-viewport (positioned imperatively in draw()). */}
      <div
        ref={editSurfaceRef}
        style={{
          position: 'absolute',
          display: 'none',
          touchAction: 'none',
          pointerEvents: editing ? 'all' : 'none',
          zIndex: 6,
          cursor: 'grab',
        }}
      />

      {/* Floating contextual toolbar, shown when a 3D object is selected. */}
      <div
        ref={toolbarRef}
        style={{ position: 'absolute', display: 'none', zIndex: 7, transform: 'translate(-50%,-100%)' }}
      >
        {hasSelection && (
          <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-white p-1 shadow-md dark:bg-neutral-800">
            {editing ? (
              <>
                {(['translate', 'rotate', 'scale'] as GizmoMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m)
                      gizmoRef.current?.setMode(m)
                      scheduleDraw()
                    }}
                    className={
                      'rounded-md px-2 py-1 text-xs capitalize ' +
                      (mode === m
                        ? 'bg-indigo-500 text-white'
                        : 'text-muted-foreground hover:bg-muted')
                    }
                  >
                    {m === 'translate' ? 'Move' : m}
                  </button>
                ))}
                <span className="mx-1 h-4 w-px bg-border" />
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  Done
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-600"
              >
                Edit in 3D
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
