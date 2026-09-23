import { z } from 'zod'
import type { PageId } from '../ids'

/** A page. Its nodes, cells, bindings and rules reference it; it holds no list of them. */
export const PageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  background: z.string().optional(),
  order: z.string(),
})

export interface Page {
  id: PageId
  name?: string
  background?: string
  order: string
}
