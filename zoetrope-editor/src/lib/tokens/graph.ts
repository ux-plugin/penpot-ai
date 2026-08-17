/**
 * Alias graph over the tokens lib — the read-model behind the editor's
 * reference picker and "used by" list.
 *
 * A token's value can be an alias (`{color.blue.500}`) that points at another
 * token *by name*. Those references form a directed graph across sets. This
 * module builds two indexes from it:
 *
 *   - `targetOf`  name → the single name it aliases (first occurrence wins, to
 *                 match resolution which takes the first token of a name).
 *   - `usedBy`    name → the names that reference it (reverse index).
 *
 * plus `createsCycle`, which the reference picker uses to grey out targets that
 * would introduce a loop (a token may not, directly or transitively, alias
 * itself — the resolver treats a cycle as an error).
 *
 * Scope: scalar aliases only. Composite typography sub-field aliases are not
 * indexed here (v1) — `tokenAliasName` returns null for object values.
 */

import { tokenAliasName, type TokensLib } from './types'

export interface AliasIndex {
  /** name → the name it aliases (if any). */
  targetOf: Map<string, string>
  /** name → names that alias it. */
  usedBy: Map<string, string[]>
}

export function buildAliasIndex(lib: TokensLib | undefined): AliasIndex {
  const targetOf = new Map<string, string>()
  const usedBy = new Map<string, string[]>()
  for (const set of lib?.sets ?? []) {
    for (const t of set.tokens) {
      const target = tokenAliasName(t.value)
      if (!target) continue
      if (!targetOf.has(t.name)) targetOf.set(t.name, target)
      const refs = usedBy.get(target) ?? []
      if (!refs.includes(t.name)) refs.push(t.name)
      usedBy.set(target, refs)
    }
  }
  return { targetOf, usedBy }
}

/** Names that reference `name`, sorted for stable display. */
export function usedByNames(index: AliasIndex, name: string): string[] {
  return [...(index.usedBy.get(name) ?? [])].sort()
}

/** Follow the alias chain from `start`; true if it reaches `goal`. */
export function reaches(targetOf: Map<string, string>, start: string, goal: string): boolean {
  let cur: string | undefined = start
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === goal) return true
    seen.add(cur)
    cur = targetOf.get(cur)
  }
  return false
}

/**
 * True if pointing `fromName` at `candidate` would create a cycle — i.e. the
 * candidate is the token itself, or already reaches back to it through aliases.
 */
export function createsCycle(
  targetOf: Map<string, string>,
  fromName: string,
  candidate: string,
): boolean {
  return candidate === fromName || reaches(targetOf, candidate, fromName)
}
