/**
 * ThreeDObjectSection — inspector for an embedded 3D *scene*.
 *
 * Reads the read-cache (`scene3dProxy`, kept in sync with the document by
 * scene3d-sync). Shows scene-level controls (camera + environment) and an object
 * list — clicking an object focuses it and enters 3D-edit mode. When a scene is
 * being edited with a focused object, its transform + material are shown too.
 * Every edit commits through the document (one undoable mod-obj on the scene node).
 */

import { useSnapshot } from 'valtio'
import { Box } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  scene3dProxy,
  patchObjectMaterialLocal,
  patchSceneBackgroundLocal,
  SCENE3D_EDIT_BACKDROP,
  type Object3DEntry,
  type Scene3DDocument,
  type Vec3,
} from '@/lib/renderer/three/scene3d-store'
import {
  commitObjectMaterial,
  commitObjectTransform,
  commitSceneBackground,
  commitSceneCamera,
  commitSceneEnv,
} from '@/lib/renderer/three/scene3d-commit'
import { useScene3dEditing } from '@/lib/renderer/three/use-scene3d-editing'
import { NumericField } from '../NumericField'

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

/** The list of objects in the scene; clicking one focuses it (entering edit mode). */
function ObjectList({
  scene,
  focusedId,
  onPick,
}: {
  scene: Scene3DDocument
  focusedId: string | null
  onPick: (objId: string) => void
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Objects</p>
      {scene.objects.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Empty scene — enter 3D edit and add an object.
        </p>
      )}
      {scene.objects.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onPick(o.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm',
            o.id === focusedId ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950' : 'hover:bg-muted',
          )}
        >
          <Box className="size-3.5 shrink-0 stroke-[1.5]" />
          <span className="flex-1 truncate text-left">{o.name}</span>
        </button>
      ))}
    </div>
  )
}

/** Transform + material for the focused object. */
function ObjectProps({ sceneId, object }: { sceneId: string; object: Object3DEntry }) {
  const t = object.transform3d
  const m = object.material

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
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {object.name}
      </p>
      <Vec3Row label="Position" value={t.position} onCommit={setPos} />
      <Vec3Row label="Rotation (°)" value={t.rotationEuler} onCommit={setRot} />
      <div className="space-y-1">
        <Label htmlFor="td-scale">Scale</Label>
        <NumericField id="td-scale" min={0.01} step={0.05} value={t.scale[0]} onCommit={setScale} />
      </div>

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

export function ThreeDObjectSection({ nodeId }: { nodeId: string }) {
  const snap = useSnapshot(scene3dProxy)
  const { editingSceneId, enter } = useScene3dEditing()
  const scene = snap.scenes.get(nodeId) as Scene3DDocument | undefined
  if (!scene) return null

  const editingThis = editingSceneId === nodeId
  const focused =
    editingThis && snap.focusedObjectId
      ? scene.objects.find((o) => o.id === snap.focusedObjectId)
      : undefined

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">3D scene</p>

        <ObjectList
          scene={scene}
          focusedId={snap.focusedObjectId}
          onPick={(id) => enter(nodeId, id)}
        />

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="td-fov">Camera FOV</Label>
            <NumericField
              id="td-fov"
              min={10}
              max={120}
              precision={0}
              value={scene.camera.fov}
              onCommit={(v) => void commitSceneCamera(nodeId, { fov: v })}
            />
          </div>
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
        </div>

        {editingThis && (
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

      {focused && <ObjectProps sceneId={nodeId} object={focused} />}
    </>
  )
}
