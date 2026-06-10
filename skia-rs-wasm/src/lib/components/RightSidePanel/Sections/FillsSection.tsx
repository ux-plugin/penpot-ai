import { useCallback, useEffect, useRef, useState } from 'react'
import type { Fill, PenpotNode, TextContent } from 'penpot-exporter/types'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import { DEFAULT_FILL, MAX_FILLS, type RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import { useSignalCoalesced } from '@/lib/renderer/signals/use-signal-coalesced'
import {
  textEditorActive,
  textEditorShapeId,
  currentStyles,
} from '@/lib/renderer/signals/text-editor'
import { MULTIPLE, textEditorApplyStyles, type EditorFill } from '@/lib/renderer/api/text-editor'
import { refreshEditorStyles, syncTextEditGeometry } from '@/lib/renderer/handlers/text-edit'
import { requestRender } from '@/lib/renderer/api/rendering'
import { useWorkspaceStore } from '@/lib/renderer/store/workspace-store'
import { FillRow } from './FillRow'
import { isTextNode, patchContent, textContentFills } from './text-typography'
import { useColorEditor, useColorEditorFor } from '../use-color-editor'

export interface FillsSectionProps {
  nodeId: string
  readOnly: boolean
  initialNode: RectLikeNode
}

// Color-editor target index for the text-edit "set color for all" + button. Far
// above any real fill row index so it never collides with a per-fill editor.
const FILL_ALL_INDEX = 1000

// Initial fills shown in the panel. For a text shape the colour lives on the
// content leaves (per-range capable), not the shape-level `fills`, so read the
// representative leaf fills; every other shape uses its shape-level `fills`.
function initialFills(node: RectLikeNode): Fill[] {
  if (isTextNode(node as { type?: string })) {
    return textContentFills((node as { content?: TextContent }).content)
  }
  return node.fills ? [...node.fills] : []
}

export function FillsSection({ nodeId, readOnly, initialNode }: FillsSectionProps) {
  const { activeTarget, closeEditor } = useColorEditor()
  const [fills, setFills] = useState<Fill[]>(() => initialFills(initialNode))
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirrors external document updates into controlled fields */
    setFills(initialFills(initialNode))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialNode])

  // ── Shape fills (not editing text) ─────────────────────────────────────────
  const commitFills = useCallback(
    async (next: Fill[]) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      if (isTextNode(before as { type?: string })) {
        // Text colour lives on the content leaves (per-range capable), not the
        // shape-level `fills`. Apply to every leaf through the same content path
        // the typography panel uses, so colour and typography share one source
        // of truth and a later content re-send can't revert the colour.
        const content = patchContent(
          (before as { content?: TextContent }).content,
          { span: { fills: next } },
        )
        await commitNodePartialUpdate(nodeId, before, { content } as Partial<PenpotNode>, pid)
        return
      }
      await commitNodePartialUpdate(nodeId, before, { fills: next }, pid)
    },
    [readOnly, nodeId],
  )

  const onFillChange = useCallback(
    (fill: Fill, index: number) => {
      const next = [...fills]
      if (index < 0 || index >= next.length) return
      next[index] = fill
      setFills(next)
      void commitFills(next)
    },
    [fills, commitFills],
  )

  const addFill = useCallback(() => {
    if (fills.length >= MAX_FILLS) return
    const next = [...fills, DEFAULT_FILL]
    setFills(next)
    void commitFills(next)
  }, [fills, commitFills])

  const removeFill = useCallback(
    (index: number) => {
      if (activeTarget?.kind === 'fill' && activeTarget.index === index) closeEditor()
      const next = fills.filter((_, i) => i !== index)
      setFills(next)
      void commitFills(next)
    },
    [fills, commitFills, closeEditor, activeTarget],
  )

  // ── Per-range text colour (editing this text shape) ─────────────────────────
  // While editing, the Fill section sets the colour of the current selection (or
  // all text when the caret is collapsed). Following the multi-select design: a
  // single shared colour is shown editable; when colours differ across the
  // selection ("many"), it collapses to ONE read-only "Mixed" row — picking a
  // colour there replaces it everywhere, rather than editing a list. Solids only.
  const editing = useSignalCoalesced(textEditorActive)
  const editingId = useSignalCoalesced(textEditorShapeId)
  const liveStyles = useSignalCoalesced(currentStyles)
  // Header "+" → set one color across the whole selection (replace-all).
  const fillAllEditor = useColorEditorFor('fill', FILL_ALL_INDEX)
  const addColorBtnRef = useRef<HTMLButtonElement>(null)
  const isEditingThis = editing && editingId === nodeId && liveStyles != null
  const fillsAreMixed = isEditingThis && liveStyles != null && liveStyles.fills === MULTIPLE
  const liveFillsRaw: EditorFill[] =
    isEditingThis && liveStyles != null
      ? liveStyles.fills === MULTIPLE
        ? liveStyles.selectedColors ?? []
        : liveStyles.fills
      : []
  const hasNonSolid = liveFillsRaw.some((f) => f.type !== 'solid')
  const solidColors: Fill[] = dedupeFills(
    liveFillsRaw
      .filter((f): f is Extract<EditorFill, { type: 'solid' }> => f.type === 'solid')
      .map((f) => ({ fillColor: f.color, fillOpacity: f.opacity }) as Fill),
  )
  // "Many" / differing → the read-only Mixed treatment.
  const showMixedFill = isEditingThis && (fillsAreMixed || hasNonSolid || solidColors.length > 1)

  // Apply a fills list to the current selection. Solids only; an all-non-solid
  // result is skipped rather than clearing the colour, but an explicitly emptied
  // list (remove) is honoured.
  const applySelectionFills = (list: Fill[]): void => {
    const module = useWorkspaceStore.getState().wasmModule
    if (!module) return
    const payload = list
      .filter((f) => typeof f.fillColor === 'string')
      .map((f) => ({ color: f.fillColor as string, opacity: f.fillOpacity ?? 1 }))
    if (payload.length === 0 && list.length > 0) return
    textEditorApplyStyles(module, { fills: payload })
    refreshEditorStyles(module)
    syncTextEditGeometry(module, nodeId)
    requestRender(module, 'apply-fills')
  }

  // Open the color editor from the header "+", seeded with the selection's
  // current color (or black); picking replaces the color across the selection.
  const onEditSetColor = (): void => {
    if (readOnly) return
    if (fillAllEditor.isActive) {
      fillAllEditor.closeEditor()
      return
    }
    const y = addColorBtnRef.current?.getBoundingClientRect().top ?? 12
    fillAllEditor.openEditor(solidColors[0] ?? DEFAULT_FILL, y, 'Text color', (f) =>
      applySelectionFills([f]),
    )
  }

  const hasFills = fills.length > 0
  const canAdd = !readOnly && fills.length < MAX_FILLS

  return (
    <>
      <Separator />
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            Fill
          </button>
          <div className="flex items-center gap-1">
            {/* "Mixed" chip when the selection's colours differ. */}
            {isEditingThis && showMixedFill && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-wide text-muted-foreground uppercase">
                Mixed
              </span>
            )}
            {/* "+" — in text-edit mode it sets one color across the whole
                selection (replace-all); otherwise it adds a shape fill. */}
            {!readOnly &&
              (isEditingThis ? (
                <Button
                  ref={addColorBtnRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(fillAllEditor.isActive && 'bg-accent text-accent-foreground')}
                  onClick={onEditSetColor}
                  aria-expanded={fillAllEditor.isActive}
                  aria-label="Set color for the selection"
                  title="Set color for the selection"
                >
                  +
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={addFill}
                  disabled={!canAdd}
                  aria-label="Add fill"
                  title={canAdd ? 'Add fill' : `Maximum ${MAX_FILLS} fills`}
                >
                  +
                </Button>
              ))}
          </div>
        </div>

        {/* Editing: per-range text colour. */}
        {!collapsed && isEditingThis && (
          <div className="space-y-1 pl-0.5">
            {showMixedFill ? (
              <>
                <EditingColorTrigger
                  variant="mixed"
                  readOnly={readOnly}
                  onPick={(f) => applySelectionFills([f])}
                />
                <p className="flex items-start gap-1.5 px-0.5 pt-0.5 text-[11px] leading-snug text-muted-foreground">
                  <Info className="mt-px size-3 shrink-0" aria-hidden />
                  <span>Picking a color replaces it across the selection.</span>
                </p>
              </>
            ) : solidColors.length === 1 ? (
              <FillRow
                fill={solidColors[0]}
                index={0}
                readOnly={readOnly}
                onChange={(f) => applySelectionFills([f])}
                onRemove={() => applySelectionFills([])}
              />
            ) : (
              <EditingColorTrigger
                variant="empty"
                readOnly={readOnly}
                onPick={(f) => applySelectionFills([f])}
              />
            )}
          </div>
        )}

        {/* Not editing: the editable shape fills. */}
        {!collapsed && !isEditingThis && hasFills && (
          <div className="space-y-2 pl-0.5">
            {fills.map((fill, i) => (
              <FillRow
                key={i}
                fill={fill}
                index={i}
                readOnly={readOnly}
                onChange={onFillChange}
                onRemove={removeFill}
              />
            ))}
          </div>
        )}

        {!collapsed && !isEditingThis && !hasFills && !readOnly && (
          <p className="text-xs text-muted-foreground">No fills. Use + to add.</p>
        )}
      </div>
    </>
  )
}

/** Diagonal-hatch + red slash, signalling fills differ across the selection. */
const MIXED_SWATCH_BG =
  'linear-gradient(135deg, transparent calc(50% - 1px), #dc2626 calc(50% - 1px), #dc2626 calc(50% + 1px), transparent calc(50% + 1px)),' +
  ' repeating-linear-gradient(45deg, rgba(128,128,128,0.30) 0 3px, rgba(128,128,128,0.12) 3px 6px)'

/**
 * Read-only colour trigger for the text-edit Fill section: a `mixed` row (fills
 * differ) or an `empty` row (no colour yet). The swatch opens the colour editor;
 * picking a colour replaces the selection's colour via `onPick`.
 */
function EditingColorTrigger({
  variant,
  readOnly,
  onPick,
}: {
  variant: 'mixed' | 'empty'
  readOnly: boolean
  onPick: (fill: Fill) => void
}) {
  const { isActive, openEditor, closeEditor } = useColorEditorFor('fill', 0)
  const swatchRef = useRef<HTMLButtonElement>(null)
  const toggle = (): void => {
    if (readOnly) return
    if (isActive) {
      closeEditor()
      return
    }
    const y = swatchRef.current?.getBoundingClientRect().top ?? 12
    openEditor(DEFAULT_FILL, y, 'Text color', onPick)
  }
  return (
    <div className="flex min-h-8 items-center gap-2 py-0.5">
      <button
        ref={swatchRef}
        type="button"
        onClick={toggle}
        disabled={readOnly}
        className={cn(
          'size-5 shrink-0 rounded border border-border',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          isActive && 'ring-2 ring-ring',
        )}
        style={variant === 'mixed' ? { background: MIXED_SWATCH_BG } : undefined}
        title="Set text color"
        aria-label="Set text color"
      />
      <span
        className={cn(
          'flex-1 font-mono text-xs text-muted-foreground',
          variant === 'mixed' && 'italic',
        )}
      >
        {variant === 'mixed' ? 'Mixed' : 'Add color'}
      </span>
      {variant === 'mixed' && <span className="shrink-0 text-xs text-muted-foreground">—</span>}
    </div>
  )
}

/** Distinct fills by colour + opacity, preserving first-seen order. */
function dedupeFills(list: Fill[]): Fill[] {
  const seen = new Set<string>()
  const out: Fill[] = []
  for (const f of list) {
    const key = `${f.fillColor ?? ''}:${f.fillOpacity ?? 1}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}
