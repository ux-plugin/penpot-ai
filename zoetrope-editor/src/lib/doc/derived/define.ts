/**
 * An index over the tables that the reducer keeps current. `rebuild` runs
 * after a load, `update` after each applied change, in registration order.
 * Nothing outside `derived/` builds an index.
 */
import type { Applied } from '../apply'
import type { Tables } from '../store'

export interface Derived {
  rebuild(t: Tables): void
  update(t: Tables, applied: readonly Applied[]): void
}

const all: Derived[] = []

export function derived<D extends Derived>(d: D): D {
  all.push(d)
  return d
}

export function rebuildAll(t: Tables): void {
  for (const d of all) d.rebuild(t)
}

export function updateAll(t: Tables, applied: readonly Applied[]): void {
  for (const d of all) d.update(t, applied)
}
