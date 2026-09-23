import { NodeSchema, type Node } from './node'
import { PageSchema, type Page } from './page'
import {
  BindingSchema,
  CellSchema,
  RuleSchema,
  StoreSchema,
  TimelineSchema,
  type Binding,
  type Cell,
  type Rule,
  type ShapeMotion,
  type Store,
} from './behaviour'
import type { Kind } from './ref'

export { ref, refMeta, refMetaOf } from './ref'
export { KINDS } from './kinds'
export type { Kind, OnDelete, RefMeta } from './ref'
export { NodeSchema } from './node'
export type { Node } from './node'
export { PageSchema } from './page'
export type { Page } from './page'
export { CellSchema, BindingSchema, RuleSchema, TimelineSchema, StoreSchema } from './behaviour'
export type { Cell, Binding, Rule, ShapeMotion, Store } from './behaviour'

export const schemas = {
  page: PageSchema,
  node: NodeSchema,
  cell: CellSchema,
  binding: BindingSchema,
  rule: RuleSchema,
  timeline: TimelineSchema,
  store: StoreSchema,
} as const

export interface Records {
  page: Page
  node: Node
  cell: Cell
  binding: Binding
  rule: Rule
  timeline: ShapeMotion
  store: Store
}

export type RecordOf<K extends Kind> = Records[K]
export type AnyRecord = Records[Kind]
