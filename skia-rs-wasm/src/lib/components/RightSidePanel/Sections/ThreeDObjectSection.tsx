/**
 * ThreeDObjectSection — inspector for an embedded 3D object.
 *
 * Reads/writes the in-memory 3D model (`scene3dProxy`), not the document.
 * Edits apply immediately (the overlay redraws via its valtio subscription).
 * Phase 1: 3D-property edits are not yet in the undo history (see plan).
 */

import { useSnapshot } from 'valtio'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { round2 } from '@/lib/common/conversions'
import {
  scene3dProxy,
  setCamera,
  setEnv,
  setMaterial,
  setTransform3d,
  type Vec3,
} from '@/lib/renderer/three/scene3d-store'

const AXES = ['X', 'Y', 'Z'] as const

function num(e: React.ChangeEvent<HTMLInputElement>): number {
  return parseFloat(e.target.value) || 0
}

function Vec3Row({
  label,
  value,
  onChange,
}: {
  label: string
  value: readonly [number, number, number]
  onChange: (axis: number, v: number) => void
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {AXES.map((ax, i) => (
          <div key={ax} className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">{ax}</span>
            <Input
              type="number"
              value={Number.isFinite(value[i]) ? round2(value[i]) : 0}
              onChange={(e) => onChange(i, num(e))}
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
    setTransform3d(nodeId, { position: next })
  }
  const setRot = (axis: number, v: number) => {
    const next = [...t.rotationEuler] as Vec3
    next[axis] = v
    setTransform3d(nodeId, { rotationEuler: next })
  }
  const setScaleUniform = (v: number) => setTransform3d(nodeId, { scale: [v, v, v] })

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">3D object</p>

        <Vec3Row label="Position" value={t.position} onChange={setPos} />
        <Vec3Row label="Rotation (°)" value={t.rotationEuler} onChange={setRot} />

        <div className="space-y-1">
          <Label htmlFor="td-scale">Scale</Label>
          <Input
            id="td-scale"
            type="number"
            step={0.05}
            value={round2(t.scale[0])}
            onChange={(e) => setScaleUniform(num(e))}
          />
        </div>

        <Separator />
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Material</p>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Base color"
            value={m.color}
            onChange={(e) => setMaterial(nodeId, { color: e.target.value })}
            className="h-8 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0"
          />
          <Input
            type="text"
            value={m.color}
            onChange={(e) => setMaterial(nodeId, { color: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="td-metal">Metalness</Label>
            <Input
              id="td-metal"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={round2(m.metalness)}
              onChange={(e) => setMaterial(nodeId, { metalness: num(e) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="td-rough">Roughness</Label>
            <Input
              id="td-rough"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={round2(m.roughness)}
              onChange={(e) => setMaterial(nodeId, { roughness: num(e) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="td-opacity">Opacity</Label>
            <Input
              id="td-opacity"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={round2(m.opacity)}
              onChange={(e) => setMaterial(nodeId, { opacity: num(e) })}
            />
          </div>
        </div>

        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="td-fov">Camera FOV</Label>
            <Input
              id="td-fov"
              type="number"
              min={10}
              max={120}
              value={round2(entry.camera.fov)}
              onChange={(e) => setCamera(nodeId, { fov: num(e) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="td-env">Light intensity</Label>
            <Input
              id="td-env"
              type="number"
              min={0}
              max={4}
              step={0.1}
              value={round2(entry.env.intensity)}
              onChange={(e) => setEnv(nodeId, { intensity: num(e) })}
            />
          </div>
        </div>
      </div>
    </>
  )
}
