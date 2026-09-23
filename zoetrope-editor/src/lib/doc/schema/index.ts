import { NodeSchema, type Node } from './node'
import { PageSchema, type Page } from './page'
import type { Kind } from './ref'

export { ref, refMeta, refMetaOf } from './ref'
export type { Kind, OnDelete, RefMeta } from './ref'
export { NodeSchema } from './node'
export type { Node } from './node'
export { PageSchema } from './page'
export type { Page } from './page'

export const schemas = {
  page: PageSchema,
  node: NodeSchema,
} as const

export interface Records {
  page: Page
  node: Node
}

export type RecordOf<K extends Kind> = Records[K]
export type AnyRecord = Records[Kind]
