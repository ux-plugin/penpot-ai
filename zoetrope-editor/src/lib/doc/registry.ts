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
  /** The field holds a list of ids. */
  many: boolean
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
    if (meta) fields.push({ field, kind: meta.kind, onDelete: meta.onDelete, many: meta.many })
  }
  fieldsByKind.set(kind, fields)
  return fields
}

export interface Ref {
  field: string
  kind: Kind
  id: string
}

/** The ids a field of `record` holds: none, one, or a list. */
export function idsIn(record: AnyRecord | undefined, field: string): readonly string[] {
  const v = (record as Record<string, unknown> | undefined)?.[field]
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return NONE
}

const NONE: readonly string[] = Object.freeze([])

/** Every reference a record holds. */
export function refsOf(kind: Kind, record: AnyRecord): Ref[] {
  const out: Ref[] = []
  for (const f of refFields(kind)) for (const id of idsIn(record, f.field)) out.push({ field: f.field, kind: f.kind, id })
  return out
}

/**
 * `record` with every reference found in `map` rewritten to its new id.
 * References outside the map are kept. Copy, paste, instantiate.
 */
export function remap<R extends AnyRecord>(kind: Kind, record: R, map: ReadonlyMap<string, string>): R {
  const src = record as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const f of refFields(kind)) {
    const v = src[f.field]
    if (typeof v === 'string') {
      const n = map.get(v)
      if (n !== undefined) (out ??= { ...src })[f.field] = n
    } else if (Array.isArray(v) && v.some((x) => map.has(x))) {
      ;(out ??= { ...src })[f.field] = v.map((x) => map.get(x) ?? x)
    }
  }
  return (out as R | null) ?? record
}

/** Fields of `kind` whose target's delete cascades to the record. */
export function cascadeFields(kind: Kind): readonly RefField[] {
  return refFields(kind).filter((f) => f.onDelete === 'cascade')
}

export const kinds = Object.keys(schemas) as Kind[]
