/**
 * Token propagation (P2.5).
 *
 * When a token's resolved value changes (a value edit, a theme/mode switch, a
 * set add/remove that overrides names), every shape whose `appliedTokens`
 * reference an affected token needs its concrete prop rewritten — the renderer
 * only ever sees concrete values, never token names.
 *
 * This is NOT a signal graph. It's a materialize-and-fan-out pass (mirrors
 * Penpot's `propagate-tokens`): re-resolve the active graph, walk every shape on
 * every page, and for each token-bearing shape recompute the concrete value from
 * the resolver and emit a per-page `mod-obj` redo/undo pair — but only when the
 * value actually changed (diffed, so the frame is proportional to *affected*
 * shapes, not total shapes). Aliasing is handled for free: editing `color.base`
 * re-resolves `color.fg = {color.base}`, so its shapes update too.
 *
 * The returned `{redoChanges, undoChanges}` are folded into the SAME commit
 * frame as the triggering token change (see crud.ts), so one Cmd+Z reverts the
 * token edit and every shape it touched.
 */

import { snapshot } from 'valtio'
import type { Change, ModObjChange, PenpotNode } from 'penpot-exporter/types'
import { docProxy } from '../renderer/store/doc-proxy'
import { materializeAttrWrites, type AttrWrite } from './materialize'
import { resolveTokens } from './resolve'
import type { TokenProperties, TokensLib } from './types'

function buildModObj(pageId: string, id: string, assign: Record<string, unknown>): ModObjChange {
  return { type: 'mod-obj', id, pageId, operations: [{ type: 'assign', value: assign }] }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Re-resolve `libAfter` and fan resolved values into every shape that references
 * a token. `renames` (old→new name) is applied to `appliedTokens` so a token
 * rename keeps shapes linked instead of orphaning them.
 */
export async function collectTokenPropagation(
  libAfter: TokensLib,
  renames?: Map<string, string>,
): Promise<{ redoChanges: Change[]; undoChanges: Change[] }> {
  const resolved = await resolveTokens(libAfter)
  const redo: Change[] = []
  const undo: Change[] = []
  const docSnap = snapshot(docProxy)

  for (const [pageId, page] of docSnap.pageMap) {
    for (const id of Object.keys(page.objects)) {
      const shape = page.objects[id] as PenpotNode & { appliedTokens?: Record<string, string> }
      const applied = shape.appliedTokens
      if (!applied || Object.keys(applied).length === 0) continue

      const writes: AttrWrite[] = []
      const appliedNext: Record<string, string> = { ...applied }
      let appliedChanged = false

      for (const [attr, name] of Object.entries(applied)) {
        const effName = renames?.get(name) ?? name
        if (effName !== name) {
          appliedNext[attr] = effName
          appliedChanged = true
        }
        const r = resolved.get(effName)
        // Missing / error-resolved tokens are left dangling (value untouched).
        if (!r || r.errors?.length || r.resolvedValue == null) continue
        writes.push({ attr: attr as TokenProperties, value: r.resolvedValue })
      }

      const { partial } = materializeAttrWrites(shape as PenpotNode, writes)

      // Diff: only emit keys whose value actually changed.
      const redoAssign: Record<string, unknown> = {}
      const undoAssign: Record<string, unknown> = {}
      const rec = shape as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(partial)) {
        if (!jsonEqual(v, rec[k])) {
          redoAssign[k] = v
          undoAssign[k] = rec[k] === undefined ? undefined : structuredClone(rec[k])
        }
      }
      if (appliedChanged && !jsonEqual(appliedNext, applied)) {
        redoAssign.appliedTokens = appliedNext
        undoAssign.appliedTokens = { ...applied }
      }
      if (Object.keys(redoAssign).length === 0) continue

      redo.push(buildModObj(pageId, id, redoAssign))
      // Prepend so replay-in-array-order matches reverse-order-of-redo.
      undo.unshift(buildModObj(pageId, id, undoAssign))
    }
  }

  return { redoChanges: redo, undoChanges: undo }
}
