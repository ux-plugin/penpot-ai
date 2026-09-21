import { z } from 'zod'
import type { PenpotNode } from 'penpot-exporter/types'
import { prop } from '../meta'

export const Base = z.object({
  name: prop(z.string(), { label: 'Name', bindable: true, syncGroup: 'name-group' }),
  hidden: prop(z.boolean().optional(), { label: 'Hidden', bindable: true, syncGroup: 'visibility-group' }),
})
export type Base = z.infer<typeof Base>

// Drift check against the exporter's node type.
const _drift: Base = {} as PenpotNode
void _drift
