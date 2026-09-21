import { z } from 'zod'
import type { FrameShape } from 'penpot-exporter/types'
import { prop } from '../meta'

const gap = (label: string, key: string) =>
  prop(z.number().optional(), {
    label,
    unit: 'px',
    range: { min: 0 },
    bindable: true,
    tokenable: ['dimension', 'spacing'],
    syncGroup: 'layout-gap',
    path: `layoutGap.${key}`,
  })

const pad = (label: string, key: string) =>
  prop(z.number().optional(), {
    label,
    unit: 'px',
    range: { min: 0 },
    bindable: true,
    tokenable: ['dimension', 'spacing'],
    syncGroup: 'layout-padding',
    path: `layoutPadding.${key}`,
  })

/** Container layout: a frame with flex/grid. Field names match `TokenProperties`. */
export const Layout = z.object({
  rowGap: gap('Row gap', 'rowGap'),
  columnGap: gap('Column gap', 'columnGap'),
  p1: pad('Padding top', 'p1'),
  p2: pad('Padding right', 'p2'),
  p3: pad('Padding bottom', 'p3'),
  p4: pad('Padding left', 'p4'),
})
export type Layout = z.infer<typeof Layout>

const size = (label: string, syncGroup: 'layout-item-min-w' | 'layout-item-max-w' | 'layout-item-min-h' | 'layout-item-max-h') =>
  prop(z.number().optional(), {
    label,
    unit: 'px',
    range: { min: 0 },
    bindable: true,
    tokenable: ['dimension', 'sizing'],
    syncGroup,
  })

const margin = (label: string, key: string) =>
  prop(z.number().optional(), {
    label,
    unit: 'px',
    bindable: true,
    tokenable: ['dimension', 'spacing'],
    syncGroup: 'layout-item-margin',
    path: `layoutItemMargin.${key}`,
  })

/** Child-in-layout constraints. Every shape may sit in a layout. */
export const LayoutItem = z.object({
  layoutItemMinW: size('Min width', 'layout-item-min-w'),
  layoutItemMaxW: size('Max width', 'layout-item-max-w'),
  layoutItemMinH: size('Min height', 'layout-item-min-h'),
  layoutItemMaxH: size('Max height', 'layout-item-max-h'),
  m1: margin('Margin top', 'm1'),
  m2: margin('Margin right', 'm2'),
  m3: margin('Margin bottom', 'm3'),
  m4: margin('Margin left', 'm4'),
})
export type LayoutItem = z.infer<typeof LayoutItem>

// Gaps, paddings, margins live one level down on the node; only the sizing keys are top-level.
const _drift: Pick<LayoutItem, 'layoutItemMinW' | 'layoutItemMaxW' | 'layoutItemMinH' | 'layoutItemMaxH'> = {} as FrameShape
void _drift
