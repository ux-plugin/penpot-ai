import { z } from 'zod'
import type { RectShape } from 'penpot-exporter/types'
import { prop } from '../meta'

const r = (label: string) =>
  prop(z.number().optional(), {
    label,
    unit: 'px',
    range: { min: 0 },
    animatable: true,
    bindable: true,
    tokenable: ['borderRadius'],
    syncGroup: 'radius-group',
  })

export const Radius = z.object({
  r1: r('Radius top-left'),
  r2: r('Radius top-right'),
  r3: r('Radius bottom-right'),
  r4: r('Radius bottom-left'),
})
export type Radius = z.infer<typeof Radius>

const _drift: Radius = {} as RectShape
void _drift
