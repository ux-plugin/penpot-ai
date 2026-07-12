/**
 * Tokens sections — the "Tokens" left-rail tab (Design / Tokens), the single
 * surface for color/typography + token authoring. (The old Assets "styles" tab
 * was retired in P2.6 — tokens subsume styles.)
 *
 * Theme-first UI (P2.7d): the rail is a flat token list grouped by type. Sets &
 * themes are an internal detail — the everyday surface speaks only "token" and
 * "theme". A token that resolves to the same value in every theme shows one
 * editable value; a token that varies shows one editable line per theme (no
 * expand). A "Theme" switch up top picks which theme the canvas renders.
 *
 * Sets, theme membership, and the cross-theme compare table live behind an
 * "Advanced" disclosure for power users. Every edit still routes through the P2.3
 * CRUD, so propagation to bound shapes and single-frame undo are unchanged.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderTree,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Table2,
  X,
} from 'lucide-react'
import { useSnapshot } from 'valtio'
import { docProxy } from '../../renderer/store/doc-proxy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  duplicateNames,
  type SupportedTokenType,
  type Token,
  type TokenSet,
  type TokensLib,
  type TokenTheme,
  type TokenValue,
  type TypographyTokenValue,
} from '../../tokens/types'
import {
  addTheme,
  addToken,
  addTokenSet,
  deleteTheme,
  modifyTheme,
  deleteToken,
  deleteTokenSet,
  modifyToken,
  moveToken,
  setActiveThemes,
  ensureDefaultSet,
} from '../../tokens/crud'
import { applyToken, defaultApplyAttrs } from '../../tokens/apply'
import { type ResolvedToken, type ResolvedTokens } from '../../tokens/resolve'
import { useResolvedTokens } from '../../tokens/use-resolved-tokens'
import { TokensTableOverlay } from './TokensTableOverlay'
import { checkTokenValue, tokenValuePrefix } from '../../tokens/token-value-rules'
import {
  buildTokenTree,
  countTokenLeaves,
  pruneTokenTree,
  tokenNodeId,
  type TokenTreeNode,
} from '../../tokens/tree'

/** Types with a working create/apply in v1 (color/typography/borderRadius/opacity). */
const TYPE_SECTIONS: { type: SupportedTokenType; label: string }[] = [
  { type: 'color', label: 'Color' },
  { type: 'typography', label: 'Typography' },
  { type: 'borderRadius', label: 'Border radius' },
  { type: 'opacity', label: 'Opacity' },
]

const DISPLAY_TYPES = new Set<string>(TYPE_SECTIONS.map((s) => s.type))

// ── Value helpers ──────────────────────────────────────────────────────────────

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)
}

function isAlias(v: TokenValue | undefined): v is string {
  return typeof v === 'string' && /^\{.*\}$/.test(v)
}

function typographySummary(v: TokenValue | undefined): string {
  const t = (typeof v === 'object' ? v : {}) as Record<string, string>
  return [t.fontFamily, [t.fontSize, t.fontWeight].filter(Boolean).join(' / ')]
    .filter(Boolean)
    .join(' ')
}

/** One-line authored label for a token's value. */
function authoredText(t: Token | undefined): string {
  if (!t) return ''
  if (t.type === 'typography') return typographySummary(t.value)
  return typeof t.value === 'string' ? t.value : ''
}

async function applyToSelection(token: Token): Promise<void> {
  const attrs = defaultApplyAttrs(token)
  if (attrs.length === 0) return
  for (const id of [...docProxy.selectedIds]) {
    await applyToken(id, token.name, attrs)
  }
}

// ── Preview swatch ────────────────────────────────────────────────────────────

function DashedSwatch() {
  return (
    <span
      className="inline-block size-4 shrink-0 rounded border border-dashed border-muted-foreground/50"
      aria-hidden
    />
  )
}

function TokenPreview({ token, resolved }: { token: Token; resolved?: ResolvedToken }) {
  const errored = !!resolved?.errors?.length || resolved?.resolvedValue == null
  if (token.type === 'color') {
    const hex =
      typeof resolved?.resolvedValue === 'string'
        ? resolved.resolvedValue
        : isHex(token.value)
          ? (token.value as string)
          : undefined
    if (!hex) return <DashedSwatch />
    return (
      <span
        className="inline-block size-4 shrink-0 rounded border border-border"
        style={{ backgroundColor: hex }}
        aria-hidden
      />
    )
  }
  if (token.type === 'typography') {
    const v = (resolved?.resolvedValue as Record<string, string>) ?? {}
    return (
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-[0.65rem] font-medium leading-none text-foreground"
        style={{ fontFamily: v.fontFamily }}
        aria-hidden
      >
        Ag
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded border border-border bg-muted text-[0.55rem] font-medium text-muted-foreground',
        errored && 'border-dashed',
      )}
      aria-hidden
    >
      {token.type === 'opacity' ? '%' : 'r'}
    </span>
  )
}

// ── Value input (type prefix in front + range validation) ────────────────────

/**
 * A scalar value input with the value's TYPE shown as a prefix in front (e.g.
 * '#', '0–1', 'px') and a red border when the entry fails its range test. The
 * caller owns the value + validation; this is presentational.
 */
function ValueInput({
  prefix,
  invalid,
  className,
  ...rest
}: { prefix?: string; invalid?: boolean } & ComponentPropsWithoutRef<'input'>) {
  return (
    <div
      className={cn(
        'flex h-7 items-center overflow-hidden rounded-md border bg-background focus-within:border-ring',
        invalid ? 'border-destructive' : 'border-border',
        className,
      )}
    >
      {prefix ? (
        <span className="pointer-events-none border-r border-border px-1.5 text-[0.6rem] font-medium tracking-wide text-muted-foreground uppercase select-none">
          {prefix}
        </span>
      ) : null}
      <input
        className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground/60"
        {...rest}
      />
    </div>
  )
}

// ── Create / edit form ───────────────────────────────────────────────────────

interface FormProps {
  type: SupportedTokenType
  initial?: Token
  /** Optional node pinned to the top of the card (e.g. the Type picker). */
  header?: ReactNode
  /** All sets — the create form targets one (and detects name collisions). */
  sets: TokenSet[]
  onSave: (name: string, value: TokenValue, target: { setId?: string; newSetName?: string }) => void
  onCancel: () => void
}

function TokenForm({ type, initial, header, sets, onSave, onCancel }: FormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [text, setText] = useState(
    typeof initial?.value === 'string' ? initial.value : type === 'color' ? '#9CA3AF' : '',
  )
  const [typo, setTypo] = useState<TypographyTokenValue>(
    initial && typeof initial.value === 'object' ? (initial.value as TypographyTokenValue) : {},
  )
  // '' = auto-pick a target set; a set id; or '__new' to create a set inline.
  const [setChoice, setSetChoice] = useState<string>('')
  const [newSetName, setNewSetName] = useState('')

  const value: TokenValue = type === 'typography' ? typo : text
  const trimmed = name.trim()
  // The entered value is tested against its type's range; typography is composite.
  const valueCheck =
    type === 'typography' ? { ok: true, error: '', incomplete: false } : checkTokenValue(type, text)

  // Same name may live in several sets; collisions only block on a *type* clash.
  const usingNew = setChoice === '__new'
  const autoTargetId = sets[0]?.id
  const targetId = setChoice && !usingNew ? setChoice : autoTargetId
  const targetSet = sets.find((s) => s.id === targetId)
  // Permissive: a name already in the target set just becomes a duplicate
  // (flagged in the list; the resolver keeps the first occurrence).
  const willDuplicate = !usingNew && !!targetSet && targetSet.tokens.some((t) => t.name === trimmed)

  const canSave =
    trimmed.length > 0 && valueCheck.ok && (!usingNew || newSetName.trim().length > 0)
  const submit = () => {
    if (!canSave) return
    onSave(trimmed, value, usingNew ? { newSetName: newSetName.trim() } : { setId: targetId })
  }

  return (
    <li className="rounded-md bg-muted/40 px-2 py-2">
      <div className="space-y-1.5">
        {header}
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${type}.name`}
          className="h-7 text-xs"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
        />
        {type === 'color' && (
          <>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(text) ? text : '#9CA3AF'}
              onChange={(e) => setText(e.target.value)}
              className="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              aria-label="Color value"
            />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="#RRGGBB or {alias}"
              className="h-7 flex-1 text-xs"
            />
          </div>
          {!valueCheck.ok && valueCheck.error && (
            <p className="text-[0.65rem] text-destructive">{valueCheck.error}</p>
          )}
          </>
        )}
        {type === 'typography' && (
          <div className="space-y-1.5">
            <Input
              value={typo.fontFamily ?? ''}
              onChange={(e) => setTypo((t) => ({ ...t, fontFamily: e.target.value }))}
              placeholder="Font family"
              className="h-7 text-xs"
            />
            <div className="flex gap-1.5">
              <Input
                value={typo.fontSize ?? ''}
                onChange={(e) => setTypo((t) => ({ ...t, fontSize: e.target.value }))}
                placeholder="Size"
                className="h-7 text-xs"
              />
              <Input
                value={typo.fontWeight ?? ''}
                onChange={(e) => setTypo((t) => ({ ...t, fontWeight: e.target.value }))}
                placeholder="Weight"
                className="h-7 text-xs"
              />
            </div>
          </div>
        )}
        {(type === 'borderRadius' || type === 'opacity') && (
          <div className="space-y-0.5">
            <ValueInput
              prefix={tokenValuePrefix(type)}
              invalid={!valueCheck.incomplete && !valueCheck.ok}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={type === 'opacity' ? '0–1 or {alias}' : 'number or {alias}'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
            {!valueCheck.ok && valueCheck.error && (
              <p className="text-[0.65rem] text-destructive">{valueCheck.error}</p>
            )}
          </div>
        )}
        {sets.length > 0 && (
          <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            Set
            <select
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
              value={usingNew ? '__new' : (targetId ?? '')}
              aria-label="Target set"
              onChange={(e) => setSetChoice(e.target.value)}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="__new">＋ New set…</option>
            </select>
          </label>
        )}
        {usingNew && (
          <Input
            value={newSetName}
            onChange={(e) => setNewSetName(e.target.value)}
            placeholder="New set name"
            className="h-7 text-xs"
          />
        )}
        {willDuplicate && (
          <p className="text-[0.65rem] text-amber-600">
            “{trimmed}” already exists in {targetSet?.name} — creates a duplicate (the resolver keeps the
            first).
          </p>
        )}
        <div className="flex justify-end gap-1">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" onClick={onCancel}>
            <X />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Save token"
            disabled={!canSave}
            onClick={submit}
          >
            <Check />
          </Button>
        </div>
      </div>
    </li>
  )
}

// ── Definitions (one card per token entry — a name in a specific set) ─────────

interface Def {
  set: TokenSet
  token: Token
}

/** Every token of a supported type, one entry per (set, token), grouped by type. */
function definitionsByType(lib: TokensLib | undefined): Record<string, Def[]> {
  const out: Record<string, Def[]> = {}
  for (const set of lib?.sets ?? []) {
    for (const token of set.tokens) {
      if (DISPLAY_TYPES.has(token.type)) (out[token.type] ??= []).push({ set, token })
    }
  }
  // Sort by name so same-name definitions sit next to each other; the outer loop
  // walks sets in lib order, and the sort is stable, so equal names keep set order.
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.token.name.localeCompare(b.token.name))
  return out
}

/** Same name appears more than once in this set → a true duplicate. */
function isDuplicateInSet(set: TokenSet, name: string): boolean {
  let n = 0
  for (const t of set.tokens) {
    if (t.name === name) n += 1
    if (n > 1) return true
  }
  return false
}

type OpenDef = (setId: string, tokenId: string) => void

function SetChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
      {children}
    </span>
  )
}

function DupBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[0.55rem] font-medium text-amber-600"
      title="Same name appears more than once in this set"
    >
      {compact ? 'dup' : 'duplicate'}
    </span>
  )
}

/** Swatch hex for a color token — its own literal, or resolved when it's an alias. */
function colorHexOf(token: Token, resolved: ResolvedTokens): string | undefined {
  if (token.type !== 'color') return undefined
  if (isHex(token.value)) return token.value
  const r = resolved.get(token.name)?.resolvedValue
  return typeof r === 'string' ? r : undefined
}

/** Type-appropriate visual for a single token's own value. */
function DefVisual({ token, resolved }: { token: Token; resolved: ResolvedTokens }) {
  if (token.type === 'color') {
    const hex = colorHexOf(token, resolved)
    return (
      <span
        className="flex h-9 w-full items-center justify-center"
        style={hex ? { backgroundColor: hex } : undefined}
      >
        {!hex && <span className="text-[0.6rem] text-muted-foreground">unresolved</span>}
      </span>
    )
  }
  if (token.type === 'typography') {
    const tv = (typeof token.value === 'object' ? token.value : {}) as Record<string, string>
    return (
      <span className="flex h-9 w-full items-center px-2 text-lg leading-none" style={{ fontFamily: tv.fontFamily }}>
        Ag
      </span>
    )
  }
  if (token.type === 'borderRadius') {
    const rad = Number(typeof token.value === 'string' ? token.value : 0) || 0
    return (
      <span className="flex h-9 w-full items-center justify-center bg-muted/50">
        <span className="size-6 border-2 border-muted-foreground/50" style={{ borderRadius: Math.min(rad, 20) }} />
      </span>
    )
  }
  const op = Math.max(0, Math.min(1, Number(typeof token.value === 'string' ? token.value : 1)))
  return (
    <span className="flex h-9 w-full items-center justify-center bg-muted/50">
      <span className="size-6 rounded-full bg-foreground" style={{ opacity: op }} />
    </span>
  )
}

// ── Token card (one per definition) ───────────────────────────────────────────

function TokenCard({
  set,
  token,
  resolved,
  onOpen,
}: {
  set: TokenSet
  token: Token
  resolved: ResolvedTokens
  onOpen: OpenDef
}) {
  const dup = isDuplicateInSet(set, token.name)
  return (
    <button
      type="button"
      data-token-card={token.name}
      data-token-card-id={token.id}
      data-token-card-set={set.name}
      onClick={() => onOpen(set.id, token.id)}
      className="group flex flex-col overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-foreground/30"
    >
      <DefVisual token={token} resolved={resolved} />
      <span className="border-t border-border px-2 py-1">
        <span className="block truncate font-mono text-[0.7rem]" title={token.name}>
          {token.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          <SetChip>{set.name}</SetChip>
          <span className="min-w-0 flex-1 truncate text-[0.6rem] text-muted-foreground">
            {authoredText(token) || '—'}
          </span>
          {dup && <DupBadge />}
        </span>
      </span>
    </button>
  )
}

// ── List row (one per definition) ─────────────────────────────────────────────

function TokenListItem({
  set,
  token,
  resolved,
  onOpen,
}: {
  set: TokenSet
  token: Token
  resolved: ResolvedTokens
  onOpen: OpenDef
}) {
  const dup = isDuplicateInSet(set, token.name)
  return (
    <li>
      <button
        type="button"
        data-token-row={token.name}
        data-token-row-id={token.id}
        onClick={() => onOpen(set.id, token.id)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
      >
        <TokenPreview token={token} resolved={isAlias(token.value) ? resolved.get(token.name) : undefined} />
        <span className="min-w-0 flex-1 truncate text-left">{token.name}</span>
        <SetChip>{set.name}</SetChip>
        {dup && <DupBadge compact />}
        <span className="shrink-0 truncate text-xs tabular-nums text-muted-foreground">
          {authoredText(token)}
        </span>
      </button>
    </li>
  )
}

// ── Folder tree view (sets as folders, tokens as files) ──────────────────────

const TREE_INDENT = 12

function TokenTree({
  nodes,
  resolved,
  collapsed,
  onToggle,
  onOpen,
  selectedId,
}: {
  nodes: TokenTreeNode[]
  resolved: ResolvedTokens
  collapsed: Set<string>
  onToggle: (id: string) => void
  onOpen: OpenDef
  selectedId?: string
}) {
  return (
    <div className="px-1" data-token-tree>
      {nodes.map((n) => (
        <TreeRow
          key={n.id}
          node={n}
          depth={0}
          resolved={resolved}
          collapsed={collapsed}
          onToggle={onToggle}
          onOpen={onOpen}
          selectedId={selectedId}
        />
      ))}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  resolved,
  collapsed,
  onToggle,
  onOpen,
  selectedId,
}: {
  node: TokenTreeNode
  depth: number
  resolved: ResolvedTokens
  collapsed: Set<string>
  onToggle: (id: string) => void
  onOpen: OpenDef
  selectedId?: string
}) {
  const pad = 4 + depth * TREE_INDENT

  if (node.kind === 'token') {
    const hex = colorHexOf(node.token, resolved)
    const selected = selectedId === node.id
    return (
      <button
        type="button"
        data-token-tree-token={node.token.name}
        title={node.token.name}
        className={cn(
          'flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left text-xs hover:bg-muted/60',
          selected && 'bg-accent',
        )}
        style={{ paddingLeft: pad + 16 }}
        onClick={() => onOpen(node.set.id, node.token.id)}
      >
        {hex ? (
          <span
            className="size-3 shrink-0 rounded border border-border"
            style={{ backgroundColor: hex }}
            aria-hidden
          />
        ) : (
          <span className="size-3 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="max-w-24 shrink-0 truncate font-mono text-[0.65rem] text-muted-foreground">
          {authoredText(node.token)}
        </span>
      </button>
    )
  }

  const isOpen = !collapsed.has(node.id)
  return (
    <>
      <button
        type="button"
        data-token-tree-node={node.name}
        className="flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left text-xs hover:bg-muted/60"
        style={{ paddingLeft: pad }}
        aria-expanded={isOpen}
        onClick={() => onToggle(node.id)}
      >
        {isOpen ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        {node.kind === 'set' ? (
          <Boxes className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : node.kind === 'folder' ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}
        <span className={cn('min-w-0 flex-1 truncate', node.kind === 'group' && 'text-muted-foreground')}>
          {node.name}
        </span>
        <span className="shrink-0 text-[0.65rem] text-muted-foreground">{countTokenLeaves(node)}</span>
      </button>
      {isOpen &&
        node.children.map((c) => (
          <TreeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            resolved={resolved}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpen={onOpen}
            selectedId={selectedId}
          />
        ))}
    </>
  )
}

// ── Token editor (one definition: value, name, set, delete) ───────────────────

function TokenEditor({
  lib,
  setId,
  tokenId,
  resolved,
  anchorRef,
  onClose,
}: {
  lib: TokensLib
  setId: string
  tokenId: string
  resolved: ResolvedTokens
  anchorRef: { current: HTMLElement | null }
  onClose: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [editingValue, setEditingValue] = useState(false)
  const [valueDraft, setValueDraft] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Close on click outside the editor AND outside the tokens panel, so
    // clicking another tree row just switches which token is edited.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose, anchorRef])

  // Measure the tokens panel (after render) to place the editor beside it.
  useLayoutEffect(() => {
    const measure = () => setAnchor(anchorRef.current?.getBoundingClientRect() ?? null)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [anchorRef])

  const set = lib.sets.find((s) => s.id === setId)
  const token = set?.tokens.find((t) => t.id === tokenId)
  if (!set || !token) return null

  const editable = token.type !== 'typography'
  const dup = isDuplicateInSet(set, token.name)
  const otherSets = lib.sets
    .filter((s) => s.id !== setId && s.tokens.some((t) => t.name === token.name))
    .map((s) => s.name)
  const hex = colorHexOf(token, resolved)
  const alias = isAlias(token.value)
  const valueCheck = checkTokenValue(token.type as SupportedTokenType, valueDraft)

  const commitRename = async () => {
    setRenaming(false)
    const nm = nameDraft.trim()
    if (nm && nm !== token.name) await modifyToken(setId, tokenId, { ...token, name: nm })
  }
  const commitValue = async () => {
    if (!valueCheck.ok) return // keep editing so the range error stays visible
    setEditingValue(false)
    if (typeof token.value === 'string' && valueDraft !== token.value) {
      await modifyToken(setId, tokenId, { ...token, value: valueDraft })
    }
  }
  const move = async (toSetId: string) => {
    if (toSetId !== setId) {
      onClose()
      await moveToken(setId, toSetId, tokenId)
    }
  }
  const del = async () => {
    onClose()
    await deleteToken(setId, tokenId)
  }

  const W = 288
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  // Open just to the RIGHT of the tokens panel (color-picker side-panel space).
  const left = Math.round(Math.min(anchor ? anchor.right + 8 : 320, vw - W - 8))
  const top = Math.round(Math.max(8, Math.min(anchor ? anchor.top : 80, vh - 320)))

  const body = (
    <div
      ref={panelRef}
      className="fixed z-50 w-[288px] overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      style={{ left, top }}
      role="dialog"
      aria-label={`Edit token ${token.name}`}
    >
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          <TokenPreview token={token} resolved={alias ? resolved.get(token.name) : undefined} />
          {renaming ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="h-6 flex-1 text-xs"
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={token.name}>
              {token.name}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label="Rename token"
            title="Rename"
            onClick={() => {
              setNameDraft(token.name)
              setRenaming(true)
            }}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label="Close editor"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        <div className="space-y-2 p-2">
          <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            Set
            <select
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
              value={setId}
              aria-label="Set"
              onChange={(e) => void move(e.target.value)}
            >
              {lib.sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[0.7rem] text-muted-foreground">Value</span>
            {editingValue ? (
              <div className="flex-1 space-y-0.5">
                <ValueInput
                  autoFocus
                  prefix={tokenValuePrefix(token.type as SupportedTokenType)}
                  invalid={!valueCheck.incomplete && !valueCheck.ok}
                  value={valueDraft}
                  onChange={(e) => setValueDraft(e.target.value)}
                  onBlur={() => (valueCheck.ok ? void commitValue() : setEditingValue(false))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitValue()
                    if (e.key === 'Escape') setEditingValue(false)
                  }}
                />
                {!valueCheck.ok && valueCheck.error && (
                  <p className="text-[0.65rem] text-destructive">{valueCheck.error}</p>
                )}
              </div>
            ) : (
              <button
                type="button"
                disabled={!editable}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-xs',
                  editable && 'hover:bg-muted',
                )}
                title={editable ? 'Edit value' : 'Composite — edit on create'}
                onClick={() => {
                  setValueDraft(typeof token.value === 'string' ? token.value : '')
                  setEditingValue(true)
                }}
              >
                {hex && (
                  <span
                    className="size-3 shrink-0 rounded border border-border"
                    style={{ backgroundColor: hex }}
                    aria-hidden
                  />
                )}
                <span className={cn('truncate', alias && 'italic text-muted-foreground')}>
                  {authoredText(token) || '—'}
                </span>
              </button>
            )}
          </div>

          {dup && (
            <p className="text-[0.65rem] text-amber-600">
              Duplicate in {set.name} — rename this one or move it to another set. The first entry in a set
              is the one that resolves.
            </p>
          )}
          {otherSets.length > 0 && (
            <p className="text-[0.65rem] text-muted-foreground">
              Also defined in {otherSets.join(', ')}.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => void applyToSelection(token)}
          >
            Apply to selection
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            onClick={() => void del()}
          >
            Delete
          </Button>
        </div>
    </div>
  )

  return createPortal(body, document.body)
}

// ── Type group (definition gallery) ───────────────────────────────────────────

function TokenTypeGroup({
  type,
  label,
  defs,
  lib,
  resolved,
  view,
  filtering,
  onOpen,
}: {
  type: SupportedTokenType
  label: string
  defs: Def[]
  lib: TokensLib | undefined
  resolved: ResolvedTokens
  view: 'cards' | 'list'
  filtering: boolean
  onOpen: OpenDef
}) {
  const [open, setOpen] = useState(true)
  const [creating, setCreating] = useState(false)
  // An active filter forces the group open so its matches are always visible.
  const expanded = open || filtering

  const onCreate = useCallback(
    async (name: string, value: TokenValue, target: { setId?: string; newSetName?: string }) => {
      setCreating(false)
      let setId = target.setId
      if (target.newSetName) {
        const set = createTokenSet({ name: target.newSetName })
        await addTokenSet(set)
        setId = set.id
      }
      if (!setId) setId = lib?.sets[0]?.id ?? (await ensureDefaultSet())
      // Always add a new entry. A same-name entry in the same set is allowed and
      // is shown flagged as a duplicate (the resolver keeps the first).
      await addToken(setId, createToken({ name, type, value }))
    },
    [lib, type],
  )

  const gridCols = type === 'typography' ? 'grid-cols-1' : 'grid-cols-2'

  return (
    <section data-token-type={type}>
      <div className="flex items-center pl-1 pr-0.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 rounded-md py-1 pl-0.5 pr-1 text-left hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
        </button>
        <span className="min-w-4 text-right text-xs tabular-nums text-muted-foreground">{defs.length}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={`Add ${label} token`}
          title={`Add ${label} token`}
          onClick={() => {
            setOpen(true)
            setCreating(true)
          }}
        >
          <Plus />
        </Button>
      </div>
      {expanded && (
        <div className="mt-0.5 space-y-1.5">
          {creating && (
            <ul className="list-none p-0">
              <TokenForm
                type={type}
                sets={lib?.sets ?? []}
                onSave={onCreate}
                onCancel={() => setCreating(false)}
              />
            </ul>
          )}
          {defs.length === 0 && !creating && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No {label.toLowerCase()} tokens yet</p>
          )}
          {defs.length > 0 && view === 'cards' && (
            <div className={cn('grid gap-1.5 px-1', gridCols)}>
              {defs.map((d) => (
                <TokenCard
                  key={`${d.set.id}:${d.token.id}`}
                  set={d.set}
                  token={d.token}
                  resolved={resolved}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
          {defs.length > 0 && view === 'list' && (
            <ul className="list-none space-y-0.5 p-0">
              {defs.map((d) => (
                <TokenListItem
                  key={`${d.set.id}:${d.token.id}`}
                  set={d.set}
                  token={d.token}
                  resolved={resolved}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

// ── Filter bar (active theme + set visibility) ───────────────────────────────

/**
 * Toolbar FILTER control — a two-section popover that narrows which tokens the
 * list shows WITHOUT changing any value. "By theme" includes only tokens from
 * the chosen themes' sets; "By set" narrows further. Nothing selected = show
 * everything; choosing themes also narrows the sets offered below. Theme
 * *activation* (the live mode) is separate — the toggle in front of each theme
 * in the Themes section.
 */
function FilterBar({
  lib,
  themeFilter,
  setFilter,
  onToggleTheme,
  onToggleSet,
  onReset,
}: {
  lib: TokensLib | undefined
  themeFilter: Set<string>
  setFilter: Set<string>
  onToggleTheme: (themeId: string) => void
  onToggleSet: (setId: string) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [setQuery, setSetQuery] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const themes = lib?.themes ?? []
  const allSets = lib?.sets ?? []
  const availableNames = themesFilterSetNames(lib, themeFilter)
  const availableSets = availableNames === null ? allSets : allSets.filter((s2) => availableNames.has(s2.name))

  const sq = setQuery.trim().toLowerCase()
  const shownSetRows = sq ? availableSets.filter((x) => x.name.toLowerCase().includes(sq)) : availableSets
  const active = themeFilter.size > 0 || setFilter.size > 0

  const openMenu = () => {
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    setOpen(true)
  }

  const W = 256
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = rect ? Math.round(Math.min(Math.max(8, rect.left), vw - W - 8)) : 8
  const top = rect ? Math.round(Math.max(8, Math.min(rect.bottom + 6, vh - 380))) : 8

  const menu =
    open && rect
      ? createPortal(
          <div className="fixed inset-0 z-50" onMouseDown={() => setOpen(false)}>
            <div
              className="absolute overflow-hidden rounded-lg border border-border bg-background shadow-xl"
              style={{ left, top, width: W }}
              role="dialog"
              aria-label="Filter tokens"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center px-2.5 pt-2 pb-1">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  Filter
                </span>
                {active && (
                  <button
                    type="button"
                    className="ml-auto text-[0.65rem] text-muted-foreground hover:text-foreground"
                    onClick={onReset}
                  >
                    Reset
                  </button>
                )}
              </div>

              {themes.length > 0 && (
                <div className="pb-1">
                  <div className="px-2.5 pb-0.5 text-[0.65rem] font-medium tracking-wide text-muted-foreground">
                    By theme
                  </div>
                  <p className="px-2.5 pb-1 text-[0.6rem] text-muted-foreground">None selected = all themes.</p>
                  <div className="max-h-32 overflow-y-auto px-1">
                    {themes.map((t) => (
                      <label
                        key={t.id}
                        data-token-theme-filter={t.name}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                      >
                        <input type="checkbox" checked={themeFilter.has(t.id)} onChange={() => onToggleTheme(t.id)} />
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="shrink-0 text-[0.6rem] text-muted-foreground">
                          {t.sets.length === 1 ? '1 set' : `${t.sets.length} sets`}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className={cn('pb-1.5', themes.length > 0 && 'border-t border-border pt-1')}>
                <div className="px-2.5 pb-0.5 text-[0.65rem] font-medium tracking-wide text-muted-foreground">
                  By set
                </div>
                <p className="px-2.5 pb-1 text-[0.6rem] text-muted-foreground">
                  {themeFilter.size > 0 ? 'Sets used by the chosen themes.' : 'None selected = all sets.'}
                </p>
                {availableSets.length > 8 && (
                  <div className="px-2 pb-1">
                    <input
                      value={setQuery}
                      onChange={(e) => setSetQuery(e.target.value)}
                      placeholder="Filter sets…"
                      aria-label="Filter sets"
                      className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
                    />
                  </div>
                )}
                {availableSets.length === 0 ? (
                  <p className="px-2.5 pb-1 text-[0.65rem] text-muted-foreground">No sets to filter.</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto px-1">
                    {shownSetRows.map((x) => (
                      <label
                        key={x.id}
                        data-token-set-filter={x.name}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                      >
                        <input type="checkbox" checked={setFilter.has(x.id)} onChange={() => onToggleSet(x.id)} />
                        <span className="min-w-0 flex-1 truncate">{x.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-token-filter-trigger=""
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:border-ring"
        aria-label="Filter tokens"
        aria-expanded={open}
        title="Filter tokens by theme or set"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
        <span>Filter</span>
        {active && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {menu}
    </>
  )
}

// ── Theme create / edit form (name + set membership + inline new set) ─────────

function ThemeForm({
  lib,
  initial,
  onClose,
}: {
  lib: TokensLib | undefined
  initial?: TokenTheme
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [sets, setSets] = useState<Set<string>>(new Set(initial?.sets ?? []))
  const [newSet, setNewSet] = useState<string | null>(null)

  const allSets = lib?.sets ?? []
  const canSave = name.trim().length > 0

  const toggle = (setName: string, on: boolean) =>
    setSets((prev) => {
      const next = new Set(prev)
      if (on) next.add(setName)
      else next.delete(setName)
      return next
    })

  const addSetInline = async () => {
    const nm = (newSet ?? '').trim()
    if (!nm) return
    await addTokenSet(createTokenSet({ name: nm }))
    setSets((prev) => new Set(prev).add(nm))
    setNewSet(null)
  }

  const save = async () => {
    if (!canSave) return
    const nm = name.trim()
    if (initial) await modifyTheme(initial.id, { ...initial, name: nm, sets: [...sets] })
    else await addTheme(createTokenTheme({ name: nm, group: '', sets: [...sets] }))
    onClose()
  }

  return (
    <div className="space-y-1.5 rounded-md bg-muted/40 px-2 py-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Theme name (e.g. Dark)"
        className="h-7 text-xs"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Include sets</div>
      <div className="space-y-0.5">
        {allSets.length === 0 && newSet === null && (
          <p className="text-[0.65rem] text-muted-foreground">No sets yet — add one below.</p>
        )}
        {allSets.map((s) => (
          <label key={s.id} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={sets.has(s.name)}
              onChange={(e) => toggle(s.name, e.target.checked)}
            />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 text-[0.65rem] text-muted-foreground">
              {s.tokens.length}
            </span>
          </label>
        ))}
        {newSet !== null ? (
          <div className="flex items-center gap-1">
            <Input
              value={newSet}
              onChange={(e) => setNewSet(e.target.value)}
              placeholder="New set name"
              className="h-7 flex-1 text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addSetInline()
                if (e.key === 'Escape') setNewSet(null)
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Save new set"
              onClick={() => void addSetInline()}
            >
              <Check />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="flex items-center gap-1 px-0.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setNewSet('')}
          >
            <Plus className="size-3" /> New set…
          </button>
        )}
      </div>
      <div className="flex justify-end gap-1 pt-0.5">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" onClick={onClose}>
          <X />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Save theme"
          disabled={!canSave}
          onClick={() => void save()}
        >
          <Check />
        </Button>
      </div>
    </div>
  )
}

// ── Set role (derived from theme membership — no stored flag) ─────────────────

function setRole(
  lib: TokensLib | undefined,
  setName: string,
): { label: string; tone: 'success' | 'secondary' | 'muted' } {
  const themes = lib?.themes ?? []
  if (themes.length === 0) return { label: '', tone: 'muted' }
  const inThemes = themes.filter((t) => t.sets.includes(setName))
  if (inThemes.length === 0) return { label: 'source', tone: 'muted' }
  if (inThemes.length === themes.length) return { label: 'always on', tone: 'success' }
  return { label: `in ${inThemes.map((t) => t.name).join(', ')}`, tone: 'secondary' }
}

// ── Sets & themes definition (visible — not buried in Advanced) ───────────────

function SetsThemesSection({
  lib,
  creating,
  onNewTheme,
  onCloseCreate,
}: {
  lib: TokensLib | undefined
  creating: boolean
  onNewTheme: () => void
  onCloseCreate: () => void
}) {
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null)
  const [newSet, setNewSet] = useState<string | null>(null)

  const sets = lib?.sets ?? []
  const themes = lib?.themes ?? []
  const active = new Set(lib?.activeThemes ?? [])

  const saveSet = async () => {
    const nm = (newSet ?? '').trim()
    if (!nm) return
    await addTokenSet(createTokenSet({ name: nm }))
    setNewSet(null)
  }

  return (
    <section className="space-y-2 border-t border-border pt-2">
      {/* Themes */}
      <div>
        <div className="flex items-center justify-between px-1 py-0.5">
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Themes
          </span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Add theme" onClick={onNewTheme}>
            <Plus />
          </Button>
        </div>
        <ul className="list-none space-y-0.5 p-0">
          {themes.length === 0 && !creating && (
            <li className="px-2 py-1 text-xs text-muted-foreground">
              No themes — values come from all sets.
            </li>
          )}
          {creating && (
            <li>
              <ThemeForm lib={lib} onClose={onCloseCreate} />
            </li>
          )}
          {themes.map((t) =>
            editingThemeId === t.id ? (
              <li key={t.id}>
                <ThemeForm lib={lib} initial={t} onClose={() => setEditingThemeId(null)} />
              </li>
            ) : (
              <li key={t.id}>
                <div
                  className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted/60"
                  data-token-theme={t.name}
                >
                  <button
                    type="button"
                    aria-label={active.has(t.id) ? `Deactivate theme ${t.name}` : `Activate theme ${t.name}`}
                    aria-pressed={active.has(t.id)}
                    title={active.has(t.id) ? 'Active — click to turn off' : 'Activate this theme'}
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                      active.has(t.id)
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-muted-foreground/40 text-transparent hover:border-foreground',
                    )}
                    onClick={() => void setActiveThemes(active.has(t.id) ? [] : [t.id])}
                  >
                    <Check className="size-2.5" aria-hidden />
                  </button>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="shrink-0 text-[0.65rem] text-muted-foreground">
                    {t.sets.length === 1 ? '1 set' : `${t.sets.length} sets`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Edit theme ${t.name}`}
                    title="Edit sets"
                    onClick={() => setEditingThemeId(t.id)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Delete theme ${t.name}`}
                    onClick={() => void deleteTheme(t.id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      </div>

      {/* Sets */}
      <div>
        <div className="flex items-center justify-between px-1 py-0.5">
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Sets
          </span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Add set" onClick={() => setNewSet('')}>
            <Plus />
          </Button>
        </div>
        <ul className="list-none space-y-0.5 p-0">
          {sets.length === 0 && newSet === null && (
            <li className="px-2 py-1 text-xs text-muted-foreground">No sets yet.</li>
          )}
          {sets.map((s) => {
            const role = setRole(lib, s.name)
            const dupCount = duplicateNames(s).size
            return (
              <li key={s.id}>
                <div
                  className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted/60"
                  data-token-set={s.name}
                >
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {role.label && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem]',
                        role.tone === 'success' && 'bg-emerald-500/15 text-emerald-600',
                        role.tone === 'secondary' && 'bg-muted text-muted-foreground',
                        role.tone === 'muted' && 'text-muted-foreground',
                      )}
                    >
                      {role.label}
                    </span>
                  )}
                  {dupCount > 0 && (
                    <span
                      className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-amber-600"
                      title="This set has more than one token with the same name"
                    >
                      {dupCount === 1 ? '1 duplicate' : `${dupCount} duplicates`}
                    </span>
                  )}
                  <span className="shrink-0 text-[0.65rem] text-muted-foreground">
                    {s.tokens.length}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Delete set ${s.name}`}
                    onClick={() => void deleteTokenSet(s.id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            )
          })}
          {newSet !== null && (
            <li className="flex items-center gap-1 px-1 py-0.5">
              <Input
                value={newSet}
                onChange={(e) => setNewSet(e.target.value)}
                placeholder="Set name"
                className="h-7 flex-1 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveSet()
                  if (e.key === 'Escape') setNewSet(null)
                }}
              />
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Save set" onClick={() => void saveSet()}>
                <Check />
              </Button>
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}

// ── Advanced (compare table only) ─────────────────────────────────────────────

function AdvancedSection({
  lib,
  onOpenTable,
}: {
  lib: TokensLib | undefined
  onOpenTable: () => void
}) {
  const [open, setOpen] = useState(false)
  const hasSets = (lib?.sets.length ?? 0) > 0

  return (
    <section className="border-t border-border pt-1">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md py-1 pl-1 pr-1 text-left hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Advanced
        </span>
      </button>
      {open && (
        <div className="px-1 pb-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
            disabled={!hasSets}
            onClick={onOpenTable}
          >
            <Table2 className="size-3.5" /> Compare all themes (table)
          </Button>
        </div>
      )}
    </section>
  )
}

// ── Public composite ─────────────────────────────────────────────────────────

/** Case-insensitive search over a definition — matches name, set, or value text. */
function defMatches(d: Def, q: string): boolean {
  if (!q) return true
  return `${d.token.name} ${d.set.name} ${authoredText(d.token)}`.toLowerCase().includes(q)
}

/** Set NAMES enabled by the theme filter, or null when no theme is chosen (⇒ all sets). */
function themesFilterSetNames(lib: TokensLib | undefined, themeFilter: Set<string>): Set<string> | null {
  if (themeFilter.size === 0) return null
  const names = new Set<string>()
  for (const t of lib?.themes ?? []) if (themeFilter.has(t.id)) for (const n of t.sets) names.add(n)
  return names
}

/** Render the theme switch, the token list, and Sets & themes definition. */
function NewTokenControl({ lib }: { lib: TokensLib | undefined }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<SupportedTokenType>('color')

  const onCreate = async (
    name: string,
    value: TokenValue,
    target: { setId?: string; newSetName?: string },
  ) => {
    setOpen(false)
    let setId = target.setId
    if (target.newSetName) {
      const set = createTokenSet({ name: target.newSetName })
      await addTokenSet(set)
      setId = set.id
    }
    if (!setId) setId = lib?.sets[0]?.id ?? (await ensureDefaultSet())
    await addToken(setId, createToken({ name, type, value }))
  }

  if (!open) {
    return (
      <button
        type="button"
        data-token-new
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" /> New token
      </button>
    )
  }
  return (
    <ul className="list-none p-0">
      <TokenForm
        key={type}
        type={type}
        header={
          <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            Type
            <select
              className="h-7 flex-1 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
              value={type}
              aria-label="New token type"
              onChange={(e) => setType(e.target.value as SupportedTokenType)}
            >
              {TYPE_SECTIONS.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        }
        sets={lib?.sets ?? []}
        onSave={onCreate}
        onCancel={() => setOpen(false)}
      />
    </ul>
  )
}

export function TokensSections() {
  const doc = useSnapshot(docProxy)
  const lib = doc.meta?.tokens as TokensLib | undefined
  const [tableOpen, setTableOpen] = useState(false)
  const [creatingTheme, setCreatingTheme] = useState(false)
  const [view, setView] = useState<'tree' | 'cards' | 'list'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<{ setId: string; tokenId: string } | null>(null)

  const [query, setQuery] = useState('')
  const [themeFilter, setThemeFilter] = useState<Set<string>>(new Set())
  const [setFilter, setSetFilter] = useState<Set<string>>(new Set())

  const resolved = useResolvedTokens()
  const defsByType = useMemo(() => definitionsByType(lib), [lib])

  const q = query.trim().toLowerCase()
  const availableNames = useMemo(() => themesFilterSetNames(lib, themeFilter), [lib, themeFilter])
  const filtering = q.length > 0 || themeFilter.size > 0 || setFilter.size > 0
  const filteredByType = useMemo(() => {
    const out: Record<string, Def[]> = {}
    for (const [type, defs] of Object.entries(defsByType)) {
      out[type] = defs.filter(
        (d) =>
          (availableNames === null || availableNames.has(d.set.name)) &&
          (setFilter.size === 0 || setFilter.has(d.set.id)) &&
          defMatches(d, q),
      )
    }
    return out
  }, [defsByType, q, availableNames, setFilter])
  const totalMatches = useMemo(
    () => Object.values(filteredByType).reduce((n, d) => n + d.length, 0),
    [filteredByType],
  )

  const fullTree = useMemo(() => buildTokenTree(lib), [lib])
  const treeNodes = useMemo(() => {
    if (!filtering) return fullTree
    const visible = new Set<string>()
    for (const defs of Object.values(filteredByType))
      for (const d of defs) visible.add(tokenNodeId(d.set.id, d.token.id))
    return pruneTokenTree(fullTree, visible)
  }, [fullTree, filtering, filteredByType])

  const toggleTheme = (id: string) =>
    setThemeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleSet = (id: string) =>
    setSetFilter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const resetFilters = () => {
    setThemeFilter(new Set())
    setSetFilter(new Set())
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onOpen: OpenDef = (setId, tokenId) => setEditing({ setId, tokenId })

  return (
    <div ref={rootRef} className="space-y-2">
      <div className="flex items-center gap-1.5 px-1">
        <FilterBar
          lib={lib}
          themeFilter={themeFilter}
          setFilter={setFilter}
          onToggleTheme={toggleTheme}
          onToggleSet={toggleSet}
          onReset={resetFilters}
        />
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tokens…"
            aria-label="Search tokens"
            className="h-7 w-full min-w-0 rounded-md border border-border bg-background pl-6 pr-6 text-xs outline-none focus:border-ring"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery('')}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Token view">
          <button
            type="button"
            aria-label="Tree view"
            aria-pressed={view === 'tree'}
            title="Folder tree"
            className={cn(
              'rounded p-1 transition-colors',
              view === 'tree' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setView('tree')}
          >
            <FolderTree className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Card view"
            aria-pressed={view === 'cards'}
            title="Card view"
            className={cn(
              'rounded p-1 transition-colors',
              view === 'cards' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setView('cards')}
          >
            <LayoutGrid className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === 'list'}
            title="List view"
            className={cn(
              'rounded p-1 transition-colors',
              view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setView('list')}
          >
            <List className="size-3.5" />
          </button>
        </div>
      </div>
      {view === 'tree' ? (
        <div className="space-y-1 px-1">
          <NewTokenControl lib={lib} />
          {treeNodes.length === 0 ? (
            <p className="px-1 py-1 text-xs text-muted-foreground">
              {filtering ? 'No tokens match the filters.' : 'No tokens yet — use New token to add one.'}
            </p>
          ) : (
            <TokenTree
              nodes={treeNodes}
              resolved={resolved}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onOpen={onOpen}
              selectedId={editing ? tokenNodeId(editing.setId, editing.tokenId) : undefined}
            />
          )}
        </div>
      ) : (
        <>
      {TYPE_SECTIONS.map((s) => {
        const defs = filteredByType[s.type] ?? []
        // While filtering, hide type groups that have no matches.
        if (filtering && defs.length === 0) return null
        return (
          <TokenTypeGroup
            key={s.type}
            type={s.type}
            label={s.label}
            defs={defs}
            lib={lib}
            resolved={resolved}
            view={view}
            filtering={filtering}
            onOpen={onOpen}
          />
        )
      })}
      {filtering && totalMatches === 0 && (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {q ? `No tokens match “${query.trim()}”.` : 'No tokens match the filters.'}
        </p>
      )}
        </>
      )}
      <SetsThemesSection
        lib={lib}
        creating={creatingTheme}
        onNewTheme={() => setCreatingTheme(true)}
        onCloseCreate={() => setCreatingTheme(false)}
      />
      <AdvancedSection lib={lib} onOpenTable={() => setTableOpen(true)} />
      {editing && lib && (
        <TokenEditor
          lib={lib}
          setId={editing.setId}
          tokenId={editing.tokenId}
          resolved={resolved}
          anchorRef={rootRef}
          onClose={() => setEditing(null)}
        />
      )}
      {tableOpen && <TokensTableOverlay lib={lib} onClose={() => setTableOpen(false)} />}
    </div>
  )
}
