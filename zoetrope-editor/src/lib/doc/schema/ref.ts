/**
 * A reference is declared once, in the schema. The registry reads the
 * declaration; nothing else knows what a field points at.
 */
import { z } from 'zod'

export type Kind = 'page' | 'node'

/**
 * What a delete of the target does to the record holding the reference:
 * `cascade` deletes it too (ownership), `keep` leaves it and the reference
 * resolves to nothing.
 */
export type OnDelete = 'cascade' | 'keep'

export interface RefMeta {
  kind: Kind
  onDelete: OnDelete
}

export const refMeta = z.registry<RefMeta>()

export function ref(kind: Kind, onDelete: OnDelete = 'keep'): z.ZodString {
  const schema = z.string()
  refMeta.add(schema, { kind, onDelete })
  return schema
}

/** The registered schema under optional/nullable/default wrappers, if any. */
export function refMetaOf(schema: z.ZodType): RefMeta | undefined {
  let s: z.ZodType | undefined = schema
  while (s) {
    const meta = refMeta.get(s)
    if (meta) return meta
    const def: { innerType?: z.ZodType } | undefined = (s as { _zod?: { def?: { innerType?: z.ZodType } } })._zod?.def
    s = def?.innerType
  }
  return undefined
}
