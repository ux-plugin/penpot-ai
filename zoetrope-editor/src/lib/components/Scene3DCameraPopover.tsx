/**
 * Scene3DCameraPopover — the camera SWITCHER opened from the edit strip's camera chip.
 *
 * One job: which camera am I looking through. Clicking a row switches to that camera
 * (and selects it, so its properties open in the right panel) — there's no separate eye,
 * because switching IS what this list is for. Adding a camera lives in the strip's `+`
 * alongside the other things you can add; a camera's properties live in the right panel
 * (`ThreeDCameraInspector`). So this stays a list of names + types, nothing more.
 *
 * NOTE: selecting here also switches, so it can't select a camera you're NOT looking
 * through. Use the Layers tree for that (row = select, eye = look through) — that's how
 * you pick a camera to grab in space while framing from another.
 */

import { useSnapshot } from 'valtio'
import { Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  scene3dProxy,
  sceneCameras,
  activeCamera,
  setSelectedCamera,
  type Scene3DDocument,
  type CameraProjection,
} from '../renderer/three/scene3d-store'
import { commitSetActiveCamera } from '../renderer/three/scene3d-commit'

/** Short type label per row — information only; the lens is edited in the right panel. */
const TYPE_LABEL: Record<CameraProjection, string> = {
  perspective: 'Persp',
  orthographic: 'Ortho',
}

export function Scene3DCameraPopover({ sceneId }: { sceneId: string }) {
  const snap = useSnapshot(scene3dProxy)
  const scene = snap.scenes.get(sceneId) as Scene3DDocument | undefined
  if (!scene) return null

  const cams = sceneCameras(scene)
  const activeId = activeCamera(scene).id

  return (
    <div className="w-56 rounded-xl border border-border/80 bg-white p-2.5 shadow-md">
      <div className="mb-1.5 px-1">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Cameras
        </span>
      </div>

      <div className="space-y-0.5">
        {cams.map((c) => {
          const isActive = c.id === activeId
          return (
            <button
              key={c.id}
              type="button"
              title={isActive ? 'Looking through this camera' : `Look through ${c.name}`}
              onClick={() => {
                setSelectedCamera(c.id)
                void commitSetActiveCamera(sceneId, c.id)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-sm',
                isActive ? 'bg-violet-500/10' : 'hover:bg-muted',
              )}
            >
              <Video
                className={cn(
                  'size-4 shrink-0',
                  isActive ? 'text-violet-600' : 'text-muted-foreground',
                )}
              />
              <span
                className={cn(
                  'flex-1 truncate text-left',
                  isActive && 'font-medium text-violet-700',
                )}
              >
                {c.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {TYPE_LABEL[c.projection]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
