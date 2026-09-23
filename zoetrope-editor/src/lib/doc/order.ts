/**
 * Sibling order is a fractional index: a string that sorts between its
 * neighbours, so a move touches one record.
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

/** A key strictly between `a` and `b`; `undefined` is the open end. */
export function orderBetween(a: string | undefined, b: string | undefined): string {
  return generateKeyBetween(a ?? null, b ?? null)
}

/** `n` keys strictly between `a` and `b`, ascending. */
export function ordersBetween(a: string | undefined, b: string | undefined, n: number): string[] {
  return generateNKeysBetween(a ?? null, b ?? null, n)
}

/** Keys for a list of `n` siblings laid out from scratch. */
export function initialOrders(n: number): string[] {
  return generateNKeysBetween(null, null, n)
}

/** The key that places a node at `index` among `siblings` (already sorted by order). */
export function orderAt(siblings: ReadonlyArray<string>, index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length))
  return orderBetween(siblings[i - 1], siblings[i])
}
