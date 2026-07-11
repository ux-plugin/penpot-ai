/**
 * Tokens table overlay (P2.7c) — a Figma-Variables-style matrix that floats over
 * the editor as a top layer (portal to <body>). It's a second *view* over the
 * same data the rail edits, not a new data type:
 *
 *   rows    = token names, grouped by type
 *   columns = sets (= modes); the live ones (active theme, or all when none) are
 *             tinted, so you can see at a glance which column the canvas resolves
 *   cell    = that token's authored value in that set. An empty cell means the
 *             set doesn't define the name, so it "inherits" from another set.
 *
 * Editing a cell, adding an override (empty cell → `add`), removing one, or
 * adding a set column all route through the P2.3 CRUD, so every change still
 * propagates to bound shapes and lands in one undo frame — identical to the rail.
 *
 * The rail stays the place to create token *names*, edit descriptions, and author
 * composite typography (which doesn't fit a one-line cell — those cells are
 * read-only here). Opened from the Tokens tab; closed with Esc / backdrop / ✕.
 */

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  createToken,
  createTokenSet,
  effectiveActiveSets,
  findToken,
  SUPPORTED_TOKEN_TYPES,
  type SupportedTokenType,
  type Token,
  type TokenSet,
  type TokensLib,
  type TokenValue,
} from '../../tokens/types'
import { addToken, addTokenSet, deleteToken, modifyToken } from '../../tokens/crud'

const TYPE_LABEL: Record<SupportedTokenType, string> = {
  color: 'Color',
  typography: 'Typography',
  dimension: 'Dimension',
  spacing: 'Spacing',
  sizing: 'Sizing',
  borderRadius: 'Border radius',
  opacity: 'Opacity',
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)
}

function isAlias(v: TokenValue): v is string {
  return typeof v === 'string' && /^\{.*\}$/.test(v)
}

/** One-line label for a cell's authored value. */
function authoredText(t: Token): string {
  if (t.type === 'typography') {
    const v = (typeof t.value === 'object' ? t.value : {}) as Record<string, string>
    return [v.fontFamily, [v.fontSize, v.fontWeight].filter(Boolean).join(' / ')]
      .filter(Boolean)
      .join(' ')
  }
  return typeof t.value === 'string' ? t.value : ''
}

/** Seed value for a brand-new override when no same-named token exists to copy. */
function seedValue(type: SupportedTokenType): TokenValue {
  if (type === 'typography') return {}
  if (type === 'color') return '#9CA3AF'
  if (type === 'opacity') return '1'
  return '0'
}

interface Props {
  lib: TokensLib | undefined
  onClose: () => void
}

export function TokensTableOverlay({ lib, onClose }: Props) {
  const [edit, setEdit] = useState<{ setId: string; name: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [newSet, setNewSet] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sets = useMemo(() => lib?.sets ?? [], [lib])
  const activeSetIds = useMemo(
    () => new Set((lib ? effectiveActiveSets(lib) : []).map((s) => s.id)),
    [lib],
  )

  // Rows = supported token names, grouped by type (lib order of names → sorted).
  const groups = useMemo(() => {
    const typeOf = new Map<string, SupportedTokenType>()
    for (const s of sets) {
      for (const t of s.tokens) {
        if ((SUPPORTED_TOKEN_TYPES as readonly string[]).includes(t.type)) {
          typeOf.set(t.name, t.type as SupportedTokenType)
        }
      }
    }
    const out: { type: SupportedTokenType; names: string[] }[] = []
    for (const type of SUPPORTED_TOKEN_TYPES) {
      const names = [...typeOf.entries()]
        .filter(([, ty]) => ty === type)
        .map(([n]) => n)
        .sort()
      if (names.length) out.push({ type, names })
    }
    return out
  }, [sets])

  const startEdit = (set: TokenSet, name: string) => {
    const t = findToken(set, name)
    if (!t || t.type === 'typography') return // composite edits stay in the rail
    setEdit({ setId: set.id, name })
    setDraft(typeof t.value === 'string' ? t.value : '')
  }

  const commitEdit = async () => {
    if (!edit) return
    const set = sets.find((s) => s.id === edit.setId)
    const t = set ? findToken(set, edit.name) : undefined
    if (set && t && typeof t.value === 'string' && draft !== t.value) {
      await modifyToken(set.id, t.id, { ...t, value: draft })
    }
    setEdit(null)
  }

  const addOverride = async (set: TokenSet, name: string, type: SupportedTokenType) => {
    // Seed from the same name in another set when present, else a type default.
    let seed: TokenValue = seedValue(type)
    for (const s of sets) {
      const t = findToken(s, name)
      if (t) {
        seed = t.value
        break
      }
    }
    await addToken(set.id, createToken({ name, type, value: seed }))
    if (type !== 'typography') {
      setEdit({ setId: set.id, name })
      setDraft(typeof seed === 'string' ? seed : '')
    }
  }

  const removeOverride = async (set: TokenSet, name: string) => {
    if (edit?.setId === set.id && edit?.name === name) setEdit(null)
    const t = findToken(set, name)
    if (t) await deleteToken(set.id, t.id)
  }

  const saveNewSet = async () => {
    const name = (newSet ?? '').trim()
    if (!name) return
    await addTokenSet(createTokenSet({ name }))
    setNewSet(null)
  }

  const body = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Tokens table"
    >
      <button
        type="button"
        aria-label="Close table"
        className="absolute inset-0 cursor-default bg-black/40"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-[600px] max-h-[90vh] w-[860px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Compare themes</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            advanced · rows = tokens · columns = sets · active sets tinted
          </span>
          <div className="ml-auto flex items-center gap-1">
            {newSet === null ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setNewSet('')}
              >
                <Plus className="size-3.5" /> Set
              </Button>
            ) : (
              <span className="flex items-center gap-1">
                <Input
                  value={newSet}
                  onChange={(e) => setNewSet(e.target.value)}
                  placeholder="Set name"
                  className="h-7 w-32 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveNewSet()
                    if (e.key === 'Escape') setNewSet(null)
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Save set"
                  onClick={() => void saveNewSet()}
                >
                  <Check />
                </Button>
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close table"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {sets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No sets yet — add a set to start a column.
            </p>
          ) : groups.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">
                    Token
                  </th>
                  {sets.map((s) => (
                    <th
                      key={s.id}
                      className={cn(
                        'sticky top-0 z-10 min-w-32 px-3 py-2 text-left font-medium',
                        activeSetIds.has(s.id)
                          ? 'bg-accent/40 text-foreground'
                          : 'bg-background text-muted-foreground',
                      )}
                      data-token-col={s.name}
                    >
                      <span className="flex items-center gap-1.5">
                        {activeSetIds.has(s.id) && (
                          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                        )}
                        <span className="truncate">{s.name}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.type}>
                    <tr>
                      <td
                        colSpan={sets.length + 1}
                        className="bg-muted/40 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {TYPE_LABEL[g.type]}
                      </td>
                    </tr>
                    {g.names.map((name) => (
                      <tr key={name} className="border-t border-border" data-token-row={name}>
                        <td className="sticky left-0 z-10 bg-background px-3 py-1.5 font-mono text-[0.7rem]">
                          {name}
                        </td>
                        {sets.map((s) => {
                          const t = findToken(s, name)
                          const editing = edit?.setId === s.id && edit?.name === name
                          return (
                            <td
                              key={s.id}
                              className={cn('px-3 py-1.5 align-middle', activeSetIds.has(s.id) && 'bg-accent/10')}
                              data-token-cell={`${s.name}:${name}`}
                            >
                              {editing ? (
                                <Input
                                  autoFocus
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value)}
                                  className="h-7 text-xs"
                                  onBlur={() => void commitEdit()}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void commitEdit()
                                    if (e.key === 'Escape') setEdit(null)
                                  }}
                                />
                              ) : t ? (
                                <span className="group flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                    onClick={() => startEdit(s, name)}
                                    title={t.type === 'typography' ? 'Edit in the panel' : 'Edit value'}
                                  >
                                    {isHex(t.value) && (
                                      <span
                                        className="size-3 shrink-0 rounded border border-border"
                                        style={{ backgroundColor: t.value }}
                                        aria-hidden
                                      />
                                    )}
                                    <span
                                      className={cn(
                                        'truncate',
                                        isAlias(t.value) && 'italic text-muted-foreground',
                                      )}
                                    >
                                      {authoredText(t)}
                                    </span>
                                  </button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                                    aria-label={`Remove ${name} from ${s.name}`}
                                    title="Remove override (inherit)"
                                    onClick={() => void removeOverride(s, name)}
                                  >
                                    <X />
                                  </Button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 text-muted-foreground/50 transition-colors hover:text-foreground"
                                  aria-label={`Add ${name} to ${s.name}`}
                                  title="Add an override in this set"
                                  onClick={() => void addOverride(s, name, g.type)}
                                >
                                  <Plus className="size-3" /> add
                                </button>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}
