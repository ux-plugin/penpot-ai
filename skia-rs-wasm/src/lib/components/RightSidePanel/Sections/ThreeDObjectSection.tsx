/**
 * 3D inspector sections for an embedded 3D *scene*.
 *
 * The inspector is CONTEXTUAL (the scene container is the only real 2D selection,
 * with objects focused inside it):
 *   - `ThreeDSceneSection`   — scene-level props (camera + environment + edit
 *                              backdrop). Shown alongside the container's normal
 *                              sections when the scene itself is selected. The object
 *                              LIST lives in the Layers panel, not here.
 *   - `ThreeDObjectInspector`— the focused object's transform + material, shown
 *                              ALONE (NodePropertyPanel swaps out the container's 2D
 *                              chrome) so you inspect the object, not its placeholder.
 *   - `ThreeDCameraInspector`— the selected camera's own properties (lens + placement),
 *                              also shown ALONE. A camera is a first-class component of
 *                              the scene, so its properties live HERE — the edit strip's
 *                              dropdown is only a switcher (which cameras exist / which
 *                              one you're looking through).
 *
 * All read the read-cache (`scene3dProxy`, kept in sync by scene3d-sync) and commit
 * through the document (one undoable mod-obj on the scene node).
 */

import { ChevronLeft, Video } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  patchObjectMaterialLocal,
  patchSceneBackgroundLocal,
  setFocusedObject,
  setSelectedCamera,
  SCENE3D_EDIT_BACKDROP,
  type Camera3DEntry,
  type CameraProjection,
  type Object3DEntry,
  type Scene3DDocument,
  type Vec3,
} from '@/lib/renderer/three/scene3d-store'
import {
  commitCameraPatch,
  commitObjectMaterial,
  commitObjectTransform,
  commitSceneBackground,
  commitSceneEnv,
} from '@/lib/renderer/three/scene3d-commit'
import { defaultCameraPose } from '@/lib/renderer/three/three-scene'
import { perspHalfHeightAtDistance } from '@/lib/renderer/three/camera3d'
import { getNode } from '@/lib/renderer/store/doc-proxy'
import { NumericField } from '../NumericField'

/** Home-view distance the default ortho size derives from (matches three-scene's
 *  CAM_HOME_POS); only used to seed the field before `orthoSize` is set. */
const HOME_DIST = Math.hypot(2.4, 1.8, 2.8)

const PROJECTIONS: { key: CameraProjection; label: string }[] = [
  { key: 'perspective', label: 'Perspective' },
  { key: 'orthographic', label: 'Ortho' },
]

const AXES = ['X', 'Y', 'Z'] as const

function Vec3Row({
  label,
  value,
  onCommit,
}: {
  label: string
  value: readonly [number, number, number]
  onCommit: (axis: number, v: number) => void
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {AXES.map((ax, i) => (
          <div key={ax} className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">{ax}</span>
            <NumericField
              aria-label={`${label} ${ax}`}
              value={Number.isFinite(value[i]) ? value[i] : 0}
              onCommit={(v) => onCommit(i, v)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Scene-level properties (camera + environment). Rendered next to the scene
 * container's normal sections when the scene itself is selected. No object list —
 * that's the Layers panel's job.
 */
export function ThreeDSceneSection({
  scene,
  editing,
}: {
  scene: Scene3DDocument
  editing: boolean
}) {
  const nodeId = scene.sceneId
  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">3D scene</p>

        {/* Camera projection + FOV live in the camera popover (bottom edit strip), where
            the whole camera list is managed. The inspector keeps only scene environment. */}
        <div className="space-y-1">
          <Label htmlFor="td-env">Light intensity</Label>
          <NumericField
            id="td-env"
            min={0}
            max={4}
            step={0.1}
            value={scene.env.intensity}
            onCommit={(v) => void commitSceneEnv(nodeId, { intensity: v })}
          />
        </div>

        {editing && (
          <div className="space-y-1">
            <Label>Edit background</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Edit background color"
                value={scene.background ?? SCENE3D_EDIT_BACKDROP}
                onChange={(e) => patchSceneBackgroundLocal(nodeId, e.target.value)}
                onBlur={(e) => void commitSceneBackground(nodeId, e.target.value)}
                className="h-8 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0"
              />
              <Input
                type="text"
                value={scene.background ?? SCENE3D_EDIT_BACKDROP}
                onChange={(e) => patchSceneBackgroundLocal(nodeId, e.target.value)}
                onBlur={(e) => void commitSceneBackground(nodeId, e.target.value)}
              />
              <button
                type="button"
                onClick={() => void commitSceneBackground(nodeId, null)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                Default
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">Backdrop shown only while editing.</p>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * The focused object's transform + material. Shown ALONE (the panel swaps out the
 * container's 2D sections), with a breadcrumb back to the scene so scene-level props
 * are one click away.
 */
export function ThreeDObjectInspector({
  sceneId,
  object,
}: {
  sceneId: string
  object: Object3DEntry
}) {
  const t = object.transform3d
  const m = object.material
  const sceneName = (getNode(sceneId) as { name?: string } | undefined)?.name ?? '3D scene'

  const setPos = (axis: number, v: number) => {
    const position = [...t.position] as Vec3
    position[axis] = v
    void commitObjectTransform(sceneId, object.id, { ...t, position })
  }
  const setRot = (axis: number, v: number) => {
    const rotationEuler = [...t.rotationEuler] as Vec3
    rotationEuler[axis] = v
    void commitObjectTransform(sceneId, object.id, { ...t, rotationEuler })
  }
  const setScale = (v: number) =>
    void commitObjectTransform(sceneId, object.id, { ...t, scale: [v, v, v] })

  return (
    <div className="min-w-0 space-y-3">
      {/* Breadcrumb: which object, and one click back to the scene (clears focus). */}
      <button
        type="button"
        onClick={() => setFocusedObject(null)}
        className="flex w-full items-center gap-1 rounded-md py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        <span className="truncate">{sceneName}</span>
      </button>
      <p className="truncate text-sm font-medium">{object.name}</p>

      <Vec3Row label="Position" value={t.position} onCommit={setPos} />
      <Vec3Row label="Rotation (°)" value={t.rotationEuler} onCommit={setRot} />
      <div className="space-y-1">
        <Label htmlFor="td-scale">Scale</Label>
        <NumericField id="td-scale" min={0.01} step={0.05} value={t.scale[0]} onCommit={setScale} />
      </div>

      <Separator />

      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Material</p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Base color"
          value={m.color}
          onChange={(e) => patchObjectMaterialLocal(sceneId, object.id, { color: e.target.value })}
          onBlur={(e) => void commitObjectMaterial(sceneId, object.id, { color: e.target.value })}
          className="h-8 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0"
        />
        <Input
          type="text"
          value={m.color}
          onChange={(e) => patchObjectMaterialLocal(sceneId, object.id, { color: e.target.value })}
          onBlur={(e) => void commitObjectMaterial(sceneId, object.id, { color: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="td-metal">Metalness</Label>
          <NumericField
            id="td-metal"
            min={0}
            max={1}
            step={0.05}
            value={m.metalness}
            onCommit={(v) => void commitObjectMaterial(sceneId, object.id, { metalness: v })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-rough">Roughness</Label>
          <NumericField
            id="td-rough"
            min={0}
            max={1}
            step={0.05}
            value={m.roughness}
            onCommit={(v) => void commitObjectMaterial(sceneId, object.id, { roughness: v })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-opacity">Opacity</Label>
          <NumericField
            id="td-opacity"
            min={0}
            max={1}
            step={0.05}
            value={m.opacity}
            onCommit={(v) => void commitObjectMaterial(sceneId, object.id, { opacity: v })}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The SELECTED camera's own properties: its lens (projection + FOV/ortho size) and its
 * placement. A camera is a first-class component of the scene, so this is where its
 * properties are edited — the edit strip's dropdown only switches between cameras.
 * Shown ALONE, like the object inspector.
 */
export function ThreeDCameraInspector({
  sceneId,
  camera,
}: {
  sceneId: string
  camera: Camera3DEntry
}) {
  const sceneName = (getNode(sceneId) as { name?: string } | undefined)?.name ?? '3D scene'
  // A camera with no pose yet renders at the canonical 3/4 home view — show those REAL
  // values (and materialise them on the first edit) rather than zeros.
  const pose = camera.transform3d ?? defaultCameraPose()
  const orthoSize = camera.orthoSize ?? perspHalfHeightAtDistance(camera.fov, HOME_DIST)

  const setPos = (axis: number, v: number) => {
    const position = [...pose.position] as Vec3
    position[axis] = v
    void commitCameraPatch(sceneId, camera.id, { transform3d: { ...pose, position } })
  }
  const setRot = (axis: number, v: number) => {
    const rotationEuler = [...pose.rotationEuler] as Vec3
    rotationEuler[axis] = v
    void commitCameraPatch(sceneId, camera.id, { transform3d: { ...pose, rotationEuler } })
  }

  return (
    <div className="min-w-0 space-y-3">
      {/* Breadcrumb: which scene, and one click back to it (clears the selection). */}
      <button
        type="button"
        onClick={() => setSelectedCamera(null)}
        className="flex w-full items-center gap-1 rounded-md py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        <span className="truncate">{sceneName}</span>
      </button>
      <p className="flex items-center gap-2 truncate text-sm font-medium">
        <Video className="size-4 shrink-0 text-muted-foreground" />
        {camera.name}
      </p>

      <div className="space-y-1">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Projection
        </p>
        <div className="flex rounded-md bg-muted p-0.5">
          {PROJECTIONS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => void commitCameraPatch(sceneId, camera.id, { projection: p.key })}
              className={cn(
                'flex-1 rounded px-2 py-1 text-xs',
                camera.projection === p.key
                  ? 'bg-white font-medium text-foreground shadow-sm dark:bg-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Only the live projection's framing control is shown; the other value is kept
          (persp⇄ortho is lossless), it just isn't in play right now. */}
      {camera.projection === 'perspective' ? (
        <div className="space-y-1">
          <Label htmlFor="td-cam-fov">FOV (°)</Label>
          <NumericField
            id="td-cam-fov"
            min={15}
            max={110}
            precision={0}
            value={camera.fov}
            onCommit={(v) => void commitCameraPatch(sceneId, camera.id, { fov: v })}
          />
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="td-cam-size">Ortho size</Label>
          <NumericField
            id="td-cam-size"
            min={0.1}
            step={0.1}
            value={orthoSize}
            onCommit={(v) => void commitCameraPatch(sceneId, camera.id, { orthoSize: v })}
          />
        </div>
      )}

      <Vec3Row label="Position" value={pose.position} onCommit={setPos} />
      <Vec3Row label="Rotation (°)" value={pose.rotationEuler} onCommit={setRot} />
    </div>
  )
}
