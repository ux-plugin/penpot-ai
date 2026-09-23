/**
 * Token propagation (P2.5).
 *
 * When a token's resolved value changes (a value edit, a theme/mode switch, a
 * set add/remove that overrides names), every shape whose `appliedTokens`
 * reference an affected token needs its concrete prop rewritten — the renderer
 * only ever sees concrete values, never token names.
 *
 * This is NOT a signal graph. It's a materialize-and-fan-out pass (mirrors
 * Penpot's `propagate-tokens`): re-resolve the active graph, walk every node in
 * the document, and for each token-bearing node recompute the concrete value
 * from the resolver and emit a `mod` — but only when the value actually changed
 * (diffed, so the frame is proportional to *affected* shapes, not total shapes).
 * Aliasing is handled for free: editing `color.base` re-resolves
 * `color.fg = {color.base}`, so its shapes update too.
 *
 * The returned changes are folded into the SAME commit frame as the triggering
 * token change (see crud.ts), so one Cmd+Z reverts the token edit and every
 * shape it touched.
 */

import { mod, records, type Change, type Node } from '../doc'
import { materializeAttrWrites, type AttrWrite } from './materialize'
import { resolveTokens } from './resolve'
import type { TokenProperties, TokensLib } from './types'
import type { Material } from '../renderer/api/material'
import { rematerializeStoredUniform } from '../components/RightSidePanel/material-token'

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
): Promise<Change[]> {
  const resolved = await resolveTokens(libAfter)
  const out: Change[] = []

  for (const shape of records('node')) {
    // A shape participates if it applies tokens to attrs OR binds a token in a
    // shader-material uniform — the two live in different places.
    const applied: Record<string, string> = shape.appliedTokens ?? {}

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

    const { partial } = materializeAttrWrites(shape, writes)

    // Diff: only emit keys whose value actually changed.
    const set: Record<string, unknown> = {}
    const rec = shape as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(partial)) {
      if (!jsonEqual(v, rec[k])) set[k] = v
    }
    if (appliedChanged && !jsonEqual(appliedNext, applied)) set.appliedTokens = appliedNext

    // Material-uniform token bindings live on `material.uniforms[].token`, not
    // `appliedTokens`. Re-materialize them here so a token/theme edit reaches a
    // shape whose shader binds a token even with NO editor open (the editor's
    // own re-materialize effect covers only the open case). Folds into the
    // same `mod` as any attr writes, so one Cmd+Z reverts everything.
    const mat = (shape as { material?: Material }).material
    if (mat?.uniforms?.some((u) => u.token)) {
      let matChanged = false
      const nextUniforms = mat.uniforms.map((u) => {
        if (!u.token) return u
        const effToken = renames?.get(u.token) ?? u.token
        const nextVal = rematerializeStoredUniform(u.value, resolved.get(effToken))
        const next = { ...u, token: effToken, ...(nextVal ? { value: nextVal } : {}) }
        if (!jsonEqual(next, u)) matChanged = true
        return next
      })
      if (matChanged) set.material = { ...mat, uniforms: nextUniforms }
    }

    if (Object.keys(set).length === 0) continue
    out.push(mod('node', shape.id, set as Partial<Node>))
  }

  return out
}
