/**
 * Scene3DEditMenu — the contextual 3D menu that sits above the bottom tool strip,
 * mirroring how the pen's edit flyout appears while `pathEditing`.
 *
 * Driven by the `scene3dEditing` canvasMachine state:
 *  - a 3D scene is selected (not editing) → an "Edit in 3D" entry button
 *  - editing                              → add primitives, gizmo sub-tools
 *                                           (once an object is focused), and Done
 *
 * Renders nothing when neither applies.
 */

import { useSnapshot } from 'valtio'
import { Box, Crosshair, Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { docProxy, getNode } from '../renderer/store/doc-proxy'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { editPlacement, toggleFocus } from '../renderer/three/scene3d-focus'
import {
  scene3dProxy,
  defaultObject,
  setFocusedObject,
  activeCamera,
  type CameraProjection,
  type Scene3DDocument,
} from '../renderer/three/scene3d-store'
import { commitActiveCameraPatch, commitAddObject } from '../renderer/three/scene3d-commit'
import { recenterOnScene } from '../renderer/three/scene3d-recenter'
import { useScene3dEditing } from '../renderer/three/use-scene3d-editing'
import type { Scene3DGizmoMode } from '../renderer/machine/canvas-machine'

const ADD_PRIMS = [
  { ref: 'cube', label: 'Cube' },
  { ref: 'sphere', label: 'Sphere' },
  { ref: 'plane', label: 'Plane' },
] as const

const GIZMOS: { mode: Scene3DGizmoMode; label: string }[] = [
  { mode: 'translate', label: 'Move' },
  { mode: 'rotate', label: 'Rotate' },
  { mode: 'scale', label: 'Scale' },
]

const PROJECTIONS: { key: CameraProjection; label: string }[] = [
  { key: 'perspective', label: 'Persp' },
  { key: 'orthographic', label: 'Ortho' },
]

export function Scene3DEditMenu() {
  const { editingSceneId, gizmoMode, enter, exit, setGizmo } = useScene3dEditing()
  const sceneSnap = useSnapshot(scene3dProxy)
  const docSnap = useSnapshot(docProxy)
  const placement = useSignalCoalesced(editPlacement)

  const selId =
    docSnap.selectedIds.size === 1 ? (docSnap.selectedIds.values().next().value as string) : null
  const selectedScene = selId && sceneSnap.scenes.has(selId) ? selId : null

  if (!editingSceneId && !selectedScene) return null

  const shell =
    'pointer-events-auto flex items-center gap-1 rounded-full border border-border/80 bg-white px-2 py-1.5 shadow-md'

  // Selected (not editing): offer to enter edit, focused on the first object.
  if (!editingSceneId) {
    const scene = selectedScene!
    return (
      <div className={shell}>
        <button
          type="button"
          onClick={() => enter(scene, sceneSnap.scenes.get(scene)?.objects[0]?.id ?? null)}
          className="flex items-center gap-1.5 rounded-full bg-indigo-500 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-600"
        >
          <Box className="size-3.5" /> Edit in 3D
        </button>
      </div>
    )
  }

  const focusedId = sceneSnap.focusedObjectId
  const editingDoc = sceneSnap.scenes.get(editingSceneId) as Scene3DDocument | undefined
  const projection = editingDoc ? activeCamera(editingDoc).projection : 'perspective'
  const sceneName = (getNode(editingSceneId) as { name?: string } | undefined)?.name ?? '3D scene'
  const addObject = (ref: (typeof ADD_PRIMS)[number]['ref']) => {
    const id = crypto.randomUUID()
    void commitAddObject(editingSceneId, defaultObject(id, { kind: 'primitive', ref })).then(() =>
      setFocusedObject(id),
    )
  }

  // Buttons in a group sit tight (adjacent, hover-bg distinguishes each); action groups
  // are split by a light half-height inset divider (the strong full-height split is the
  // purple↔white zone boundary), so the rhythm reads as chunks.
  const toolBtn = 'my-1.5 flex items-center rounded-md px-2 text-xs'
  const sep = 'mx-1.5 h-4 w-px self-center bg-border'

  return (
    <div className="pointer-events-auto inline-flex items-stretch overflow-hidden rounded-xl border border-border/80 shadow-md">
      {/* Mode zone — a solid-purple, NON-interactive status cluster (Figma-style grouped
          zones), so "you are editing" reads as a mode, not as one of the action buttons.
          On the fixed strip, so it stays visible when the scene box is panned off-screen. */}
      <div className="flex items-center gap-2 bg-violet-500 px-3.5 py-2.5 text-xs font-medium text-white">
        <span className="size-1.5 rounded-full bg-white" aria-hidden />
        Editing · {sceneName}
        <button
          type="button"
          title="Recenter scene"
          aria-label="Recenter scene"
          onClick={() => recenterOnScene(editingSceneId)}
          className="ml-0.5 rounded-md p-1 text-white/80 hover:bg-white/15 hover:text-white"
        >
          <Crosshair className="size-3.5" />
        </button>
        <button
          type="button"
          title={placement === 'focus' ? 'Exit focus' : 'Focus (maximize)'}
          aria-label={placement === 'focus' ? 'Exit focus' : 'Focus (maximize)'}
          onClick={toggleFocus}
          className={cn(
            '-mr-1 rounded-md p-1 hover:bg-white/15 hover:text-white',
            placement === 'focus' ? 'bg-white/20 text-white' : 'text-white/80',
          )}
        >
          {placement === 'focus' ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </button>
      </div>

      {/* Tools zone — the actions. Full-height separators between groups; Done at the end. */}
      <div className="flex items-stretch bg-white px-1.5">
        {ADD_PRIMS.map((p) => (
          <button
            key={p.ref}
            type="button"
            onClick={() => addObject(p.ref)}
            className={cn(toolBtn, 'text-muted-foreground hover:bg-muted')}
          >
            + {p.label}
          </button>
        ))}

        {focusedId && (
          <>
            <span className={sep} />
            {GIZMOS.map((g) => (
              <button
                key={g.mode}
                type="button"
                onClick={() => setGizmo(g.mode)}
                className={cn(
                  toolBtn,
                  gizmoMode === g.mode
                    ? 'bg-violet-500/15 text-violet-700'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {g.label}
              </button>
            ))}
          </>
        )}

        <span className={sep} />
        {PROJECTIONS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => void commitActiveCameraPatch(editingSceneId, { projection: p.key })}
            className={cn(
              toolBtn,
              projection === p.key
                ? 'bg-violet-500/15 text-violet-700'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {p.label}
          </button>
        ))}

        <span className={sep} />
        <button
          type="button"
          onClick={exit}
          className={cn(toolBtn, 'font-medium text-muted-foreground hover:bg-muted')}
        >
          Done
        </button>
      </div>
    </div>
  )
}
