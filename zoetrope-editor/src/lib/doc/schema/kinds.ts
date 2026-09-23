/** Every record kind, in load order: owners before what they own. */
export const KINDS = ['page', 'node', 'store', 'cell', 'binding', 'rule', 'timeline'] as const

export type Kind = (typeof KINDS)[number]
