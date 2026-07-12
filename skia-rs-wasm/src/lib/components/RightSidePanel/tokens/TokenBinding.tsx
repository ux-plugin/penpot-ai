/**
 * Inline token binding for a right-panel property row (P2.8).
 *
 *  - Bound (`boundName` set): a locked pill — the property equals its token; to
 *    use a different value you Unlink. No drift (lock-when-bound decision).
 *  - Unbound: a "Link token" button that expands an inline picker of tokens of
 *    the row's type, plus "Create … from this value" (the bottom-up flow that
 *    used to live in the Assets panel).
 *
 * apply / detach / create all go through the P2.4 engine; values resolve via
 * `useResolvedTokens`. Icons are lucide Link2 / Unlink2.
 */

import { useState } from 'react'
import { Link2, Plus, Unlink2 } from 'lucide-react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../../../renderer/store/doc-proxy'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  createToken,
  effectiveActiveTokens,
  type SupportedTokenType,
  type TokenProperties,
  type TokensLib,
  type TokenValue,
} from '../../../tokens/types'
import { addToken, ensureDefaultSet } from '../../../tokens/crud'
import { applyToken, detachToken } from '../../../tokens/apply'
import { useResolvedTokens } from '../../../tokens/use-resolved-tokens'
import type { ResolvedToken } from '../../../tokens/resolve'

const NAME_PREFIX: Partial<Record<SupportedTokenType, string>> = {
  color: 'color',
  borderRadius: 'radius',
  opacity: 'opacity',
  dimension: 'dimension',
  typography: 'type',
}

interface Props {
  nodeId: string
  /** One attr, or several bound together (e.g. all four corner radii). */
  attr: TokenProperties | TokenProperties[]
  tokenType: SupportedTokenType
  /** Current concrete value of the property — enables "create token from this value". */
  currentValue?: string | number
  /** Applied token name on this attr, when bound. */
  boundName?: string
  /** Caption for the unbound "Link …" button (defaults to "token"). */
  label?: string
}

/** Concrete value → a token value string, or null if it can't seed a token. */
function valueFromCurrent(type: SupportedTokenType, v: string | number | undefined): TokenValue | null {
  if (v == null) return null
  if (type === 'color') return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null
  if (type === 'typography') return null // composite create-from-value is deferred
  if (typeof v === 'number') return String(v)
  return /^-?\d*\.?\d+$/.test(String(v)) ? String(v) : null
}

function Swatch({ color }: { color?: string }) {
  if (!color) return null
  return (
    <span
      className="size-3.5 shrink-0 rounded border border-border"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

function display(type: SupportedTokenType, r?: ResolvedToken): { swatch?: string; text: string } {
  if (!r || r.errors?.length || r.resolvedValue == null) return { text: 'unresolved' }
  if (type === 'color') return { swatch: String(r.resolvedValue), text: String(r.resolvedValue) }
  if (type === 'typography') {
    const m = r.resolvedValue as Record<string, string>
    return { text: [m.fontFamily, m.fontSize].filter(Boolean).join(' ') }
  }
  return { text: String(r.resolvedValue) }
}

export function TokenBinding({ nodeId, attr, tokenType, currentValue, boundName, label }: Props) {
  const doc = useSnapshot(docProxy)
  const lib = doc.meta?.tokens as TokensLib | undefined
  const resolved = useResolvedTokens()
  const [open, setOpen] = useState(false)
  const attrs = Array.isArray(attr) ? attr : [attr]
  const primaryAttr = attrs[0]

  // ── Bound: locked pill ─────────────────────────────────────────────────────
  if (boundName) {
    const d = display(tokenType, resolved.get(boundName))
    return (
      <div
        className="flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
        data-token-bound={primaryAttr}
      >
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Swatch color={d.swatch} />
        <span className="min-w-0 flex-1 truncate font-medium" title={boundName}>
          {boundName}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{d.text}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label="Unlink token"
          title="Unlink — keeps the current value"
          onClick={() => void detachToken(nodeId, attrs)}
        >
          <Unlink2 />
        </Button>
      </div>
    )
  }

  // ── Unbound: link button + inline picker ───────────────────────────────────
  const candidates = lib
    ? [...effectiveActiveTokens(lib).values()].filter((t) => t.type === tokenType)
    : []
  const createValue = valueFromCurrent(tokenType, currentValue)

  const onPick = async (name: string) => {
    setOpen(false)
    await applyToken(nodeId, name, attrs)
  }

  const onCreate = async () => {
    if (createValue == null) return
    setOpen(false)
    const prefix = NAME_PREFIX[tokenType] ?? tokenType
    const count = lib
      ? lib.sets.reduce(
          (n, s) => n + s.tokens.filter((t) => t.type === tokenType).length,
          0,
        )
      : 0
    const name = `${prefix}.${count + 1}`
    const setId = await ensureDefaultSet()
    await addToken(setId, createToken({ name, type: tokenType, value: createValue }))
    await applyToken(nodeId, name, attrs)
  }

  return (
    <div data-token-link={primaryAttr}>
      <button
        type="button"
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
          open && 'text-foreground',
        )}
        aria-expanded={open}
        aria-label="Link to token"
        onClick={() => setOpen((o) => !o)}
      >
        <Link2 className="size-3.5" aria-hidden />
        Link {label ?? 'token'}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border">
          <div className="px-2 py-1 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Apply {tokenType} token
          </div>
          <ul className="list-none p-0">
            {candidates.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No {tokenType} tokens yet</li>
            )}
            {candidates.map((t) => {
              const d = display(tokenType, resolved.get(t.name))
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                    onClick={() => void onPick(t.name)}
                    title={`Apply ${t.name}`}
                  >
                    <Swatch color={d.swatch} />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{d.text}</span>
                  </button>
                </li>
              )
            })}
            {createValue != null && (
              <li className="border-t border-border">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/60"
                  onClick={() => void onCreate()}
                >
                  <Plus className="size-3.5" aria-hidden />
                  Create {tokenType} token from this value
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
