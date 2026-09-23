/**
 * Apply / detach a design token to a shape.
 *
 * The link lives at `node.appliedTokens[attr] = token-name` (Penpot's token
 * model), and the *resolved* concrete value is written into the normal shape
 * prop so the renderer — which never sees a token name — still has something to
 * draw. Both ride a single change, so the value write and the appliedTokens
 * link undo/redo together as one frame. The concrete-prop writers live in
 * `./materialize` and are shared with propagation (P2.5).
 */

import type { PenpotNode } from 'penpot-exporter/types'
import { getNode, meta, mod, type Node } from '../doc'
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
  return meta.peek()?.tokens ?? emptyTokensLib()
}

/** Commit a token-driven node update as one undoable change. */
async function commitTokenNodeUpdate(nodeId: string, partial: Partial<PenpotNode>): Promise<void> {
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) set[k] = v
  }
  if (Object.keys(set).length === 0) return
  await commitChangesPublic({ changes: [mod('node', nodeId, set as Partial<Node>)] })
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

  const before = getNode(nodeId)
  if (!before) return

  const partial = buildApplyPartial(before, token.type, tokenName, attrs, resolved)
  if (!partial) return

  await commitTokenNodeUpdate(nodeId, partial)
}

/**
 * Strip the given `appliedTokens` entries, keeping the concrete value. The map
 * is set to `{}` (not undefined) so the merge-based commit actually clears the
 * removed links.
 */
export async function detachToken(nodeId: string, attrs: TokenProperties[]): Promise<void> {
  const before = getNode(nodeId)
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

  await commitTokenNodeUpdate(nodeId, { appliedTokens: applied } as Partial<PenpotNode>)
}
