/**
 * Tokens editor overlay (Slice 1) — a three-pane authoring surface that floats
 * over the editor as a top layer (portal to <body>), replacing the old
 * sets-as-columns table. The shape follows mature token editors (Tokens Studio /
 * Figma variables), splitting the two orthogonal axes the matrix conflated:
 *
 *   ┌─────────┬───────────────────────────┬──────────────┐
 *   │  TREE   │  TABLE (tokens in the set) │  PROPERTY    │
 *   │ themes  │  name · type · value(→ref) │  value/ref   │
 *   │ + sets  │  [+ token]                 │  resolves    │
 *   │         │                            │  used by     │
 *   └─────────┴───────────────────────────┴──────────────┘
 *
 * - Themes are the *mode* axis (click to activate); sets are *storage* (click to
 *   browse). Both live in the left tree — themes aren't set containers, so we
 *   don't duplicate the set list per theme.
 * - Each token is one complete row; a referenced value shows the raw alias AND
 *   its resolved value together.
 * - References are authored through a typed picker (same-type tokens only) that
 *   greys out targets which would create a cycle — the alias graph is built
 *   implicitly and safely, never by hand-wiring nodes.
 *
 * Every edit routes through the P2.3 CRUD, so propagation + undo are unchanged.
 * Deferred to later slices: per-mode value editing (S2) and a read-only
 * dependency graph view (S3). Composite typography stays read-only here (authored
 * in the rail). Closed with Esc / backdrop / ✕.
 */

import { type DragEvent as ReactDragEvent, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, Boxes, Check, ChevronDown, Folder, GripVertical, Info, Link2, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  isSupportedTokenType,
  isTokenAlias,
  setUsage,
  SUPPORTED_TOKEN_TYPES,
  type SupportedTokenType,
  themeTopSet,
  tokenAliasName,
  type Token,
  type TokenSet,
  type TokensLib,
  type TokenTheme,
  type TokenValue,
} from '../../tokens/types'
import {
  addTheme,
  addToken,
  addTokenSet,
  deleteTheme,
  deleteToken,
  deleteTokenSet,
  modifyTheme,
  modifyToken,
  modifyTokenSet,
  reorderSet,
} from '../../tokens/crud'
import { type ResolvedToken, type ResolvedTokens } from '../../tokens/resolve'
import { useResolvedTokens } from '../../tokens/use-resolved-tokens'
import { checkTokenValue, tokenValuePrefix } from '../../tokens/token-value-rules'
import { buildAliasIndex, createsCycle, usedByNames } from '../../tokens/graph'

const TYPE_LABEL: Record<SupportedTokenType, string> = {
  color: 'color',
  typography: 'typography',
  dimension: 'dimension',
  spacing: 'spacing',
  sizing: 'sizing',
  borderRadius: 'radius',
  opacity: 'opacity',
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)
}

function isColorString(v: unknown): v is string {
  return typeof v === 'string' && /^(#|rgb|hsl)/i.test(v)
}

function Swatch({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={cn('inline-block size-3 shrink-0 rounded border border-border', className)}
      style={{ backgroundColor: value }}
      aria-hidden
    />
  )
}

/** One-line label for a token's authored value (literal or {alias}). */
function authoredText(t: Token): string {
  if (typeof t.value === 'string') return t.value
  const v = t.value as Record<string, string>
  return [v.fontFamily, [v.fontSize, v.fontWeight].filter(Boolean).join(' / ')].filter(Boolean).join(' ')
}

/** Render a resolved concrete value — swatch+hex for colors, number+unit, or text. */
function ResolvedValue({ rt }: { rt: ResolvedToken | undefined }) {
  if (!rt || rt.resolvedValue == null) {
    return <span className="text-muted-foreground/60">—</span>
  }
  if (rt.errors?.length) {
    return <span className="text-destructive">error</span>
  }
  const v = rt.resolvedValue
  if (isColorString(v)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Swatch value={v} />
        <span className="font-mono">{v}</span>
      </span>
    )
  }
  if (typeof v === 'number') {
    return (
      <span className="font-mono">
        {v}
        {rt.unit ?? ''}
      </span>
    )
  }
  if (typeof v === 'string') return <span className="font-mono">{v}</span>
  return <span className="truncate text-muted-foreground">composite</span>
}

/** The authored value as shown in a table row: literal, or alias + resolved. */
function AuthoredValueCell({ token, resolved }: { token: Token; resolved: ResolvedTokens }) {
  const alias = tokenAliasName(token.value)
  if (alias) {
    const rt = resolved.get(token.name)
    const rv = rt?.resolvedValue
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Link2 className="size-3 shrink-0 text-accent-foreground" aria-hidden />
        <span className="truncate font-mono">{alias}</span>
        {isColorString(rv) && <Swatch value={rv} />}
      </span>
    )
  }
  if (isHex(token.value)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Swatch value={token.value} />
        <span className="font-mono">{token.value}</span>
      </span>
    )
  }
  return <span className="truncate font-mono">{authoredText(token)}</span>
}

/**
 * Drag-to-reorder for set rows, shared by the sidebar and the theme detail. The
 * caller passes sets in DISPLAY order (winner-first); we reason in that order and
 * map back to lib order for `reorderSet`, so dragging a set upward makes it win.
 * `rowProps(id)` returns the HTML5 drag handlers to spread on each row.
 */
function useSetReorder(displaySets: TokenSet[]) {
  const [dragSetId, setDragSetId] = useState<string | null>(null)
  const [dragOverSet, setDragOverSet] = useState<{ id: string; after: boolean } | null>(null)

  const dropSet = (targetId: string, after: boolean) => {
    const draggedId = dragSetId
    setDragSetId(null)
    setDragOverSet(null)
    if (!draggedId || draggedId === targetId) return
    const order = displaySets.map((s) => s.id).filter((id) => id !== draggedId)
    let pos = order.indexOf(targetId)
    if (pos < 0) return
    if (after) pos += 1
    order.splice(pos, 0, draggedId)
    const libOrder = [...order].reverse()
    void reorderSet(draggedId, libOrder.indexOf(draggedId))
  }

  const rowProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      setDragSetId(id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!dragSetId || dragSetId === id) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      setDragOverSet({ id, after: e.clientY > r.top + r.height / 2 })
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault()
      const over = dragOverSet && dragOverSet.id === id ? dragOverSet : null
      dropSet(id, over ? over.after : false)
    },
    onDragEnd: () => {
      setDragSetId(null)
      setDragOverSet(null)
    },
  })

  /** Tailwind class for the drop indicator (inset ring on the target edge). */
  const dropClass = (id: string) => {
    const over = dragOverSet && dragOverSet.id === id ? dragOverSet : null
    if (!over) return ''
    return over.after ? 'shadow-[inset_0_-2px_0_0] shadow-ring' : 'shadow-[inset_0_2px_0_0] shadow-ring'
  }

  return { dragSetId, rowProps, dropClass }
}

interface Props {
  lib: TokensLib | undefined
  onClose: () => void
}

export function TokensEditorOverlay({ lib, onClose }: Props) {
  const sets = useMemo(() => lib?.sets ?? [], [lib])
  // Precedence is lib order (last wins). We DISPLAY it reversed so the winner
  // sits at the top — resolution is unchanged, only the reading order flips.
  const displaySets = useMemo(() => [...sets].reverse(), [sets])
  const themes = useMemo(() => lib?.themes ?? [], [lib])
  const activeThemeId = lib?.activeThemes[0]

  const [selectedSetId, setSelectedSetId] = useState<string | undefined>(sets[0]?.id)
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null)
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [newSet, setNewSet] = useState<string | null>(null)
  const [newTheme, setNewTheme] = useState<string | null>(null)
  const [renameSet, setRenameSet] = useState<{ id: string; draft: string } | null>(null)
  const [confirmDeleteSetId, setConfirmDeleteSetId] = useState<string | null>(null)
  const [renameTheme, setRenameTheme] = useState<{ id: string; draft: string } | null>(null)
  const [confirmDeleteTheme, setConfirmDeleteTheme] = useState<string | null>(null)

  const resolved = useResolvedTokens()
  const aliasIndex = useMemo(() => buildAliasIndex(lib), [lib])
  const reorder = useSetReorder(displaySets)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Keep the selected set valid as the lib changes.
  const selectedSet: TokenSet | undefined =
    sets.find((s) => s.id === selectedSetId) ?? sets[0]
  const tokens = selectedSet?.tokens ?? []
  const selectedToken = tokens.find((t) => t.id === selectedTokenId) ?? null

  const q = query.trim().toLowerCase()
  const shownTokens = q
    ? tokens.filter((t) => `${t.name} ${authoredText(t)}`.toLowerCase().includes(q))
    : tokens

  // The tree selects a set OR a theme; the middle pane branches on which.
  const viewingTheme = selectedThemeId ? (themes.find((t) => t.id === selectedThemeId) ?? null) : null
  // The property pane exists only when a token in a set is selected — no dead
  // "select a token" column otherwise.
  const showProperty = !viewingTheme && !!selectedToken && !!selectedSet

  const selectSet = (id: string) => {
    setSelectedSetId(id)
    setSelectedThemeId(null)
    setSelectedTokenId(null)
    setAdding(false)
  }

  const selectTheme = (id: string) => {
    setSelectedThemeId(id)
    setSelectedTokenId(null)
    setAdding(false)
  }

  // Jump from the theme's Tokens view straight to the owning set + token, so the
  // property panel opens on it.
  const openToken = (setId: string, tokenId: string) => {
    setSelectedSetId(setId)
    setSelectedThemeId(null)
    setSelectedTokenId(tokenId)
    setAdding(false)
  }

  const saveNewSet = async () => {
    const name = (newSet ?? '').trim()
    if (!name) return
    const set = createTokenSet({ name })
    await addTokenSet(set)
    setNewSet(null)
    setSelectedSetId(set.id)
  }

  const saveNewTheme = async () => {
    const name = (newTheme ?? '').trim()
    if (!name) return
    await addTheme(createTokenTheme({ name }))
    setNewTheme(null)
  }

  // Rename a set → also repoint every theme that lists it by name (themes
  // reference sets by name, so a bare rename would orphan the membership).
  const commitRenameSet = async () => {
    const target = renameSet
    setRenameSet(null)
    if (!target) return
    const next = target.draft.trim()
    const set = sets.find((s) => s.id === target.id)
    if (!set || !next || next === set.name) return
    const old = set.name
    await modifyTokenSet(set.id, { ...set, name: next })
    for (const th of themes) {
      if (th.sets.includes(old)) {
        await modifyTheme(th.id, { ...th, sets: th.sets.map((n) => (n === old ? next : n)) })
      }
    }
  }

  // Delete a set. A theme's dangling name is inert (resolution filters by
  // existing sets) and is restored on undo, so no theme cascade is needed.
  const removeSet = async (id: string) => {
    const nextSel = sets.find((s) => s.id !== id)?.id
    setConfirmDeleteSetId(null)
    if (selectedSet?.id === id) {
      setSelectedTokenId(null)
      setSelectedSetId(nextSel)
    }
    await deleteTokenSet(id)
  }

  const commitRenameTheme = async () => {
    const target = renameTheme
    setRenameTheme(null)
    if (!target) return
    const next = target.draft.trim()
    const theme = themes.find((t) => t.id === target.id)
    if (!theme || !next || next === theme.name) return
    await modifyTheme(theme.id, { ...theme, name: next })
  }

  const removeTheme = async (id: string) => {
    setConfirmDeleteTheme(null)
    await deleteTheme(id)
  }

  const body = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Tokens editor"
    >
      <button
        type="button"
        aria-label="Close editor"
        className="absolute inset-0 cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex h-[620px] max-h-[92vh] w-[940px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        data-token-editor=""
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Tokens</span>
          <div className="relative ml-2 min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in set…"
              aria-label="Search tokens in set"
              className="h-7 w-full min-w-0 rounded-md border border-border bg-background pl-6 pr-6 text-xs outline-none focus:border-ring"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQuery('')}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Close editor" onClick={onClose}>
            <X />
          </Button>
        </div>

        {/* Panes — the property pane is only present when a token is selected */}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {/* Left: tree (themes + sets) */}
          <ResizablePanel id="tree" defaultSize={20} minSize={14} className="overflow-auto">
            <div className="px-2.5 pb-1 pt-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Themes
            </div>
            {themes.length === 0 && (
              <p className="px-2.5 pb-1 text-[0.65rem] text-muted-foreground">No themes yet.</p>
            )}
            {themes.map((t) => {
              const active = activeThemeId === t.id
              const renaming = renameTheme && renameTheme.id === t.id ? renameTheme : null
              if (renaming) {
                return (
                  <div key={t.id} className="flex items-center gap-1 px-2 py-1">
                    <Input
                      value={renaming.draft}
                      onChange={(e) => setRenameTheme({ id: t.id, draft: e.target.value })}
                      className="h-6 text-xs"
                      autoFocus
                      onBlur={() => void commitRenameTheme()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRenameTheme()
                        if (e.key === 'Escape') setRenameTheme(null)
                      }}
                    />
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Save theme name" onClick={() => void commitRenameTheme()}>
                      <Check />
                    </Button>
                  </div>
                )
              }
              if (confirmDeleteTheme === t.id) {
                return (
                  <div key={t.id} className="flex items-center gap-1 px-2.5 py-1 text-[0.7rem]">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">Delete “{t.name}”?</span>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Confirm delete theme" onClick={() => void removeTheme(t.id)}>
                      <Check className="text-destructive" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel delete theme" onClick={() => setConfirmDeleteTheme(null)}>
                      <X />
                    </Button>
                  </div>
                )
              }
              return (
                <div
                  key={t.id}
                  data-token-theme={t.name}
                  className={cn(
                    'group flex items-center gap-1 px-2.5 py-1 text-xs',
                    t.id === selectedThemeId ? 'bg-accent/40 text-foreground' : 'hover:bg-muted/60',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => selectTheme(t.id)}
                  >
                    <Boxes className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </button>
                  {active && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 text-[0.55rem] font-medium text-emerald-600 group-hover:hidden"
                      title="This theme is the live mode (set in the sidebar)"
                    >
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                      live
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Rename theme ${t.name}`}
                    className="hidden shrink-0 text-muted-foreground hover:text-foreground group-hover:block"
                    onClick={() => setRenameTheme({ id: t.id, draft: t.name })}
                  >
                    <Pencil className="size-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete theme ${t.name}`}
                    className="hidden shrink-0 text-muted-foreground hover:text-destructive group-hover:block"
                    onClick={() => setConfirmDeleteTheme(t.id)}
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </button>
                </div>
              )
            })}
            {newTheme === null ? (
              <button
                type="button"
                className="flex items-center gap-1 px-2.5 py-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
                onClick={() => setNewTheme('')}
              >
                <Plus className="size-3" /> Theme
              </button>
            ) : (
              <div className="flex items-center gap-1 px-2 py-1">
                <Input
                  value={newTheme}
                  onChange={(e) => setNewTheme(e.target.value)}
                  placeholder="Theme name"
                  className="h-6 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveNewTheme()
                    if (e.key === 'Escape') setNewTheme(null)
                  }}
                />
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Save theme" onClick={() => void saveNewTheme()}>
                  <Check />
                </Button>
              </div>
            )}

            <div className="border-t border-border px-2.5 pb-1 pt-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Sets <span className="font-normal normal-case tracking-normal opacity-70">· top wins</span>
            </div>
            {displaySets.map((s) => {
              const renaming = renameSet && renameSet.id === s.id ? renameSet : null
              if (renaming) {
                return (
                  <div key={s.id} className="flex items-center gap-1 px-2 py-1">
                    <Input
                      value={renaming.draft}
                      onChange={(e) => setRenameSet({ id: s.id, draft: e.target.value })}
                      className="h-6 text-xs"
                      autoFocus
                      onBlur={() => void commitRenameSet()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRenameSet()
                        if (e.key === 'Escape') setRenameSet(null)
                      }}
                    />
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Save set name" onClick={() => void commitRenameSet()}>
                      <Check />
                    </Button>
                  </div>
                )
              }
              if (confirmDeleteSetId === s.id) {
                return (
                  <div key={s.id} className="flex items-center gap-1 px-2.5 py-1 text-[0.7rem]">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      Delete “{s.name}”{s.tokens.length ? ` · ${s.tokens.length}` : ''}?
                    </span>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Confirm delete set" onClick={() => void removeSet(s.id)}>
                      <Check className="text-destructive" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel delete set" onClick={() => setConfirmDeleteSetId(null)}>
                      <X />
                    </Button>
                  </div>
                )
              }
              return (
                <div
                  key={s.id}
                  data-token-set={s.name}
                  {...reorder.rowProps(s.id)}
                  className={cn(
                    'group relative flex items-center gap-1 px-2.5 py-1 text-xs',
                    s.id === selectedSet?.id ? 'bg-accent/40 text-foreground' : 'hover:bg-muted/60',
                    reorder.dragSetId === s.id && 'opacity-40',
                    reorder.dropClass(s.id),
                  )}
                >
                  <GripVertical
                    className="size-3 shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground"
                    aria-hidden
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => selectSet(s.id)}
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  </button>
                  <span className="shrink-0 text-[0.6rem] text-muted-foreground group-hover:hidden">{s.tokens.length}</span>
                  <button
                    type="button"
                    aria-label={`Rename set ${s.name}`}
                    className="hidden shrink-0 text-muted-foreground hover:text-foreground group-hover:block"
                    onClick={() => setRenameSet({ id: s.id, draft: s.name })}
                  >
                    <Pencil className="size-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete set ${s.name}`}
                    className="hidden shrink-0 text-muted-foreground hover:text-destructive group-hover:block"
                    onClick={() => setConfirmDeleteSetId(s.id)}
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </button>
                </div>
              )
            })}
            {newSet === null ? (
              <button
                type="button"
                className="flex items-center gap-1 px-2.5 py-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
                onClick={() => setNewSet('')}
              >
                <Plus className="size-3" /> Set
              </button>
            ) : (
              <div className="flex items-center gap-1 px-2 py-1">
                <Input
                  value={newSet}
                  onChange={(e) => setNewSet(e.target.value)}
                  placeholder="Set name"
                  className="h-6 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveNewSet()
                    if (e.key === 'Escape') setNewSet(null)
                  }}
                />
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Save set" onClick={() => void saveNewSet()}>
                  <Check />
                </Button>
              </div>
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* Middle: token table (set selected) OR theme detail (theme selected) */}
          <ResizablePanel id="main" defaultSize={showProperty ? 52 : 80} minSize={30} className="flex min-w-0 flex-col">
            {viewingTheme ? (
              <ThemeDetail lib={lib} theme={viewingTheme} resolved={resolved} onOpenToken={openToken} />
            ) : (
              <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="text-xs font-medium">{selectedSet?.name ?? '—'}</span>
              <span className="text-[0.65rem] text-muted-foreground">
                {tokens.length} {tokens.length === 1 ? 'token' : 'tokens'}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-muted-foreground"
                disabled={!selectedSet}
                onClick={() => setAdding((a) => !a)}
              >
                <Plus className="size-3.5" /> Token
              </Button>
            </div>
            {selectedSet && <SetInfo lib={lib} set={selectedSet} />}
            <div className="min-h-0 flex-1 overflow-auto">
              {!selectedSet ? (
                <p className="p-4 text-sm text-muted-foreground">Add a set to start authoring tokens.</p>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="sticky top-0 z-10 bg-background px-3 py-1.5 text-left font-medium">Name</th>
                      <th className="sticky top-0 z-10 bg-background px-2 py-1.5 text-left font-medium">Type</th>
                      <th className="sticky top-0 z-10 bg-background px-3 py-1.5 text-left font-medium">Value</th>
                      <th className="sticky top-0 z-10 w-8 bg-background" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {adding && (
                      <AddTokenRow
                        setId={selectedSet.id}
                        onDone={() => setAdding(false)}
                        onCreated={(id) => setSelectedTokenId(id)}
                      />
                    )}
                    {shownTokens.map((t) => (
                      <tr
                        key={t.id}
                        data-token-row={t.name}
                        className={cn(
                          'group cursor-pointer border-t border-border',
                          t.id === selectedToken?.id ? 'bg-accent/40' : 'hover:bg-muted/40',
                        )}
                        onClick={() => setSelectedTokenId(t.id)}
                      >
                        <td className="px-3 py-1.5 font-mono text-[0.7rem]">{t.name}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {isSupportedTokenType(t.type) ? TYPE_LABEL[t.type] : t.type}
                        </td>
                        <td className="px-3 py-1.5">
                          <AuthoredValueCell token={t} resolved={resolved} />
                        </td>
                        <td className="w-8 px-1 py-1.5 text-right">
                          <button
                            type="button"
                            aria-label={`Delete ${t.name}`}
                            title="Delete token"
                            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (t.id === selectedTokenId) setSelectedTokenId(null)
                              void deleteToken(selectedSet.id, t.id)
                            }}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {shownTokens.length === 0 && !adding && (
                      <tr>
                        <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                          {q ? `No tokens match “${query.trim()}”.` : 'No tokens in this set yet.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
              </>
            )}
          </ResizablePanel>

          {/* Right: property panel — mounted only while a token is selected */}
          {showProperty && selectedToken && selectedSet && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="property" defaultSize={28} minSize={16} className="overflow-auto">
                <PropertyPanel
                  key={selectedToken.id}
                  lib={lib}
                  set={selectedSet}
                  token={selectedToken}
                  resolved={resolved}
                  aliasTargetOf={aliasIndex.targetOf}
                  usedBy={usedByNames(aliasIndex, selectedToken.name)}
                  onDeleted={() => setSelectedTokenId(null)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>

        {/* Footer legend */}
        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[0.6rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Link2 className="size-3" aria-hidden /> references via typed picker
          </span>
          <span className="flex items-center gap-1">
            <Ban className="size-3" aria-hidden /> cycles blocked
          </span>
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}

// ── Add-token row (inline in the table) ───────────────────────────────────────

function AddTokenRow({
  setId,
  onDone,
  onCreated,
}: {
  setId: string
  onDone: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<SupportedTokenType>('color')
  const [value, setValue] = useState('#9CA3AF')

  const check = checkTokenValue(type, value)
  const canSave = name.trim().length > 0 && (check.ok || check.incomplete)

  const save = async () => {
    if (!canSave) return
    const token = createToken({ name: name.trim(), type, value: value as TokenValue })
    await addToken(setId, token)
    onCreated(token.id)
    onDone()
  }

  return (
    <tr className="border-t border-border bg-muted/30">
      <td className="px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          className="h-6 text-xs"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') onDone()
          }}
        />
      </td>
      <td className="px-2 py-1.5">
        <select
          className="h-6 w-full rounded-md border border-border bg-background px-1 text-xs"
          value={type}
          aria-label="New token type"
          onChange={(e) => {
            const next = e.target.value as SupportedTokenType
            setType(next)
            setValue(next === 'color' ? '#9CA3AF' : next === 'opacity' ? '1' : '0')
          }}
        >
          {SUPPORTED_TOKEN_TYPES.filter((t) => t !== 'typography').map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            className={cn('h-6 text-xs', !check.ok && !check.incomplete && 'border-destructive')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') onDone()
            }}
          />
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Add token" disabled={!canSave} onClick={() => void save()}>
            <Check />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" onClick={onDone}>
            <X />
          </Button>
        </div>
      </td>
      <td className="w-8" />
    </tr>
  )
}

// ── Theme detail: set membership (Phase 2) ────────────────────────────────────

/**
 * Shown in the middle pane when a theme is selected. Two views over the same
 * theme:
 *   - "Sets"   — a checklist of every set (winner-first), ticking adds/removes it
 *                from the theme; rows are drag-reorderable (= precedence), same as
 *                the sidebar.
 *   - "Tokens" — the theme's *resolved* surface: every token name its sets define,
 *                once per name, showing which definition is active (the top set
 *                wins) and which are shadowed (inactive) beneath it.
 */
function ThemeDetail({
  lib,
  theme,
  resolved,
  onOpenToken,
}: {
  lib: TokensLib | undefined
  theme: TokenTheme
  resolved: ResolvedTokens
  onOpenToken: (setId: string, tokenId: string) => void
}) {
  const [view, setView] = useState<'sets' | 'tokens'>('sets')
  const displaySets = useMemo(() => [...(lib?.sets ?? [])].reverse(), [lib])
  const reorder = useSetReorder(displaySets)
  const memberNames = new Set(theme.sets)

  const toggle = async (name: string) => {
    const next = memberNames.has(name)
      ? theme.sets.filter((n) => n !== name)
      : [...theme.sets, name]
    await modifyTheme(theme.id, { ...theme, sets: next })
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Boxes className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium">{theme.name}</span>
        <span className="text-[0.65rem] text-muted-foreground">
          theme · {theme.sets.length} {theme.sets.length === 1 ? 'set' : 'sets'}
        </span>
        <div className="ml-auto inline-flex rounded-md border border-border p-0.5 text-[0.7rem]">
          <button
            type="button"
            className={cn('rounded px-2 py-0.5', view === 'sets' ? 'bg-muted text-foreground' : 'text-muted-foreground')}
            onClick={() => setView('sets')}
          >
            Sets
          </button>
          <button
            type="button"
            className={cn('rounded px-2 py-0.5', view === 'tokens' ? 'bg-muted text-foreground' : 'text-muted-foreground')}
            onClick={() => setView('tokens')}
          >
            Tokens
          </button>
        </div>
      </div>
      {view === 'sets' ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Sets in this theme
          </div>
          <p className="mb-2.5 text-[0.65rem] text-muted-foreground">
            Listed by priority — the topmost checked set wins. Drag to reorder.
          </p>
          {displaySets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sets yet — add one in the sidebar.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {displaySets.map((s) => {
                const member = memberNames.has(s.name)
                return (
                  <label
                    key={s.id}
                    data-token-theme-set={s.name}
                    {...reorder.rowProps(s.id)}
                    className={cn(
                      'group flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-2 text-xs',
                      !member && 'text-muted-foreground',
                      reorder.dragSetId === s.id && 'opacity-40',
                      reorder.dropClass(s.id),
                    )}
                  >
                    <GripVertical
                      className="size-3 shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground"
                      aria-hidden
                    />
                    <input
                      type="checkbox"
                      checked={member}
                      onChange={() => void toggle(s.name)}
                      className="size-3.5"
                    />
                    <span className="font-mono">{s.name}</span>
                    <span className="ml-auto shrink-0 text-[0.6rem] text-muted-foreground">
                      {s.tokens.length} {s.tokens.length === 1 ? 'token' : 'tokens'}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <ThemeTokens lib={lib} theme={theme} resolved={resolved} onOpenToken={onOpenToken} />
      )}
    </>
  )
}

// ── Theme tokens view: active vs shadowed across the theme's sets ──────────────

interface ThemeTokenGroup {
  name: string
  active: { set: TokenSet; token: Token }
  /** Definitions shadowed by `active`, nearest-loser first. */
  shadowed: { set: TokenSet; token: Token }[]
}

/**
 * The theme's resolved token surface. Walking its member sets in lib order (the
 * override order), each token name collapses to one active definition — the last
 * set that defines it wins — with any earlier definitions listed beneath it as
 * shadowed (inactive). This is what actually resolves for the theme, so it shows
 * composition the checklist can't. Clicking a row jumps to that set + token.
 */
function ThemeTokens({
  lib,
  theme,
  resolved,
  onOpenToken,
}: {
  lib: TokensLib | undefined
  theme: TokenTheme
  resolved: ResolvedTokens
  onOpenToken: (setId: string, tokenId: string) => void
}) {
  const groups = useMemo<ThemeTokenGroup[]>(() => {
    const names = new Set(theme.sets)
    const themeSets = (lib?.sets ?? []).filter((s) => names.has(s.name)) // lib order = precedence
    const byName = new Map<string, { set: TokenSet; token: Token }[]>()
    for (const set of themeSets) {
      const seen = new Set<string>()
      for (const token of set.tokens) {
        if (seen.has(token.name)) continue // first occurrence wins within a set
        seen.add(token.name)
        const arr = byName.get(token.name) ?? []
        arr.push({ set, token })
        byName.set(token.name, arr)
      }
    }
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, defs]) => ({
        name,
        active: defs[defs.length - 1], // last in lib order wins
        shadowed: defs.slice(0, -1).reverse(), // nearest-loser first
      }))
  }, [lib, theme])

  const overridden = groups.filter((g) => g.shadowed.length > 0).length

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-0.5 flex items-center gap-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Resolved tokens</span>
        <span className="font-normal normal-case tracking-normal">
          {groups.length} {groups.length === 1 ? 'name' : 'names'}
          {overridden > 0 ? ` · ${overridden} overridden` : ''}
        </span>
      </div>
      <p className="mb-2.5 flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> active
        </span>
        <span className="opacity-60">·</span>
        <span>dimmed = shadowed by the winning set</span>
      </p>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {theme.sets.length === 0 ? 'This theme enables no sets yet.' : 'The theme’s sets define no tokens.'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {groups.map((g) => (
            <div key={g.name} className="rounded-md border border-border">
              <button
                type="button"
                data-theme-token={g.name}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted/40"
                onClick={() => onOpenToken(g.active.set.id, g.active.token.id)}
                title="Open in its set"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono">{g.name}</span>
                <span className="shrink-0">
                  <AuthoredValueCell token={g.active.token} resolved={resolved} />
                </span>
                <span className="shrink-0 rounded bg-accent/40 px-1.5 py-0.5 font-mono text-[0.55rem] text-muted-foreground">
                  {g.active.set.name}
                </span>
              </button>
              {g.shadowed.map(({ set, token }) => (
                <button
                  key={set.id}
                  type="button"
                  data-theme-token-shadowed={g.name}
                  className="flex w-full items-center gap-2 border-t border-border/60 px-2.5 py-1 text-left text-[0.7rem] text-muted-foreground/70 hover:bg-muted/30"
                  onClick={() => onOpenToken(set.id, token.id)}
                  title="Shadowed here — open in its set"
                >
                  <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono line-through decoration-muted-foreground/40">
                    {g.name}
                  </span>
                  <span className="shrink-0 opacity-80">
                    <AuthoredValueCell token={token} resolved={resolved} />
                  </span>
                  <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[0.55rem]">
                    {set.name}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Set info strip (shown under the set header) ───────────────────────────────

/**
 * Compact context for the selected set: which themes include it, and which of
 * those it wins in (i.e. it's their top set). This is where the theme-relative
 * "wins / shared" info now lives — on the set, where editing its tokens actually
 * has consequences. Hidden entirely when there are no themes.
 */
function SetInfo({ lib, set }: { lib: TokensLib | undefined; set: TokenSet }) {
  const info = useMemo(() => {
    if (!lib || lib.themes.length === 0) return null
    const inThemes = (setUsage(lib).get(set.name) ?? []).map((t) => t.name)
    const winsIn = (lib.themes.filter((t) => themeTopSet(lib, t)?.id === set.id)).map((t) => t.name)
    return { inThemes, winsIn }
  }, [lib, set])

  if (!info) return null
  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-[0.65rem]">
      <Info className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">In themes</span>
        {info.inThemes.length === 0 ? (
          <span className="italic text-muted-foreground/70">none</span>
        ) : (
          <span className="text-foreground">{info.inThemes.join(', ')}</span>
        )}
      </span>
      {info.winsIn.length > 0 && (
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Wins in</span>
          <span className="text-emerald-600">{info.winsIn.join(', ')}</span>
        </span>
      )}
      {info.inThemes.length > 1 && (
        <span className="text-amber-700">edits here affect all {info.inThemes.length} themes</span>
      )}
    </div>
  )
}

// ── Property panel (one token) ────────────────────────────────────────────────

function PropertyPanel({
  lib,
  set,
  token,
  resolved,
  aliasTargetOf,
  usedBy,
  onDeleted,
}: {
  lib: TokensLib | undefined
  set: TokenSet
  token: Token
  resolved: ResolvedTokens
  aliasTargetOf: Map<string, string>
  usedBy: string[]
  onDeleted: () => void
}) {
  const supported = isSupportedTokenType(token.type) ? token.type : undefined
  const isAlias = isTokenAlias(token.value)
  const aliasName = tokenAliasName(token.value)
  const composite = token.type === 'typography'

  const [mode, setMode] = useState<'raw' | 'ref'>(isAlias ? 'ref' : 'raw')
  const [raw, setRaw] = useState(typeof token.value === 'string' && !isAlias ? token.value : '')
  const [pickerOpen, setPickerOpen] = useState(false)

  const commitRaw = async () => {
    if (!supported) return
    const check = checkTokenValue(supported, raw)
    if (!check.ok) return
    if (raw !== token.value) await modifyToken(set.id, token.id, { ...token, value: raw })
  }

  const chooseRef = async (name: string) => {
    setPickerOpen(false)
    await modifyToken(set.id, token.id, { ...token, value: `{${name}}` })
  }

  // Reference candidates: same-type names across all sets, minus self + cycles.
  const candidates = useMemo(() => {
    if (!supported) return []
    const byName = new Map<string, SupportedTokenType>()
    for (const s of lib?.sets ?? []) {
      for (const t of s.tokens) {
        if (isSupportedTokenType(t.type) && !byName.has(t.name)) byName.set(t.name, t.type)
      }
    }
    return [...byName.entries()]
      .filter(([n, ty]) => ty === supported && n !== token.name)
      .map(([n]) => n)
      .sort()
  }, [lib, supported, token.name])

  const rt = resolved.get(token.name)

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(token.name)

  // Rename this token → also repoint aliases that referenced it, but ONLY when
  // the old name no longer exists on another token (duplicates keep resolving,
  // so their `{oldName}` references must stay pointed at the survivor).
  const commitRenameToken = async () => {
    const next = nameDraft.trim()
    setRenaming(false)
    if (!next || next === token.name) return
    const old = token.name
    await modifyToken(set.id, token.id, { ...token, name: next })
    const stillExists = (lib?.sets ?? []).some((s) =>
      s.tokens.some((t) => t.id !== token.id && t.name === old),
    )
    if (!stillExists) {
      for (const s of lib?.sets ?? []) {
        for (const t of s.tokens) {
          if (t.id !== token.id && tokenAliasName(t.value) === old) {
            await modifyToken(s.id, t.id, { ...t, value: `{${next}}` })
          }
        }
      }
    }
  }

  return (
    <div className="p-3">
      <div className="mb-3 flex items-center gap-1.5">
        {renaming ? (
          <>
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="h-6 min-w-0 flex-1 font-mono text-xs"
              autoFocus
              onBlur={() => void commitRenameToken()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRenameToken()
                if (e.key === 'Escape') {
                  setNameDraft(token.name)
                  setRenaming(false)
                }
              }}
            />
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Save token name" onClick={() => void commitRenameToken()}>
              <Check />
            </Button>
          </>
        ) : (
          <>
            {isColorString(rt?.resolvedValue) && <Swatch value={rt!.resolvedValue as string} className="size-4" />}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{token.name}</span>
            <button
              type="button"
              aria-label="Rename token"
              title="Rename token"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setNameDraft(token.name)
                setRenaming(true)
              }}
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
            <span className="shrink-0 rounded-full bg-accent/40 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
              {supported ? TYPE_LABEL[supported] : token.type}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Delete token"
              title="Delete token"
              onClick={() => {
                void deleteToken(set.id, token.id)
                onDeleted()
              }}
            >
              <Trash2 className="text-muted-foreground" />
            </Button>
          </>
        )}
      </div>

      {composite ? (
        <p className="rounded-md bg-muted/40 px-2 py-2 text-[0.65rem] text-muted-foreground">
          Composite typography — edit in the rail’s token editor.
        </p>
      ) : (
        <>
          <div className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Value
          </div>
          <div className="mb-2 inline-flex rounded-md border border-border p-0.5 text-[0.7rem]">
            <button
              type="button"
              className={cn('rounded px-2 py-0.5', mode === 'raw' ? 'bg-muted text-foreground' : 'text-muted-foreground')}
              onClick={() => setMode('raw')}
            >
              Raw
            </button>
            <button
              type="button"
              className={cn('flex items-center gap-1 rounded px-2 py-0.5', mode === 'ref' ? 'bg-muted text-foreground' : 'text-muted-foreground')}
              onClick={() => setMode('ref')}
            >
              <Link2 className="size-3" /> Reference
            </button>
          </div>

          {mode === 'raw' ? (
            <div className="mb-3 flex items-center gap-1">
              {supported && tokenValuePrefix(supported) && (
                <span className="rounded-l-md border border-r-0 border-border bg-muted/40 px-1.5 py-1 text-[0.7rem] text-muted-foreground">
                  {tokenValuePrefix(supported)}
                </span>
              )}
              <Input
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder="value"
                className="h-7 text-xs"
                onBlur={() => void commitRaw()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRaw()
                }}
              />
            </div>
          ) : (
            <div className="relative mb-3">
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs hover:border-ring"
                onClick={() => setPickerOpen((o) => !o)}
                aria-expanded={pickerOpen}
              >
                <Link2 className="size-3 shrink-0 text-accent-foreground" aria-hidden />
                <span className={cn('min-w-0 flex-1 truncate text-left font-mono', !aliasName && 'text-muted-foreground')}>
                  {aliasName ?? 'Choose token…'}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
              {pickerOpen && (
                <div className="absolute left-0 top-8 z-20 max-h-60 w-full overflow-auto rounded-md border border-border bg-background p-1 shadow-xl">
                  {candidates.length === 0 && (
                    <p className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">No other {supported} tokens.</p>
                  )}
                  {candidates.map((name) => {
                    const cyclic = createsCycle(aliasTargetOf, token.name, name)
                    return (
                      <button
                        key={name}
                        type="button"
                        data-token-ref-option={name}
                        disabled={cyclic}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[0.7rem]',
                          cyclic ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted/60',
                          aliasName === name && 'bg-accent/40',
                        )}
                        title={cyclic ? 'Would create a reference cycle' : undefined}
                        onClick={() => !cyclic && void chooseRef(name)}
                      >
                        {cyclic && <Ban className="size-3 shrink-0" aria-hidden />}
                        <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                        {aliasName === name && <Check className="size-3 shrink-0" aria-hidden />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <div className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Resolves
          </div>
          <div className="mb-3 flex flex-col gap-1.5 text-xs">
            <ResolvedValue rt={rt} />
          </div>
        </>
      )}

      <div className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Used by{usedBy.length ? ` · ${usedBy.length}` : ''}
      </div>
      {usedBy.length === 0 ? (
        <p className="text-[0.7rem] text-muted-foreground">Not referenced by any token.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {usedBy.map((n) => (
            <span key={n} className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
