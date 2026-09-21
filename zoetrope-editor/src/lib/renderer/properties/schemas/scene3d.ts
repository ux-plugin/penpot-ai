import { z } from 'zod'
import { prop } from '../meta'
import type { Accessor } from '../registry'

/**
 * Placeholders for the 3D lift. Today objects and cameras live inside
 * `node.scene3d`, not as nodes, so nothing reads or writes these yet. They are
 * registered so bindings and timelines can already name them (MODEL.md §1).
 */
const planned = (label: string, unit: 'px' | 'deg' | 'ratio' = 'px') =>
  prop(z.number().optional(), { label, unit, animatable: true, bindable: true, status: 'planned' })

export const Transform3D = z.object({
  positionX: planned('Position X'),
  positionY: planned('Position Y'),
  positionZ: planned('Position Z'),
  rotationX: planned('Rotation X', 'deg'),
  rotationY: planned('Rotation Y', 'deg'),
  rotationZ: planned('Rotation Z', 'deg'),
  scaleX: planned('Scale X', 'ratio'),
  scaleY: planned('Scale Y', 'ratio'),
  scaleZ: planned('Scale Z', 'ratio'),
})
export type Transform3D = z.infer<typeof Transform3D>

export const Material = z.object({
  color: prop(z.string().optional(), { label: 'Color', type: 'color', animatable: true, bindable: true, status: 'planned' }),
  metalness: planned('Metalness', 'ratio'),
  roughness: planned('Roughness', 'ratio'),
  opacity: planned('Opacity', 'ratio'),
})
export type Material = z.infer<typeof Material>

const none: Accessor = { get: () => undefined }

export const transform3dAccessors: Record<keyof Transform3D, Accessor> = Object.fromEntries(
  Object.keys(Transform3D.shape).map((k) => [k, none]),
) as Record<keyof Transform3D, Accessor>

export const materialAccessors: Record<keyof Material, Accessor> = Object.fromEntries(
  Object.keys(Material.shape).map((k) => [k, none]),
) as Record<keyof Material, Accessor>
