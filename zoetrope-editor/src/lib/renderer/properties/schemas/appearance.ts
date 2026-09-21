import { z } from 'zod'
import type { Fill, PenpotNode, Stroke } from 'penpot-exporter/types'
import { prop } from '../meta'
import type { Accessor } from '../registry'

/**
 * `fill`, `strokeColor`, `strokeWidth` are synthetic: the token system's
 * names for the first fill / first stroke. Their accessors mirror
 * tokens/materialize.ts so both write the same shape.
 */
export const Appearance = z.object({
  opacity: prop(z.number().optional(), {
    label: 'Opacity',
    unit: 'ratio',
    range: { min: 0, max: 1 },
    animatable: true,
    bindable: true,
    tokenable: ['opacity'],
    syncGroup: 'layer-effects-group',
  }),
  fill: prop(z.string().optional(), {
    label: 'Fill',
    type: 'color',
    animatable: true,
    bindable: true,
    tokenable: ['color'],
    syncGroup: 'fill-group',
  }),
  strokeColor: prop(z.string().optional(), {
    label: 'Stroke',
    type: 'color',
    animatable: true,
    bindable: true,
    tokenable: ['color'],
    syncGroup: 'stroke-group',
  }),
  strokeWidth: prop(z.number().optional(), {
    label: 'Stroke width',
    unit: 'px',
    range: { min: 0 },
    animatable: true,
    bindable: true,
    tokenable: ['dimension'],
    syncGroup: 'stroke-group',
  }),
})
export type Appearance = z.infer<typeof Appearance>

type WithPaint = PenpotNode & { fills?: Fill[]; strokes?: Stroke[] }

export const appearanceAccessors: Record<'fill' | 'strokeColor' | 'strokeWidth', Accessor> = {
  fill: {
    get: (n) => (n as WithPaint).fills?.[0]?.fillColor,
    set: (n, v) => {
      const fills: Fill[] = [...((n as WithPaint).fills ?? [])]
      fills[0] = { ...(fills[0] ?? {}), fillColor: String(v), fillOpacity: fills[0]?.fillOpacity ?? 1 }
      return { fills } as Partial<PenpotNode>
    },
  },
  strokeColor: {
    get: (n) => (n as WithPaint).strokes?.[0]?.strokeColor,
    // Recolor an existing stroke only — never fabricate a width-less stroke.
    set: (n, v) => {
      const existing = (n as WithPaint).strokes
      if (!existing?.length) return {}
      const strokes = [...existing]
      strokes[0] = { ...strokes[0], strokeColor: String(v), strokeOpacity: strokes[0]?.strokeOpacity ?? 1 }
      return { strokes } as Partial<PenpotNode>
    },
  },
  strokeWidth: {
    get: (n) => (n as WithPaint).strokes?.[0]?.strokeWidth,
    set: (n, v) => {
      const existing = (n as WithPaint).strokes
      if (!existing?.length || typeof v !== 'number') return {}
      const strokes = [...existing]
      strokes[0] = { ...strokes[0], strokeWidth: v }
      return { strokes } as Partial<PenpotNode>
    },
  },
}

// `opacity` is a plain node key; the synthetic three have no key of their own.
const _drift: Pick<Appearance, 'opacity'> = {} as PenpotNode
void _drift
