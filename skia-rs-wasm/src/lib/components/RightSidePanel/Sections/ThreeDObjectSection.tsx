/**
 * ThreeDObjectSection — inspector for an embedded 3D object.
 *
 * Reads the in-memory 3D read-cache (`scene3dProxy`, kept in sync with the
 * document by scene3d-sync). Writes go through the document via the commit
 * helpers (`commitTransform3d`/`commitMaterial`/…), so every edit is one
 * undoable `mod-obj` on the node — Cmd-Z restores the prior 3D state. Numeric
 * fields use NumericField (commit on Enter/blur/step, focus-scoped to one undo
 * frame); the colour swatch previews live via the store action and persists on
 * blur.
 */

import { useSnapshot } from 'valtio'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { scene3dProxy, setMaterial, type Vec3 } from '@/lib/renderer/three/scene3d-store'
import {
  commitCamera,
  commitEnv,
  commitMaterial,
  commitTransform3d,
} from '@/lib/renderer/three/scene3d-commit'
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

export function ThreeDObjectSection({ nodeId }: { nodeId: string }) {
  const snap = useSnapshot(scene3dProxy)
  const entry = snap.objects.get(nodeId)
  if (!entry) return null

  const t = entry.transform3d
  const m = entry.material

  const setPos = (axis: number, v: number) => {
    const next = [...t.position] as Vec3
    next[axis] = v
    void commitTransform3d(nodeId, { position: next })
  }
  const setRot = (axis: number, v: number) => {
    const next = [...t.rotationEuler] as Vec3
    next[axis] = v
    void commitTransform3d(nodeId, { rotationEuler: next })
  }
  const setScaleUniform = (v: number) => void commitTransform3d(nodeId, { scale: [v, v, v] })

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">3D object</p>

        <Vec3Row label="Position" value={t.position} onCommit={setPos} />
        <Vec3Row label="Rotation (°)" value={t.rotationEuler} onCommit={setRot} />

        <div className="space-y-1">
          <Label htmlFor="td-scale">Scale</Label>
          <NumericField
            id="td-scale"
            min={0.01}
            step={0.05}
            value={t.scale[0]}
            onCommit={setScaleUniform}
          />
        </div>

        <Separator />
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Material</p>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Base color"
            value={m.color}
            // Live local preview while dragging the picker; persist on blur.
            onChange={(e) => setMaterial(nodeId, { color: e.target.value })}
            onBlur={(e) => void commitMaterial(nodeId, { color: e.target.value })}
            className="h-8 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0"
          />
          <Input
            type="text"
            value={m.color}
            onChange={(e) => setMaterial(nodeId, { color: e.target.value })}
            onBlur={(e) => void commitMaterial(nodeId, { color: e.target.value })}
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
              onCommit={(v) => void commitMaterial(nodeId, { metalness: v })}
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
              onCommit={(v) => void commitMaterial(nodeId, { roughness: v })}
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
              onCommit={(v) => void commitMaterial(nodeId, { opacity: v })}
            />
          </div>
        </div>

        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="td-fov">Camera FOV</Label>
            <NumericField
              id="td-fov"
              min={10}
              max={120}
              precision={0}
              value={entry.camera.fov}
              onCommit={(v) => void commitCamera(nodeId, { fov: v })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="td-env">Light intensity</Label>
            <NumericField
              id="td-env"
              min={0}
              max={4}
              step={0.1}
              value={entry.env.intensity}
              onCommit={(v) => void commitEnv(nodeId, { intensity: v })}
            />
          </div>
        </div>
      </div>
    </>
  )
}
