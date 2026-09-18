/**
 * Apply / detach a design token to a shape.
 *
 * The link lives at `node.appliedTokens[attr] = token-name` (Penpot's token
 * model), and the *resolved* concrete value is written into the normal shape
 * prop so the renderer — which never sees a token name — still has something to
 * draw. Both ride a single page change, so the value write and the appliedTokens
 * link undo/redo together as one frame. The concrete-prop writers live in
 * `./materialize` and are shared with propagation (P2.5).
 *
 * Undo note: `appliedTokens` is a top-level key that is usually *absent* before
 * the first apply. Page-change `assign` is a merge (it can't delete a key) and
 * the generic undo-snapshot omits absent keys — so we build the commit here with
 * an explicit `undoAssign` that resets `appliedTokens` to `{}` (and absent
 * scalar/array props to `undefined`) on undo.
 */

import { snapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { docProxy, getActiveOrSinglePageId } from '../renderer/store/doc-proxy'
import { getCommittedNodeOnActivePage } from '../renderer/properties/commit-node-properties'
import { appendModObjPair, emptyChangesBuilder, toCommitBundle } from '../changes/changes-builder'
import { commitChangesPublic } from '../page-crud'
import { materializeAttrWrites } from './materialize'
import { resolveTokens, type ResolvedToken } from './resolve'
import {
  canApplyTokenType,
  effectiveActiveTokens,
  emptyTokensLib,
  isSupportedTokenType,
  type SupportedTokenType,
  type Token,
  type TokenProperties,
  type TokensLib,
} from './types'

type AppliedTokens = NonNullable<PenpotNode['appliedTokens']>

/** Penpot's per-type default apply attrs (`token-properties[type].attributes`). */
const DEFAULT_ATTRS: Partial<Record<SupportedTokenType, TokenProperties[]>> = {
  color: ['fill'],
  typography: ['typography'],
  borderRadius: ['r1', 'r2', 'r3', 'r4'],
  opacity: ['opacity'],
  // dimension/sizing/spacing defaults (width/height/gaps) need resize/layout
  // application → deferred; apply via an explicit attr (e.g. strokeWidth) instead.
}

/** Attrs to apply when the caller doesn't pass an explicit set (panel "apply to selection"). */
export function defaultApplyAttrs(token: Token): TokenProperties[] {
  return isSupportedTokenType(token.type) ? DEFAULT_ATTRS[token.type] ?? [] : []
}

function currentLib(): TokensLib {
  return (snapshot(docProxy).meta?.tokens as TokensLib | undefined) ?? emptyTokensLib()
}

/**
 * Commit a token-driven node update as one undoable page change. `undoAssign`
 * is computed so that keys absent on `before` are cleared on undo (merge-based
 * assign can't delete a key): `appliedTokens` → `{}`, others → `undefined`.
 */
async function commitTokenNodeUpdate(
  nodeId: string,
  before: PenpotNode,
  partial: Partial<PenpotNode>,
): Promise<void> {
  const redoAssign: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) redoAssign[k] = v
  }
  const keys = Object.keys(redoAssign)
  if (keys.length === 0) return

  const rec = before as Record<string, unknown>
  const undoAssign: Record<string, unknown> = {}
  for (const k of keys) {
    const prior = rec[k]
    if (prior !== undefined) {
      undoAssign[k] = prior !== null && typeof prior === 'object' ? structuredClone(prior) : prior
    } else {
      undoAssign[k] = k === 'appliedTokens' ? {} : undefined
    }
  }

  const pid = getActiveOrSinglePageId() ?? undefined
  let builder = emptyChangesBuilder({ pageId: pid })
  builder = appendModObjPair(builder, pid, nodeId, { redoAssign, undoAssign })
  const bundle = toCommitBundle(builder)
  await commitChangesPublic({
    redoChanges: bundle.redoChanges,
    undoChanges: bundle.undoChanges,
    pageId: pid,
  })
}

/** Build the partial node update for applying `tokenName` to `attrs`, or null if nothing applies. */
function buildApplyPartial(
  before: PenpotNode,
  type: SupportedTokenType,
  tokenName: string,
  attrs: TokenProperties[],
  resolved: ResolvedToken,
): Partial<PenpotNode> | null {
  const appliable = attrs.filter((a) => canApplyTokenType(type, a))
  const { partial, written } = materializeAttrWrites(
    before,
    appliable.map((attr) => ({ attr, value: resolved.resolvedValue })),
  )
  if (written.size === 0) return null

  const applied: AppliedTokens = { ...(before.appliedTokens ?? {}) }
  for (const attr of written) applied[attr] = tokenName
  partial.appliedTokens = applied
  return partial
}

/**
 * Apply `tokenName` to `attrs` on `nodeId`. No-op when the token is missing,
 * resolves with errors, is an unsupported type, or none of the attrs apply.
 */
export async function applyToken(
  nodeId: string,
  tokenName: string,
  attrs: TokenProperties[],
): Promise<void> {
  const lib = currentLib()
  const token = effectiveActiveTokens(lib).get(tokenName)
  if (!token || !isSupportedTokenType(token.type)) return

  const resolved = (await resolveTokens(lib)).get(tokenName)
  if (!resolved || resolved.errors?.length || resolved.resolvedValue == null) return

  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return

  const partial = buildApplyPartial(before, token.type, tokenName, attrs, resolved)
  if (!partial) return

  await commitTokenNodeUpdate(nodeId, before, partial)
}

/**
 * Strip the given `appliedTokens` entries, keeping the concrete value. The map
 * is set to `{}` (not undefined) so the merge-based commit actually clears the
 * removed links.
 */
export async function detachToken(nodeId: string, attrs: TokenProperties[]): Promise<void> {
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  const current = before.appliedTokens
  if (!current) return

  const applied: AppliedTokens = { ...current }
  let changed = false
  for (const attr of attrs) {
    if (attr in applied) {
      delete applied[attr]
      changed = true
    }
  }
  if (!changed) return

  await commitTokenNodeUpdate(nodeId, before, { appliedTokens: applied } as Partial<PenpotNode>)
}
