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

export interface RefShape extends RefMeta {
  /** The field holds a list of ids. */
  many: boolean
}

export const refMeta = z.registry<RefMeta>()

export function ref(kind: Kind, onDelete: OnDelete = 'keep'): z.ZodString {
  const schema = z.string()
  refMeta.add(schema, { kind, onDelete })
  return schema
}

/** A list of references to `kind`. */
export function refs(kind: Kind, onDelete: OnDelete = 'keep'): z.ZodArray<z.ZodString> {
  return z.array(ref(kind, onDelete))
}

type Def = { innerType?: z.ZodType; element?: z.ZodType; type?: string }

/** The reference a field declares, through optional/nullable/default wrappers and one array. */
export function refMetaOf(schema: z.ZodType): RefShape | undefined {
  let s: z.ZodType | undefined = schema
  let many = false
  while (s) {
    const meta = refMeta.get(s)
    if (meta) return { ...meta, many }
    const def: Def | undefined = (s as { _zod?: { def?: Def } })._zod?.def
    if (def?.type === 'array' && !many) {
      many = true
      s = def.element
    } else s = def?.innerType
  }
  return undefined
}
