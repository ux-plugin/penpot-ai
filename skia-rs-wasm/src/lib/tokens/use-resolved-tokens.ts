/**
 * Shared token resolution for React UI. Both the Tokens panel and the right-rail
 * inline token controls need the resolved value of every live token (swatches,
 * the bound-token pill's value, picker previews).
 *
 * Resolves the effective active tokens (active theme's sets, or all sets when no
 * theme is active). `extraSetId` force-includes one set so the Tokens panel can
 * preview a set it's editing even when that set isn't active.
 *
 * Async (style-dictionary); re-resolves whenever the tokens subtree changes.
 */

import { useEffect, useState } from 'react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../renderer/store/doc-proxy'
import { resolveTokenMap, type ResolvedTokens } from './resolve'
import { effectiveActiveTokens, type TokensLib } from './types'

export function useResolvedTokens(extraSetId?: string): ResolvedTokens {
  const doc = useSnapshot(docProxy)
  const lib = doc.meta?.tokens as TokensLib | undefined
  const [resolved, setResolved] = useState<ResolvedTokens>(() => new Map())

  useEffect(() => {
    if (!lib) return
    const merged = new Map(effectiveActiveTokens(lib))
    if (extraSetId) {
      const sel = lib.sets.find((s) => s.id === extraSetId)
      const seen = new Set<string>()
      for (const t of sel?.tokens ?? []) {
        if (seen.has(t.name)) continue
        seen.add(t.name)
        merged.set(t.name, t)
      }
    }
    let cancelled = false
    void resolveTokenMap(merged).then((r) => {
      if (!cancelled) setResolved(r)
    })
    return () => {
      cancelled = true
    }
  }, [lib, extraSetId])

  return resolved
}
