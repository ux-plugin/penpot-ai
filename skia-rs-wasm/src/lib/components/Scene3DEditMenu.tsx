/**
 * Scene3DEditMenu — the contextual 3D toolbar above the bottom tool strip, mirroring
 * how the pen's edit flyout appears while `pathEditing`.
 *
 * Icon-first (to match the main toolbar): a slim violet mode chip + icon buttons with
 * tooltips. Groups: view (recenter · focus) │ add (a single + with a Cube/Sphere/Plane
 * flyout) │ gizmo (move · rotate · scale, once an object is focused) │ camera (a chip
 * showing the active camera's name, opening the camera list popover) │ Done.
 *
 * Renders nothing unless a 3D scene is selected or being edited.
 */

import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { Box, Circle, Square, Crosshair, Maximize2, Minimize2, Move3d, Rotate3d, Scale3d, Plus, Video, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { docProxy, getNode } from '../renderer/store/doc-proxy'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { editPlacement, toggleFocus } from '../renderer/three/scene3d-focus'
import {
  scene3dProxy,
  defaultObject,
  setFocusedObject,
  setSelectedCamera,
  activeCamera,
  nextCameraName,
  getInstance,
  type Scene3DDocument,
} from '../renderer/three/scene3d-store'
import { commitAddObject, commitAddCamera } from '../renderer/three/scene3d-commit'
import { readCameraPose } from '../renderer/three/three-scene'
import { recenterOnScene } from '../renderer/three/scene3d-recenter'
import { useScene3dEditing } from '../renderer/three/use-scene3d-editing'
import { Scene3DCameraPopover } from './Scene3DCameraPopover'
import type { Scene3DGizmoMode } from '../renderer/machine/canvas-machine'

const ADD_PRIMS = [
  { ref: 'cube', label: 'Cube', Icon: Box },
  { ref: 'sphere', label: 'Sphere', Icon: Circle },
  { ref: 'plane', label: 'Plane', Icon: Square },
] as const

const GIZMOS: { mode: Scene3DGizmoMode; label: string; key: string; Icon: typeof Move3d }[] = [
  { mode: 'translate', label: 'Move', key: 'G', Icon: Move3d },
  { mode: 'rotate', label: 'Rotate', key: 'R', Icon: Rotate3d },
  { mode: 'scale', label: 'Scale', key: 'S', Icon: Scale3d },
]

type Flyout = 'add' | 'camera' | null

export function Scene3DEditMenu() {
  const { editingSceneId, gizmoMode, enter, exit, setGizmo } = useScene3dEditing()
  const sceneSnap = useSnapshot(scene3dProxy)
  const docSnap = useSnapshot(docProxy)
  const placement = useSignalCoalesced(editPlacement)
  const [flyout, setFlyout] = useState<Flyout>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close any open flyout on an outside click.
  useEffect(() => {
    if (!flyout) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setFlyout(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [flyout])

  const selId =
    docSnap.selectedIds.size === 1 ? (docSnap.selectedIds.values().next().value as string) : null
  const selectedScene = selId && sceneSnap.scenes.has(selId) ? selId : null

  if (!editingSceneId && !selectedScene) return null

  // Selected (not editing): offer to enter edit, focused on the first object.
  if (!editingSceneId) {
    const scene = selectedScene!
    return (
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/80 bg-white px-2 py-1.5 shadow-md">
        <button
          type="button"
          onClick={() => enter(scene, null)}
          className="flex items-center gap-1.5 rounded-full bg-indigo-500 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-600"
        >
          <Box className="size-3.5" /> Edit in 3D
        </button>
      </div>
    )
  }

  const focusedId = sceneSnap.focusedObjectId
  const selectedCameraId = sceneSnap.selectedCameraId
  // The gizmo works on the focused object OR a selected camera (grab it in space); scale
  // is meaningless for a camera, so it's dropped when one is selected (a leftover scale
  // mode reads as move).
  const gizmoTarget = focusedId ?? selectedCameraId
  const activeGizmo = selectedCameraId && gizmoMode === 'scale' ? 'translate' : gizmoMode
  const editingDoc = sceneSnap.scenes.get(editingSceneId) as Scene3DDocument | undefined
  const cameraName = editingDoc ? activeCamera(editingDoc).name : 'Camera'
  const sceneName = (getNode(editingSceneId) as { name?: string } | undefined)?.name ?? '3D scene'

  const addObject = (ref: (typeof ADD_PRIMS)[number]['ref']) => {
    const id = crypto.randomUUID()
    setFlyout(null)
    void commitAddObject(editingSceneId, defaultObject(id, { kind: 'primitive', ref })).then(() =>
      setFocusedObject(id),
    )
  }

  // A camera is one of the things a scene is made of, so it's added from the same `+` as
  // the shapes. It starts at the view you're looking through and is selected (NOT looked
  // through) — so its frustum is there to grab and its props open in the right panel.
  const addCamera = () => {
    setFlyout(null)
    if (!editingDoc) return
    const live = getInstance(editingSceneId)?.camera
    const transform3d = live ? readCameraPose(live) : undefined
    void commitAddCamera(editingSceneId, {
      name: nextCameraName(editingDoc),
      transform3d,
    }).then((id) => {
      if (id) setSelectedCamera(id)
    })
  }

  const iconBtn =
    'grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted transition-colors'
  const sep = 'mx-1 h-5 w-px self-center bg-border'

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto relative inline-flex items-stretch rounded-xl border border-border/80 bg-white shadow-md"
    >
      {/* Mode chip — a solid-violet status cluster so "you are editing" reads as a mode. */}
      <div className="flex items-center gap-2 rounded-l-xl bg-violet-500 px-3.5 text-xs font-medium text-white">
        <span className="size-1.5 rounded-full bg-white/90" aria-hidden />
        <Box className="size-4" aria-hidden />
        {sceneName}
      </div>

      <div className="flex items-stretch px-1.5 py-1">
        {/* View */}
        <button
          type="button"
          title="Recenter scene"
          aria-label="Recenter scene"
          onClick={() => recenterOnScene(editingSceneId)}
          className={iconBtn}
        >
          <Crosshair className="size-4" />
        </button>
        <button
          type="button"
          title={placement === 'focus' ? 'Exit focus' : 'Focus (maximize)'}
          aria-label={placement === 'focus' ? 'Exit focus' : 'Focus'}
          onClick={toggleFocus}
          className={cn(iconBtn, placement === 'focus' && 'bg-violet-500/15 text-violet-700')}
        >
          {placement === 'focus' ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>

        <span className={sep} />

        {/* Add — everything a scene is made of: the shapes AND a camera. */}
        <span className="relative flex items-center">
          <button
            type="button"
            title="Add"
            aria-label="Add"
            aria-expanded={flyout === 'add'}
            onClick={() => setFlyout((f) => (f === 'add' ? null : 'add'))}
            className={cn(iconBtn, flyout === 'add' && 'bg-muted text-foreground')}
          >
            <Plus className="size-5" />
          </button>
          {flyout === 'add' && (
            <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-xl border border-border/80 bg-white p-1 shadow-md">
              {ADD_PRIMS.map((p) => (
                <button
                  key={p.ref}
                  type="button"
                  onClick={() => addObject(p.ref)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                >
                  <p.Icon className="size-4 shrink-0" /> {p.label}
                </button>
              ))}
              <span className="my-1 block h-px bg-border" />
              <button
                type="button"
                onClick={addCamera}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
              >
                <Video className="size-4 shrink-0" /> Camera
              </button>
            </div>
          )}
        </span>

        {/* Gizmo — once an object is focused or a camera is selected (no scale on cameras). */}
        {gizmoTarget && (
          <>
            <span className={sep} />
            {GIZMOS.filter((g) => !(selectedCameraId && g.mode === 'scale')).map((g) => (
              <button
                key={g.mode}
                type="button"
                title={`${g.label} (${g.key})`}
                aria-label={g.label}
                onClick={() => setGizmo(g.mode)}
                className={cn(iconBtn, activeGizmo === g.mode && 'bg-violet-500/15 text-violet-700')}
              >
                <g.Icon className="size-4" />
              </button>
            ))}
          </>
        )}

        <span className={sep} />

        {/* Camera — chip showing the active (look-through) camera; opens the list popover. */}
        <span className="relative flex items-center">
          <button
            type="button"
            title="Cameras"
            aria-expanded={flyout === 'camera'}
            onClick={() => setFlyout((f) => (f === 'camera' ? null : 'camera'))}
            className={cn(
              'my-1 flex items-center gap-1.5 rounded-md border border-border px-2 text-xs',
              flyout === 'camera' ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted',
            )}
          >
            <Video className="size-4 text-violet-600" />
            <span className="max-w-[6rem] truncate">{cameraName}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
          {flyout === 'camera' && (
            <div className="absolute bottom-full right-0 mb-2">
              <Scene3DCameraPopover sceneId={editingSceneId} />
            </div>
          )}
        </span>

        <span className={sep} />

        <button
          type="button"
          onClick={exit}
          className="my-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Done
        </button>
      </div>
    </div>
  )
}
