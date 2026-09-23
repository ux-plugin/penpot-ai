/**
 * The one place reference semantics are read from. Built by walking the
 * schemas once; nothing per feature.
 */
import type { z } from 'zod'
import { schemas, refMetaOf, type Kind, type OnDelete, type AnyRecord } from './schema'

export interface RefField {
  field: string
  kind: Kind
  onDelete: OnDelete
}

const fieldsByKind = new Map<Kind, RefField[]>()

/** The reference fields a kind declares. */
export function refFields(kind: Kind): readonly RefField[] {
  let fields = fieldsByKind.get(kind)
  if (fields) return fields
  fields = []
  const shape = (schemas[kind] as z.ZodObject).shape as Record<string, z.ZodType>
  for (const [field, schema] of Object.entries(shape)) {
    const meta = refMetaOf(schema)
    if (meta) fields.push({ field, kind: meta.kind, onDelete: meta.onDelete })
  }
  fieldsByKind.set(kind, fields)
  return fields
}

export interface Ref {
  field: string
  kind: Kind
  id: string
}

/** Every reference a record holds. */
export function refsOf(kind: Kind, record: AnyRecord): Ref[] {
  const out: Ref[] = []
  for (const f of refFields(kind)) {
    const id = (record as Record<string, unknown>)[f.field]
    if (typeof id === 'string') out.push({ field: f.field, kind: f.kind, id })
  }
  return out
}

/** Fields of `kind` whose target's delete cascades to the record. */
export function cascadeFields(kind: Kind): readonly RefField[] {
  return refFields(kind).filter((f) => f.onDelete === 'cascade')
}

export const kinds = Object.keys(schemas) as Kind[]
