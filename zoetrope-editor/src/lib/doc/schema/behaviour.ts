import { z } from 'zod'
import type { Action, Expr, Json, Persistence, Trigger, ValueType } from '../../renderer/interactions/ir'
import type { Timeline } from '../../renderer/anim/types'
import type { NodeId, PageId } from '../ids'
import { ref } from './ref'

/**
 * A cell: the one kind of state. Where it lives is its references:
 * a node's cell has `node` (and that node's `page`), a page's cell has `page`
 * only, a document cell has neither. `name` is what expressions print;
 * identity is `id`, so a rename touches nothing else.
 */
export const CellSchema = z.object({
  id: z.string(),
  name: z.string(),
  page: ref('page', 'cascade').optional(),
  node: ref('node', 'cascade').optional(),
  type: z.custom<ValueType>(),
  initial: z.custom<Json>(),
  formula: z.custom<Expr>().optional(),
  store: ref('store').optional(),
  description: z.string().optional(),
  persist: z.custom<Persistence>().optional(),
})

export interface Cell {
  id: string
  name: string
  page?: PageId
  node?: NodeId
  type: ValueType
  /** The starting value; the sample, for a store cell. Ignored by a formula. */
  initial: Json
  /** Present: computed, read-only. */
  formula?: Expr
  /** The store the value is supplied from. */
  store?: string
  /** Prose for a store cell: what real value this is. */
  description?: string
  persist?: Persistence
}

/**
 * A node property that reads cells instead of holding a literal. `repeat`
 * repeats the node over a list, with `item` naming and keying the instances;
 * `value` on a bare writable cell makes the node edit that cell.
 */
export const BindingSchema = z.object({
  id: z.string(),
  page: ref('page', 'cascade'),
  node: ref('node', 'cascade'),
  prop: z.string(),
  expr: z.custom<Expr>(),
  item: z.custom<{ as?: string; key?: Expr }>().optional(),
})

export interface Binding {
  id: string
  page: PageId
  node: NodeId
  prop: string
  expr: Expr
  item?: { as?: string; key?: Expr }
}

/**
 * A rule: a trigger, a guard, actions. On a node when `node` is set, on the
 * page otherwise (load, timer, key). `order` is a fractional index: rules on
 * one trigger run in this order.
 */
export const RuleSchema = z.object({
  id: z.string(),
  page: ref('page', 'cascade'),
  node: ref('node', 'cascade').optional(),
  order: z.string(),
  on: z.custom<Trigger>(),
  if: z.custom<Expr>().optional(),
  do: z.custom<Action[]>(),
})

export interface Rule {
  id: string
  page: PageId
  node?: NodeId
  order: string
  on: Trigger
  if?: Expr
  do: Action[]
}

/** One node's motion: an animation timeline plus the time whose pose is its rest. */
export const TimelineSchema = z.object({
  id: z.string(),
  node: ref('node', 'cascade'),
  timeline: z.custom<Timeline>(),
  restFrame: z.number(),
})

export interface ShapeMotion {
  id: string
  node: NodeId
  timeline: Timeline
  /** The time (ms) whose pose is the node's rest. */
  restFrame: number
}

/**
 * A named container of cells supplied from outside: the seam a real database
 * or API binds to at handover. `id` is the name cells and people use.
 */
export const StoreSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
})

export interface Store {
  id: string
  /** What real data the store maps to, for whoever binds it. */
  description?: string
}
