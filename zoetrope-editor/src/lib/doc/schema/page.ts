import { z } from 'zod'
import type { PageInteractions } from '../../renderer/interactions/ir'
import type { PageId } from '../ids'

/**
 * A page. Its nodes reference it (`node.page`); it holds no list of them.
 * `interactions` is the behaviour block until cells, bindings and rules become
 * records of their own.
 */
export const PageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  background: z.string().optional(),
  order: z.string(),
  interactions: z.custom<PageInteractions>().optional(),
})

export interface Page {
  id: PageId
  name?: string
  background?: string
  order: string
  interactions?: PageInteractions
}
