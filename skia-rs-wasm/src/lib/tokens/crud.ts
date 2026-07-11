/**
 * Token CRUD — create / modify / delete tokens, token sets, and themes on
 * `docProxy.meta.tokens`, plus active-theme (mode) switching.
 *
 * Every helper commits a redo change together with its exact inverse as the undo
 * change, through the Phase-1 doc-meta arm of `commitChanges` (which records the
 * pair in the unified history frame). So a single Cmd+Z reverts the edit and
 * Cmd+Shift+Z re-applies it.
 *
 * Value-changing ops (a token value/rename edit, a mode switch, set/theme
 * changes that alter what resolves) additionally fold **propagation** (P2.5)
 * into the SAME frame: re-resolve the lib-after (via the pure reducer, no proxy
 * mutation) and fan the new concrete values into every shape that references an
 * affected token. So one undo reverts the token edit AND every shape it touched.
 *
 * Resolution of values is P2.2; the concrete-prop writers are in ./materialize.
 */

import { snapshot } from 'valtio'
import type { Change } from 'penpot-exporter/types'
import { docProxy, type DocumentMeta } from '../renderer/store/doc-proxy'
import { commitChanges } from '../renderer/store/commit'
import { processDocMetaChanges, type DocMetaChange } from '../changes/doc-meta-change'
import { collectTokenPropagation } from './propagation'
import {
  createTokenSet,
  emptyTokensLib,
  type Token,
  type TokenSet,
  type TokenTheme,
  type TokensLib,
  type Uuid,
} from './types'

interface CommitOpts {
  /** Re-resolve and fan resolved values into referencing shapes, in this frame. */
  propagate?: boolean
  /** Token name remap (old→new) applied to shapes' appliedTokens on a rename. */
  renames?: Map<string, string>
}

/**
 * Commit a doc-meta token change, optionally folding propagation into the same
 * frame. Propagation resolves against the lib *after* the change (computed with
 * the pure reducer, without mutating the proxy), so the token change and the
 * shape rewrites land — and undo — atomically.
 */
async function commitTokenChange(
  redo: DocMetaChange[],
  undo: DocMetaChange[],
  opts?: CommitOpts,
): Promise<void> {
  let pageRedo: Change[] = []
  let pageUndo: Change[] = []

  if (opts?.propagate) {
    const metaNow = snapshot(docProxy).meta as DocumentMeta | undefined
    if (metaNow) {
      const metaAfter = processDocMetaChanges(metaNow as DocumentMeta, redo)
      const out = await collectTokenPropagation(metaAfter.tokens ?? emptyTokensLib(), opts.renames)
      pageRedo = out.redoChanges
      pageUndo = out.undoChanges
    }
  }

  await commitChanges({
    redoChanges: pageRedo,
    undoChanges: pageUndo,
    docMetaRedoChanges: redo,
    docMetaUndoChanges: undo,
  })
}

/** Current tokens lib off the live proxy (stable readonly snapshot). */
function currentLib(): TokensLib {
  return (snapshot(docProxy).meta?.tokens as TokensLib | undefined) ?? emptyTokensLib()
}

function findSet(setId: Uuid): TokenSet | undefined {
  return currentLib().sets.find((s) => s.id === setId) as TokenSet | undefined
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export async function addToken(setId: Uuid, token: Token): Promise<void> {
  // Adding may override another active set (or shadow within a set) → propagate.
  await commitTokenChange(
    [{ type: 'add-token', setId, token }],
    [{ type: 'del-token', setId, tokenId: token.id }],
    { propagate: true },
  )
}

export async function modifyToken(setId: Uuid, tokenId: Uuid, next: Token): Promise<void> {
  const prior = findSet(setId)?.tokens.find((t) => t.id === tokenId)
  if (!prior) return
  // Id is stable across a rename, so the inverse just restores the prior token.
  const renames = prior.name !== next.name ? new Map([[prior.name, next.name]]) : undefined
  await commitTokenChange(
    [{ type: 'mod-token', setId, token: next }],
    [{ type: 'mod-token', setId, token: prior as Token }],
    { propagate: true, renames },
  )
}

/** Move a token (by id) from one set to another — one atomic, undoable frame. */
export async function moveToken(fromSetId: Uuid, toSetId: Uuid, tokenId: Uuid): Promise<void> {
  if (fromSetId === toSetId) return
  const from = findSet(fromSetId)
  const index = from?.tokens.findIndex((t) => t.id === tokenId) ?? -1
  const token = index >= 0 ? (from!.tokens[index] as Token) : undefined
  if (!token) return
  await commitTokenChange(
    [
      { type: 'del-token', setId: fromSetId, tokenId },
      { type: 'add-token', setId: toSetId, token },
    ],
    [
      { type: 'del-token', setId: toSetId, tokenId },
      { type: 'add-token', setId: fromSetId, token, index },
    ],
    { propagate: true },
  )
}

export async function deleteToken(setId: Uuid, tokenId: Uuid): Promise<void> {
  const set = findSet(setId)
  const index = set?.tokens.findIndex((t) => t.id === tokenId) ?? -1
  if (!set || index < 0) return
  const prior = set.tokens[index] as Token
  await commitTokenChange(
    [{ type: 'del-token', setId, tokenId }],
    [{ type: 'add-token', setId, token: prior, index }],
    { propagate: true },
  )
}

// ── Sets ─────────────────────────────────────────────────────────────────────

export async function addTokenSet(set: TokenSet): Promise<void> {
  // A populated set may override names in other active sets → propagate.
  await commitTokenChange(
    [{ type: 'add-token-set', set }],
    [{ type: 'del-token-set', setId: set.id }],
    { propagate: true },
  )
}

export async function modifyTokenSet(setId: Uuid, next: TokenSet): Promise<void> {
  const prior = findSet(setId)
  if (!prior) return
  await commitTokenChange(
    [{ type: 'mod-token-set', setId, set: next }],
    [{ type: 'mod-token-set', setId, set: prior }],
    { propagate: true },
  )
}

export async function deleteTokenSet(setId: Uuid): Promise<void> {
  const sets = currentLib().sets
  const index = sets.findIndex((s) => s.id === setId)
  if (index < 0) return
  await commitTokenChange(
    [{ type: 'del-token-set', setId }],
    [{ type: 'add-token-set', set: sets[index] as TokenSet, index }],
    { propagate: true },
  )
}

// ── Themes / modes ───────────────────────────────────────────────────────────

export async function addTheme(theme: TokenTheme): Promise<void> {
  // A new theme isn't active yet → resolution unchanged.
  await commitTokenChange(
    [{ type: 'add-theme', theme }],
    [{ type: 'del-theme', id: theme.id }],
  )
}

export async function modifyTheme(id: Uuid, next: TokenTheme): Promise<void> {
  const prior = currentLib().themes.find((t) => t.id === id)
  if (!prior) return
  await commitTokenChange(
    [{ type: 'mod-theme', id, theme: next }],
    [{ type: 'mod-theme', id, theme: prior as TokenTheme }],
    { propagate: true },
  )
}

export async function deleteTheme(id: Uuid): Promise<void> {
  const lib = currentLib()
  const index = lib.themes.findIndex((t) => t.id === id)
  if (index < 0) return
  const prior = lib.themes[index] as TokenTheme
  const wasActive = lib.activeThemes.includes(id)

  const redo: DocMetaChange[] = []
  const undo: DocMetaChange[] = []
  // Drop it from the active set first (forward), restore it after re-adding (undo).
  if (wasActive) {
    redo.push({ type: 'set-active-themes', activeThemes: lib.activeThemes.filter((t) => t !== id) })
  }
  redo.push({ type: 'del-theme', id })
  undo.push({ type: 'add-theme', theme: prior, index })
  if (wasActive) {
    undo.push({ type: 'set-active-themes', activeThemes: [...lib.activeThemes] })
  }
  await commitTokenChange(redo, undo, { propagate: true })
}

export async function setActiveThemes(next: Uuid[]): Promise<void> {
  const prior = [...currentLib().activeThemes]
  await commitTokenChange(
    [{ type: 'set-active-themes', activeThemes: [...next] }],
    [{ type: 'set-active-themes', activeThemes: prior }],
    { propagate: true },
  )
}

/** First set's id, creating a default "Global" set if none exist. */
export async function ensureDefaultSet(): Promise<Uuid> {
  const sets = currentLib().sets
  if (sets.length) return sets[0].id
  const set = createTokenSet({ name: 'Global' })
  await addTokenSet(set)
  return set.id
}
