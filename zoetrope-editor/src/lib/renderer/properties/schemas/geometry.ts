import { z } from 'zod'
import type { RectShape } from 'penpot-exporter/types'
import { prop } from '../meta'

const px = { unit: 'px', syncGroup: 'geometry-group' } as const

export const Geometry = z.object({
  x: prop(z.number(), { ...px, label: 'X', animatable: true, bindable: true, tokenable: ['dimension'] }),
  y: prop(z.number(), { ...px, label: 'Y', animatable: true, bindable: true, tokenable: ['dimension'] }),
  width: prop(z.number(), { ...px, label: 'Width', animatable: true, bindable: true, tokenable: ['dimension', 'sizing'] }),
  height: prop(z.number(), { ...px, label: 'Height', animatable: true, bindable: true, tokenable: ['dimension', 'sizing'] }),
  rotation: prop(z.number().optional(), {
    label: 'Rotation',
    unit: 'deg',
    syncGroup: 'geometry-group',
    animatable: true,
    bindable: true,
    tokenable: ['dimension'],
  }),
})
export type Geometry = z.infer<typeof Geometry>

const _drift: Geometry = {} as RectShape
void _drift
