/**
 * Scene3DCameraPopover — the camera list + props panel opened from the edit strip's
 * camera chip.
 *
 * Two distinct notions of "current camera":
 *  - ACTIVE (look-through): `activeCameraId` on the doc — what the scene renders
 *    through. Switched by the eye button (`commitSetActiveCamera`), persisted, undoable.
 *  - SELECTED (for editing): `scene3dProxy.selectedCameraId` — whose projection/FOV the
 *    props section edits. Clicking a row selects it WITHOUT changing the view. Defaults
 *    to the active one.
 *
 * "Add camera" clones the current live view so the new camera starts where you're
 * looking, then selects it (you reposition, then look through when ready).
 */

import { useSnapshot } from 'valtio'
import { Eye, Plus, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  scene3dProxy,
  sceneCameras,
  activeCamera,
  editedCamera,
  nextCameraName,
  setSelectedCamera,
  patchCameraFovLocal,
  patchCameraOrthoSizeLocal,
  getInstance,
  type Scene3DDocument,
  type CameraProjection,
} from '../renderer/three/scene3d-store'
import {
  commitAddCamera,
  commitSetActiveCamera,
  commitCameraPatch,
} from '../renderer/three/scene3d-commit'
import { readCameraPose } from '../renderer/three/three-scene'
import { perspHalfHeightAtDistance } from '../renderer/three/camera3d'

/** Home-view distance the default ortho size is derived from (matches three-scene's
 *  CAM_HOME_POS = [2.4,1.8,2.8]); only used to seed the slider before orthoSize is set. */
const HOME_DIST = Math.hypot(2.4, 1.8, 2.8)

const PROJECTIONS: { key: CameraProjection; label: string }[] = [
  { key: 'perspective', label: 'Perspective' },
  { key: 'orthographic', label: 'Ortho' },
]

export function Scene3DCameraPopover({ sceneId }: { sceneId: string }) {
  const snap = useSnapshot(scene3dProxy)
  const scene = snap.scenes.get(sceneId) as Scene3DDocument | undefined
  if (!scene) return null

  const cams = sceneCameras(scene)
  const activeId = activeCamera(scene).id
  const selected = editedCamera(scene, snap.selectedCameraId)

  const addCamera = () => {
    const live = getInstance(sceneId)?.camera
    const transform3d = live ? readCameraPose(live) : undefined
    void commitAddCamera(sceneId, { name: nextCameraName(scene), transform3d }).then((id) => {
      if (id) setSelectedCamera(id)
    })
  }

  return (
    <div className="w-56 rounded-xl border border-border/80 bg-white p-2.5 shadow-md">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Cameras
        </span>
        <button
          type="button"
          onClick={addCamera}
          title="Add camera at current view"
          aria-label="Add camera"
          className="grid size-6 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {cams.map((c) => {
          const isActive = c.id === activeId
          const isSelected = c.id === selected.id
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedCamera(c.id)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm',
                isSelected ? 'bg-violet-500/10' : 'hover:bg-muted',
              )}
            >
              <button
                type="button"
                title={isActive ? 'Looking through this camera' : 'Look through'}
                aria-label={isActive ? 'Active camera' : 'Look through camera'}
                onClick={(e) => {
                  e.stopPropagation()
                  void commitSetActiveCamera(sceneId, c.id)
                }}
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded',
                  isActive ? 'text-violet-600' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {isActive ? <Eye className="size-4" /> : <Video className="size-4" />}
              </button>
              <span
                className={cn('flex-1 truncate', isActive && 'font-medium text-violet-700')}
              >
                {c.name}
              </span>
              {isActive && (
                <span className="text-[9px] font-medium tracking-wide text-violet-600 uppercase">
                  active
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="my-2 h-px bg-border" />

      {/* Projection + FOV of the SELECTED camera. */}
      <div className="flex rounded-md bg-muted p-0.5">
        {PROJECTIONS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => void commitCameraPatch(sceneId, selected.id, { projection: p.key })}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs',
              selected.projection === p.key
                ? 'bg-white font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {selected.projection === 'perspective' ? (
        <div className="mt-2 flex items-center gap-2 px-1">
          <span className="text-xs text-muted-foreground">FOV</span>
          <input
            type="range"
            min={15}
            max={110}
            step={1}
            value={Math.round(selected.fov)}
            onChange={(e) => patchCameraFovLocal(sceneId, selected.id, Number(e.target.value))}
            onPointerUp={(e) =>
              void commitCameraPatch(sceneId, selected.id, { fov: Number(e.currentTarget.value) })
            }
            onKeyUp={(e) =>
              void commitCameraPatch(sceneId, selected.id, { fov: Number(e.currentTarget.value) })
            }
            onBlur={(e) =>
              void commitCameraPatch(sceneId, selected.id, { fov: Number(e.currentTarget.value) })
            }
            className="h-1 flex-1 cursor-pointer accent-violet-500"
            aria-label="Field of view"
          />
          <span className="w-8 text-right text-xs tabular-nums">{Math.round(selected.fov)}°</span>
        </div>
      ) : (
        (() => {
          const size = selected.orthoSize ?? perspHalfHeightAtDistance(selected.fov, HOME_DIST)
          return (
            <div className="mt-2 flex items-center gap-2 px-1">
              <span className="text-xs text-muted-foreground">Size</span>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.1}
                value={size}
                onChange={(e) =>
                  patchCameraOrthoSizeLocal(sceneId, selected.id, Number(e.target.value))
                }
                onPointerUp={(e) =>
                  void commitCameraPatch(sceneId, selected.id, {
                    orthoSize: Number(e.currentTarget.value),
                  })
                }
                onKeyUp={(e) =>
                  void commitCameraPatch(sceneId, selected.id, {
                    orthoSize: Number(e.currentTarget.value),
                  })
                }
                onBlur={(e) =>
                  void commitCameraPatch(sceneId, selected.id, {
                    orthoSize: Number(e.currentTarget.value),
                  })
                }
                className="h-1 flex-1 cursor-pointer accent-violet-500"
                aria-label="Orthographic size"
              />
              <span className="w-8 text-right text-xs tabular-nums">{size.toFixed(1)}</span>
            </div>
          )
        })()
      )}
    </div>
  )
}
