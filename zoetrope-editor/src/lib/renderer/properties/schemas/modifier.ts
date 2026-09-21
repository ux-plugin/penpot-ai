import { z } from 'zod'
import { prop } from '../meta'
import type { Accessor } from '../registry'

/**
 * Render-time channels. They exist only in the motion modifier (a matrix
 * pushed to render-wasm), never on the node, so they have no `set`.
 */
export const Modifier = z.object({
  scaleX: prop(z.number().optional(), { label: 'Scale X', unit: 'ratio', animatable: true, bindable: false }),
  scaleY: prop(z.number().optional(), { label: 'Scale Y', unit: 'ratio', animatable: true, bindable: false }),
})
export type Modifier = z.infer<typeof Modifier>

const channel: Accessor = { get: () => undefined }

export const modifierAccessors: Record<keyof Modifier, Accessor> = { scaleX: channel, scaleY: channel }
