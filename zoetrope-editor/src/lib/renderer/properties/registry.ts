/**
 * Property registry — runtime reflection over the drivable surface of a node.
 *
 * Identity is a descriptor id (`geometry.x`), never a label. Structure is
 * composition: a shape type is a list of bundles; a bundle is a zod object
 * whose fields carry `PropMeta`. Generic code (bindings, timelines, tokens,
 * codegen) receives a `PropId` and asks here how to read or write it. Code
 * that knows the node keeps using `node.x` directly.
 *
 * Bundles register once; a descriptor may be exposed by two bundles on
 * purpose, and two descriptors may share a label without meeting.
 */

import { z } from 'zod'
import type { PenpotNode } from 'penpot-exporter/types'
import type { ShapeType } from '../types'
import { propMeta, type PropMeta, type PropType } from './meta'

export type PropId = string & { readonly __brand: 'PropId' }
export type BundleId = string

export interface PropertyDef extends PropMeta {
  id: PropId
  bundle: BundleId
  /** The schema field name. */
  key: string
  type: PropType
}

export interface Accessor {
  get(node: PenpotNode): unknown
  /** Absent for channels and planned properties: nothing to write on the node. */
  set?(node: PenpotNode, value: unknown): Partial<PenpotNode>
}

export interface Property {
  def: PropertyDef
  accessor: Accessor
}

const bundles = new Map<BundleId, Property[]>()
const defs = new Map<PropId, PropertyDef>()
const shapes = new Map<ShapeType, BundleId[]>()

export function propId(id: string): PropId {
  return id as PropId
}

function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema
  for (;;) {
    const def = s.def as { type: string; innerType?: z.ZodType }
    if ((def.type === 'optional' || def.type === 'nullable' || def.type === 'default') && def.innerType) s = def.innerType
    else return s
  }
}

function inferType(schema: z.ZodType): PropType {
  const def = unwrap(schema).def as { type: string; entries?: Record<string, unknown> }
  switch (def.type) {
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'enum':
      return { enum: Object.keys(def.entries ?? {}) }
    default:
      return 'object'
  }
}

function readPath(node: unknown, path: string[]): unknown {
  let cur: unknown = node
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** Write along `path`, cloning each object on the way; returns the top-level partial. */
function writePath(node: unknown, path: string[], value: unknown): Partial<PenpotNode> {
  const [head, ...rest] = path
  if (rest.length === 0) return { [head]: value } as Partial<PenpotNode>
  const current = readPath(node, [head])
  const inner = writePath(current, rest, value)
  const base = current && typeof current === 'object' ? (current as object) : {}
  return { [head]: { ...base, ...inner } } as Partial<PenpotNode>
}

function derivedAccessor(path: string[]): Accessor {
  return {
    get: (n) => readPath(n, path),
    set: (n, v) => writePath(n, path, v),
  }
}

/**
 * Register a bundle from its schema. Every field must carry `prop()` meta.
 * `accessors` override the key-derived get/set for synthetic properties
 * (`fill` writes `fills`), or set `{ get }` only for channels.
 */
export function registerBundle(
  id: BundleId,
  schema: z.ZodObject,
  accessors: Partial<Record<string, Accessor>> = {},
): void {
  const props: Property[] = []
  for (const [key, field] of Object.entries(schema.shape)) {
    const meta = propMeta.get(field as z.ZodType)
    if (!meta) throw new Error(`property ${id}.${key} has no meta; wrap it with prop()`)
    const def: PropertyDef = {
      ...meta,
      id: propId(`${id}.${key}`),
      bundle: id,
      key,
      type: meta.type ?? inferType(field as z.ZodType),
    }
    const accessor = accessors[key] ?? derivedAccessor((meta.path ?? key).split('.'))
    props.push({ def, accessor })
    defs.set(def.id, def)
  }
  bundles.set(id, props)
}

export function registerShape(type: ShapeType, bundleIds: BundleId[]): void {
  for (const b of bundleIds) if (!bundles.has(b)) throw new Error(`shape ${type}: unknown bundle ${b}`)
  shapes.set(type, bundleIds)
}

export function bundlesOf(type: ShapeType): BundleId[] {
  return shapes.get(type) ?? []
}

export function getDef(id: string): PropertyDef | undefined {
  return defs.get(id as PropId)
}

export interface PropertyFilter {
  animatable?: boolean
  bindable?: boolean
  tokenable?: string
}

/** The properties a shape type exposes, in bundle order. */
export function propertiesOf(type: ShapeType, filter: PropertyFilter = {}): PropertyDef[] {
  const out: PropertyDef[] = []
  for (const b of bundlesOf(type)) {
    for (const { def } of bundles.get(b) ?? []) {
      if (filter.animatable !== undefined && !!def.animatable !== filter.animatable) continue
      if (filter.bindable !== undefined && !!def.bindable !== filter.bindable) continue
      if (filter.tokenable && !def.tokenable?.includes(filter.tokenable as never)) continue
      out.push(def)
    }
  }
  return out
}

/** How to read/write `id` on a node of `type`; undefined when the type lacks the bundle. */
export function resolve(type: ShapeType, id: string): Property | undefined {
  for (const b of bundlesOf(type)) {
    const p = bundles.get(b)?.find((x) => x.def.id === id)
    if (p) return p
  }
  return undefined
}

/** Every registered descriptor, for tooling and tests. */
export function listDefs(): PropertyDef[] {
  return [...defs.values()]
}

/** Test helper. */
export function resetProperties(): void {
  bundles.clear()
  defs.clear()
  shapes.clear()
}
