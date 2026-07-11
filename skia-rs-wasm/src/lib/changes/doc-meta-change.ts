/**
 * Editor-local change variants that target `docProxy.meta` (the document-level
 * shared library state — paint styles, text styles) rather than a specific page.
 *
 * The vendored exporter `Change` union (`add-obj | mod-obj | del-obj | ...`) is
 * strictly page-scoped: every variant carries a `pageId` and every reducer in
 * `process-changes.ts` mutates an `IndexedPage.objects`. There is no way to
 * express "edit document-level metadata" in that union without polluting it.
 *
 * Instead, this module defines a parallel `DocMetaChange` union that the commit
 * pipeline ferries alongside the page `Change[]`. Both are applied in the same
 * commit (so a sync — "user edited a color style, fan out to N pages" — lands
 * as one history frame), but the doc-meta arm mutates `docProxy.meta` directly
 * and the renderer-sync subscriber ignores it (no shape geometry to push).
 */

import type { Uuid } from 'penpot-exporter/types'
import type { DocumentMeta } from '../renderer/store/doc-proxy'
import { emptyTokensLib } from '../tokens/types'
import type { Token, TokenSet, TokenTheme, TokensLib } from '../tokens/types'

// ── Design-token variants (P2.3) ─────────────────────────────────────────────

export interface AddTokenChange {
  type: 'add-token'
  setId: Uuid
  token: Token
  /** Restore position for undo-of-delete; appended when omitted. */
  index?: number
}
export interface ModTokenChange {
  type: 'mod-token'
  setId: Uuid
  /** Replaces the token with this `token.id` (rename is just a name change). */
  token: Token
}
export interface DelTokenChange {
  type: 'del-token'
  setId: Uuid
  tokenId: Uuid
}
export interface AddTokenSetChange {
  type: 'add-token-set'
  set: TokenSet
  /** Restore position for undo-of-delete; appended when omitted. */
  index?: number
}
export interface ModTokenSetChange {
  type: 'mod-token-set'
  setId: Uuid
  set: TokenSet
}
export interface DelTokenSetChange {
  type: 'del-token-set'
  setId: Uuid
}
export interface AddThemeChange {
  type: 'add-theme'
  theme: TokenTheme
  index?: number
}
export interface ModThemeChange {
  type: 'mod-theme'
  id: Uuid
  theme: TokenTheme
}
export interface DelThemeChange {
  type: 'del-theme'
  id: Uuid
}
export interface SetActiveThemesChange {
  type: 'set-active-themes'
  activeThemes: Uuid[]
}

export type DocMetaChange =
  | AddTokenChange
  | ModTokenChange
  | DelTokenChange
  | AddTokenSetChange
  | ModTokenSetChange
  | DelTokenSetChange
  | AddThemeChange
  | ModThemeChange
  | DelThemeChange
  | SetActiveThemesChange

// Immutable helpers for the token arm — never mutate the input lib/set.
function withTokens(meta: DocumentMeta, fn: (lib: TokensLib) => TokensLib): DocumentMeta {
  return { ...meta, tokens: fn(meta.tokens ?? emptyTokensLib()) }
}

function mapSetById(lib: TokensLib, setId: Uuid, fn: (set: TokenSet) => TokenSet): TokensLib {
  let found = false
  const sets = lib.sets.map((s) => {
    if (s.id !== setId) return s
    found = true
    return fn(s)
  })
  return found ? { ...lib, sets } : lib
}

/** Pure reducer. Returns the new meta; never mutates input. */
export function processDocMetaChange(
  meta: DocumentMeta,
  change: DocMetaChange,
): DocumentMeta {
  switch (change.type) {
    case 'add-token':
      return withTokens(meta, (lib) =>
        mapSetById(lib, change.setId, (set) => {
          const tokens = [...set.tokens]
          tokens.splice(change.index ?? tokens.length, 0, change.token)
          return { ...set, tokens }
        }),
      )
    case 'mod-token':
      // Replace by id — names are not unique (duplicates are allowed).
      return withTokens(meta, (lib) =>
        mapSetById(lib, change.setId, (set) => ({
          ...set,
          tokens: set.tokens.map((t) => (t.id === change.token.id ? change.token : t)),
        })),
      )
    case 'del-token':
      return withTokens(meta, (lib) =>
        mapSetById(lib, change.setId, (set) => ({
          ...set,
          tokens: set.tokens.filter((t) => t.id !== change.tokenId),
        })),
      )
    case 'add-token-set':
      return withTokens(meta, (lib) => {
        const sets = [...lib.sets]
        sets.splice(change.index ?? sets.length, 0, change.set)
        return { ...lib, sets }
      })
    case 'mod-token-set':
      return withTokens(meta, (lib) => ({
        ...lib,
        sets: lib.sets.map((s) => (s.id === change.setId ? change.set : s)),
      }))
    case 'del-token-set':
      return withTokens(meta, (lib) => ({
        ...lib,
        sets: lib.sets.filter((s) => s.id !== change.setId),
      }))
    case 'add-theme':
      return withTokens(meta, (lib) => {
        const themes = [...lib.themes]
        themes.splice(change.index ?? themes.length, 0, change.theme)
        return { ...lib, themes }
      })
    case 'mod-theme':
      return withTokens(meta, (lib) => ({
        ...lib,
        themes: lib.themes.map((t) => (t.id === change.id ? change.theme : t)),
      }))
    case 'del-theme':
      // Pure removal from the theme list; activeThemes is managed explicitly by
      // the deleteTheme helper so this op stays cleanly invertible.
      return withTokens(meta, (lib) => ({
        ...lib,
        themes: lib.themes.filter((t) => t.id !== change.id),
      }))
    case 'set-active-themes':
      return withTokens(meta, (lib) => ({ ...lib, activeThemes: [...change.activeThemes] }))
    default: {
      const _exhaustive: never = change
      void _exhaustive
      return meta
    }
  }
}

export function processDocMetaChanges(
  meta: DocumentMeta,
  changes: readonly DocMetaChange[],
): DocumentMeta {
  let next = meta
  for (const c of changes) next = processDocMetaChange(next, c)
  return next
}
