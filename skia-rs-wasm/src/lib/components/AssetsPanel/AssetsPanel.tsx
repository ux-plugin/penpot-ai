/**
 * Assets sections — Colors + Typographies — slotted into the left "Design" rail
 * alongside Pages/Layers (LayersPanel.tsx). Renders bare <section> elements
 * rather than its own FloatingEditorRail so the user keeps a single collapsible
 * left rail.
 *
 * Scope (P1.6 v1): list + create-from-selection + delete + click-to-apply.
 * Rename/group/out-of-sync indicator land in P1.7 with the right-rail chips.
 */

import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { useSnapshot } from 'valtio'
import type { Color, Fill, TextContent, TextNode, TextStyle, Typography, Uuid } from 'penpot-exporter/types'
import { docProxy } from '../../renderer/store/doc-proxy'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  type LibraryColor,
  type LibraryTypography,
  createLibraryColor,
  createLibraryTypography,
  libraryColorCanonical,
  libraryTypographyCanonical,
} from '../../library/types'
import {
  addPaintStyle,
  addTextStyle,
  applyColorStyleToFill,
  applyTypographyToTextNode,
  deletePaintStyle,
  deleteTextStyle,
} from '../../library/apply'

function firstSelectedId(): string | undefined {
  return docProxy.selectedIds.values().next().value
}

function firstSelectedNode(): {
  id: string
  fills?: Fill[]
  content?: TextContent
  type?: string
} | undefined {
  const id = firstSelectedId()
  if (!id) return undefined
  const pid = docProxy.currentPageId
  if (!pid) return undefined
  const page = docProxy.pageMap.get(pid)
  const node = page?.objects[id]
  if (!node) return undefined
  return { id, ...(node as { fills?: Fill[]; content?: TextContent; type?: string }) }
}

function firstSpanOf(content: TextContent | undefined): TextNode | undefined {
  for (const set of content?.children ?? []) {
    for (const paragraph of set.children ?? []) {
      const first = paragraph.children?.[0]
      if (first) return first
    }
  }
  return undefined
}

// ── Swatch ─────────────────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: Color | undefined }) {
  const hex = color?.color
  const opacity = color?.opacity ?? 1
  // Solid swatch only for v1; gradients render as a neutral checker.
  if (hex) {
    return (
      <span
        className="inline-block size-4 shrink-0 rounded border border-border"
        style={{ backgroundColor: hex, opacity }}
        aria-hidden
      />
    )
  }
  if (color?.gradient) {
    return (
      <span
        className="inline-block size-4 shrink-0 rounded border border-border bg-gradient-to-br from-muted-foreground/40 to-muted-foreground/10"
        aria-hidden
      />
    )
  }
  return (
    <span
      className="inline-block size-4 shrink-0 rounded border border-dashed border-muted-foreground/50"
      aria-hidden
    />
  )
}

// ── Colors section ─────────────────────────────────────────────────────────

function ColorsSection() {
  const doc = useSnapshot(docProxy)
  const [open, setOpen] = useState(true)
  const entries = useMemo(() => {
    const styles = doc.meta?.paintStyles ?? {}
    return Object.entries(styles) as Array<[Uuid, LibraryColor]>
  }, [doc.meta?.paintStyles])

  const onCreate = useCallback(async () => {
    const sel = firstSelectedNode()
    const fill = sel?.fills?.[0]
    const id = crypto.randomUUID()
    const name = `Color ${Object.keys(docProxy.meta?.paintStyles ?? {}).length + 1}`
    const style = createLibraryColor({
      id,
      name,
      color: fill?.fillColor ?? '#9CA3AF',
      gradient: fill?.fillColorGradient,
      opacity: fill?.fillOpacity ?? 1,
    })
    await addPaintStyle(id, style)
  }, [])

  const onApply = useCallback(async (styleId: Uuid) => {
    const sel = firstSelectedNode()
    if (!sel) return
    const idx = sel.fills && sel.fills.length > 0 ? 0 : 0
    await applyColorStyleToFill(sel.id, idx, styleId)
  }, [])

  const onDelete = useCallback(async (styleId: Uuid) => {
    await deletePaintStyle(styleId)
  }, [])

  return (
    <section>
      <div className="flex items-center pl-1 pr-0.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 rounded-md py-1 pl-0.5 pr-1 text-left hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Colors
          </span>
        </button>
        <span className="min-w-4 text-right text-xs tabular-nums text-muted-foreground">
          {entries.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label="Create color style from selection"
          title="Create color style from selection"
          onClick={() => void onCreate()}
        >
          <Plus />
        </Button>
      </div>
      {open && (
        <ul className="mt-0.5 list-none space-y-0.5 p-0">
          {entries.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">No color styles yet</li>
          )}
          {entries.map(([id, style]) => {
            const color = libraryColorCanonical(style as LibraryColor)
            return (
              <li key={id}>
                <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void onApply(id)}
                    title={`Apply ${style.name}`}
                  >
                    <ColorSwatch color={color} />
                    <span className="min-w-0 flex-1 truncate">{style.name}</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      'text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100',
                    )}
                    aria-label={`Delete ${style.name}`}
                    title="Delete style"
                    onClick={() => void onDelete(id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── Typographies section ───────────────────────────────────────────────────

function TypographySwatch({ typography }: { typography: Typography }) {
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-[0.65rem] font-medium leading-none text-foreground"
      style={{ fontFamily: typography.fontFamily }}
      aria-hidden
    >
      Ag
    </span>
  )
}

function TypographiesSection() {
  const doc = useSnapshot(docProxy)
  const [open, setOpen] = useState(true)
  const entries = useMemo(() => {
    const styles = doc.meta?.textStyles ?? {}
    return Object.entries(styles) as Array<[Uuid, LibraryTypography]>
  }, [doc.meta?.textStyles])

  const onCreate = useCallback(async () => {
    const sel = firstSelectedNode()
    let source: TextStyle | undefined
    if (sel?.type === 'text') {
      source = firstSpanOf(sel.content)
    }
    const id = crypto.randomUUID()
    const name = `Text style ${Object.keys(docProxy.meta?.textStyles ?? {}).length + 1}`
    const style = createLibraryTypography({
      id,
      name,
      fontId: source?.fontId,
      fontFamily: source?.fontFamily,
      fontVariantId: source?.fontVariantId,
      fontSize: source?.fontSize,
      fontWeight: source?.fontWeight,
      fontStyle: source?.fontStyle,
      lineHeight: source?.lineHeight,
      letterSpacing: source?.letterSpacing,
      textTransform: source?.textTransform,
    })
    await addTextStyle(id, style)
  }, [])

  const onApply = useCallback(async (styleId: Uuid) => {
    const sel = firstSelectedNode()
    if (!sel || sel.type !== 'text') return
    await applyTypographyToTextNode(sel.id, styleId)
  }, [])

  const onDelete = useCallback(async (styleId: Uuid) => {
    await deleteTextStyle(styleId)
  }, [])

  return (
    <section>
      <div className="flex items-center pl-1 pr-0.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 rounded-md py-1 pl-0.5 pr-1 text-left hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Typographies
          </span>
        </button>
        <span className="min-w-4 text-right text-xs tabular-nums text-muted-foreground">
          {entries.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label="Create text style from selection"
          title="Create text style from selection"
          onClick={() => void onCreate()}
        >
          <Plus />
        </Button>
      </div>
      {open && (
        <ul className="mt-0.5 list-none space-y-0.5 p-0">
          {entries.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">No text styles yet</li>
          )}
          {entries.map(([id, style]) => {
            const t = libraryTypographyCanonical(style as LibraryTypography)
            return (
              <li key={id}>
                <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void onApply(id)}
                    title={`Apply ${style.name}`}
                  >
                    <TypographySwatch typography={t} />
                    <span className="min-w-0 flex-1 truncate">{style.name}</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      'text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100',
                    )}
                    aria-label={`Delete ${style.name}`}
                    title="Delete style"
                    onClick={() => void onDelete(id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── Public composite ───────────────────────────────────────────────────────

/** Render Colors + Typographies sections inside the existing left "Design" rail. */
export function AssetsSections() {
  return (
    <>
      <ColorsSection />
      <TypographiesSection />
    </>
  )
}
