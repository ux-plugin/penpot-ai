/**
 * Property metadata — what a zod field carries beyond its value type.
 *
 * Schema first: a bundle is a `z.object` whose fields are tagged with `prop()`.
 * The registry (./registry.ts) walks the schema and derives descriptors and
 * accessors from it, so a property is declared exactly once.
 */

import { z } from 'zod'
import type { SupportedTokenType } from '../../tokens/types'
import type { ComponentSyncGroup } from '../component/sync-attrs'

export type PropUnit = 'px' | 'deg' | 'ratio' | 'none'

/** The value kind a descriptor exposes. Inferred from the zod type; `color` and `object` come from meta. */
export type PropType = 'number' | 'string' | 'boolean' | 'color' | 'object' | { enum: readonly string[] }

export interface PropMeta {
  label: string
  unit?: PropUnit
  /** Override the inferred type: a string that is a colour, an object blob. */
  type?: PropType
  /** Keyframes may drive it. */
  animatable?: boolean
  /** A cell expression may drive it. */
  bindable?: boolean
  tokenable?: readonly SupportedTokenType[]
  syncGroup?: ComponentSyncGroup
  range?: { min?: number; max?: number }
  /** Node key path when it differs from the field name: `layoutGap.rowGap`. */
  path?: string
  /** Declared so it can be named; nothing reads or writes it yet. */
  status?: 'stable' | 'planned'
}

export const propMeta = z.registry<PropMeta>()

/** Tag a field with its metadata. Returns the same schema, so `z.infer` is unchanged. */
export function prop<S extends z.ZodType>(schema: S, meta: PropMeta): S {
  propMeta.add(schema, meta)
  return schema
}
