/**
 * Typography section — shown in the right rail only when a text shape is
 * selected (gated by the parent `NodePropertyPanel`). Ports the Claude Design
 * `text-panel.jsx` mock to the skia-rs-wasm editor: font family on its own row,
 * weight + italic/underline/strike, size + line-height, alignment, and letter
 * spacing paired with case. (Bold isn't a separate toggle — it's a value in the
 * weight list. Auto-size lives in the Appearance section as per-axis W/H
 * toggles.) Edits commit through `commitNodePartialUpdate`, which re-serializes
 * the text content to WASM and records one undo frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PenpotNode, TextContent } from 'penpot-exporter/types'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  ChevronDown,
  ChevronRight,
  Italic,
  Strikethrough,
  Underline,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import {
  patchContent,
  readTypographyDisplay,
  displayFromCurrentStyles,
  weightLabel,
  type ContentPatch,
  type Decoration,
  type HAlign,
  type TextCase,
  type TextDirection,
  type VAlign,
} from './text-typography'
import { familyMeta } from '@/lib/renderer/api/google-fonts'
import { useSignalCoalesced } from '@/lib/renderer/signals/use-signal-coalesced'
import {
  textEditorActive,
  textEditorShapeId,
  currentStyles,
} from '@/lib/renderer/signals/text-editor'
import { MULTIPLE, textEditorApplyStyles, type ApplyStylePatch } from '@/lib/renderer/api/text-editor'
import { ensureFontLoaded, setShapeTextContent } from '@/lib/renderer/api/text'
import { fontUuidToSlug } from '@/lib/renderer/api/font-id-map'
import { setShapeVerticalAlign, moduleUseShape } from '@/lib/renderer/api/shape'
import {
  syncTextEditGeometry,
  refreshEditorStyles,
  computeAutoSize,
} from '@/lib/renderer/handlers/text-edit'
import { requestRender } from '@/lib/renderer/api/rendering'
import { useWorkspaceStore } from '@/lib/renderer/store/workspace-store'
import { round2 } from '@/lib/common/conversions'
import { cn } from '@/lib/utils'
import { FontPickerPanel } from '../FontPickerPanel'

/** Translate the panel's whole-shape `ContentPatch` into the editor's per-range
 * `ApplyStylePatch` (used while a text shape is being edited). Returns null when
 * the patch has no span/align fields to apply (e.g. vertical-align only). */
function contentPatchToApply(patch: ContentPatch): ApplyStylePatch | null {
  const out: ApplyStylePatch = {}
  let any = false
  const s = patch.span
  if (s) {
    if (s.fontId !== undefined || s.fontFamily !== undefined) {
      out.fontFamilyId = (s.fontId ?? s.fontFamily) as string
      any = true
    }
    if (s.fontWeight !== undefined) {
      out.fontWeight = parseInt(String(s.fontWeight), 10)
      any = true
    }
    if (s.fontStyle !== undefined) {
      out.italic = s.fontStyle === 'italic'
      any = true
    }
    if (s.fontSize !== undefined) {
      out.fontSize = parseFloat(String(s.fontSize))
      any = true
    }
    if (s.lineHeight !== undefined) {
      out.lineHeight = parseFloat(String(s.lineHeight))
      any = true
    }
    if (s.letterSpacing !== undefined) {
      out.letterSpacing = parseFloat(String(s.letterSpacing))
      any = true
    }
    if (s.textDecoration !== undefined) {
      out.decoration = s.textDecoration as ApplyStylePatch['decoration']
      any = true
    }
    if (s.textTransform !== undefined) {
      out.textCase = s.textTransform as ApplyStylePatch['textCase']
      any = true
    }
    if (s.textDirection !== undefined) {
      out.direction = s.textDirection as ApplyStylePatch['direction']
      any = true
    }
  }
  if (patch.textAlign !== undefined) {
    out.textAlign = patch.textAlign
    any = true
  }
  return any ? out : null
}

/** Quiet caption under a segmented control whose values differ across the
 * selection: no segment is active, and clicking one makes it the shared value
 * (the "Empty + quiet caption" mixed treatment). */
function MixedHint({ label }: { label: string }) {
  return (
    <p className="px-0.5 text-[11px] leading-snug text-muted-foreground italic">
      Mixed — no common {label}
    </p>
  )
}

export interface TypographySectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

const H_ALIGNS: ReadonlyArray<{ value: HAlign; Icon: typeof AlignLeft; label: string }> = [
  { value: 'left', Icon: AlignLeft, label: 'Align left' },
  { value: 'center', Icon: AlignCenter, label: 'Align center' },
  { value: 'right', Icon: AlignRight, label: 'Align right' },
  { value: 'justify', Icon: AlignJustify, label: 'Justify' },
]

const V_ALIGNS: ReadonlyArray<{ value: VAlign; Icon: typeof AlignLeft; label: string }> = [
  { value: 'top', Icon: AlignVerticalJustifyStart, label: 'Align top' },
  { value: 'center', Icon: AlignVerticalJustifyCenter, label: 'Align middle' },
  { value: 'bottom', Icon: AlignVerticalJustifyEnd, label: 'Align bottom' },
]

const CASES: ReadonlyArray<{ value: Exclude<TextCase, 'none'>; Icon: typeof CaseUpper; label: string }> = [
  { value: 'uppercase', Icon: CaseUpper, label: 'Uppercase' },
  { value: 'capitalize', Icon: CaseSensitive, label: 'Title case' },
  { value: 'lowercase', Icon: CaseLower, label: 'Lowercase' },
]

const DIRECTIONS: ReadonlyArray<{ value: TextDirection; label: string; title: string }> = [
  { value: 'ltr', label: 'LTR', title: 'Left to right' },
  { value: 'rtl', label: 'RTL', title: 'Right to left' },
]

export function TypographySection({ nodeId, initialNode, readOnly }: TypographySectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  // While this text shape is being edited, show the caret/selection style read
  // live from the WASM editor (mixed-aware) instead of the doc model — which is
  // stale mid-edit (the editor mutates the renderer's scene, not the JS doc,
  // until commit). Outside editing, fall back to the doc-model representative.
  const editing = useSignalCoalesced(textEditorActive)
  const editingId = useSignalCoalesced(textEditorShapeId)
  const liveStyles = useSignalCoalesced(currentStyles)
  // Doc-model display carries its own Mixed flags (per-range styling can leave
  // differing span values even when nothing is being edited).
  const docDisplay = readTypographyDisplay(initialNode)
  const docValues = docDisplay.values
  const live = editing && editingId === nodeId && liveStyles != null
  const { values, mixed } = live ? displayFromCurrentStyles(liveStyles, docValues) : docDisplay

  // Number fields are edited as drafts and committed on blur (matches
  // AppearanceSection), so intermediate keystrokes don't each round-trip.
  const [sizeDraft, setSizeDraft] = useState<string | null>(null)
  const [lineDraft, setLineDraft] = useState<string | null>(null)
  const [letterDraft, setLetterDraft] = useState<string | null>(null)

  // Font picker side panel (opens next to the rail, like the colour editor).
  const fontTriggerRef = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchorY, setPickerAnchorY] = useState(0)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- drop stale drafts when selection/content changes externally */
    setSizeDraft(null)
    setLineDraft(null)
    setLetterDraft(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [nodeId, values.size, values.lineHeight, values.letterSpacing])

  // Close the picker when the selection changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on selection change
    setPickerOpen(false)
  }, [nodeId])

  // Weights are per-family: only show the faces this family actually ships. Keep
  // the current value present even if off-catalogue so the control stays bound.
  const weightOptions = useMemo(() => {
    const weights = familyMeta(values.fontId)?.weights ?? []
    const curr = parseInt(values.weight, 10)
    const all =
      Number.isFinite(curr) && !weights.includes(curr)
        ? [...weights, curr].sort((a, b) => a - b)
        : weights
    return (all.length ? all : [400]).map((w) => ({ value: String(w), label: weightLabel(w) }))
  }, [values.fontId, values.weight])

  const commit = useCallback(
    async (patch: ContentPatch) => {
      if (readOnly) return
      // While editing this shape, apply per-range through the WASM editor
      // (selection → range; collapsed caret → all text). The doc-model path
      // would clobber the live editor buffer, so it's only used when not editing.
      if (textEditorActive.value && textEditorShapeId.value === nodeId) {
        const module = useWorkspaceStore.getState().wasmModule
        if (!module) return
        const apply = contentPatchToApply(patch)
        if (apply) {
          textEditorApplyStyles(module, apply)
          // Family / weight / italic change the font *face*. The apply only sets
          // the id on the spans; the actual TTF must be loaded or it renders with
          // a fallback face until the next full sync (commit). Load it now and
          // re-render when it lands. Read the unchanged fields from the live
          // editor style (fresh), not the captured render value.
          if (
            apply.fontFamilyId !== undefined ||
            apply.fontWeight !== undefined ||
            apply.italic !== undefined
          ) {
            const cs = currentStyles.value
            const curFontId =
              cs && cs.fontFamily !== MULTIPLE && typeof cs.fontFamily === 'string'
                ? fontUuidToSlug(cs.fontFamily)
                : 'sourcesanspro'
            const curWeight = cs && typeof cs.fontWeight === 'number' ? cs.fontWeight : 400
            const curItalic = cs ? cs.fontStyle === 'italic' : false
            void ensureFontLoaded(module, {
              fontId: apply.fontFamilyId ?? curFontId,
              fontWeight: apply.fontWeight ?? curWeight,
              fontStyle: (apply.italic ?? curItalic) ? 'italic' : 'normal',
            }).then((loaded) => {
              if (loaded) requestRender(module, 'font-loaded')
            })
          }
        }
        // Vertical align is root-level (not per-range), set live on the shape.
        if (patch.verticalAlign) setShapeVerticalAlign(module, patch.verticalAlign)
        // Refresh the panel's live style read so controls reflect the change.
        refreshEditorStyles(module)
        syncTextEditGeometry(module, nodeId)
        requestRender(module, 'apply-styles')
        return
      }
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const content = patchContent((before as { content?: TextContent }).content, patch)

      // Push the patched content to WASM first so its text layout is current,
      // then read back the auto-size geometry and fold it into the SAME commit.
      // Without this the box keeps its old size after a size/line-height/etc.
      // change (auto-width/auto-height boxes wouldn't grow/shrink to fit). One
      // mod-obj = one undo frame; `fixed` boxes get null geom and keep their
      // drawn size. Mirrors `commitTextEdit`'s re-assert-on-exit.
      let geom: Partial<PenpotNode> = {}
      const module = useWorkspaceStore.getState().wasmModule
      if (module) {
        moduleUseShape(module, nodeId)
        setShapeTextContent(module, nodeId, content)
        const auto = computeAutoSize(module, nodeId)
        if (auto) geom = auto as unknown as Partial<PenpotNode>
      }

      await commitNodePartialUpdate(
        nodeId,
        before,
        { content, ...geom } as Partial<PenpotNode>,
        pid,
      )
    },
    [nodeId, readOnly],
  )

  const commitNumber = (raw: string, key: 'fontSize' | 'lineHeight' | 'letterSpacing') => {
    const n = round2(parseFloat(raw))
    if (!Number.isFinite(n)) return
    void commit({ span: { [key]: String(n) } })
  }

  // Enter commits a draft by blurring the field. While text editing, the
  // overlay's stranded-focus watcher then hands the keyboard back to the
  // canvas editor, so Enter = "apply and resume typing".
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }

  const openPicker = () => {
    if (readOnly) return
    setPickerAnchorY(fontTriggerRef.current?.getBoundingClientRect().top ?? 12)
    setPickerOpen(true)
  }

  const onFamilySelect = (fontId: string, family: string) => {
    void commit({ span: { fontFamily: family, fontId } })
    setPickerOpen(false)
  }

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            Typography
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-3">
            {/* Font family on its own row — opens the searchable picker panel. */}
            <button
              ref={fontTriggerRef}
              type="button"
              disabled={readOnly}
              onClick={openPicker}
              aria-label="Font family"
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              className={cn(
                'flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50',
                pickerOpen && 'ring-2 ring-ring',
              )}
            >
              <span className="min-w-0 truncate">
                {mixed.family ? 'Mixed' : (familyMeta(values.fontId)?.family ?? values.family)}
              </span>
              <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
            </button>

            {/* Weight sits with the italic / underline / strike toggles. Bold has
                no separate button — it's just a value in the weight list. */}
            <div className="flex gap-2">
              <Select
                value={mixed.weight ? '' : values.weight}
                onValueChange={(w) => void commit({ span: { fontWeight: w } })}
                disabled={readOnly}
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Font weight">
                  <SelectValue placeholder={mixed.weight ? 'Mixed' : 'Weight'} />
                </SelectTrigger>
                <SelectContent>
                  {weightOptions.map((w) => (
                    <SelectItem key={w.value} value={w.value}>
                      {w.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-1">
                <ToggleButton
                  active={!mixed.italic && values.italic}
                  disabled={readOnly}
                  label="Italic"
                  onClick={() =>
                    void commit({ span: { fontStyle: values.italic ? 'normal' : 'italic' } })
                  }
                >
                  <Italic className="size-3.5" aria-hidden />
                </ToggleButton>
                <ToggleButton
                  active={!mixed.decoration && values.decoration === 'underline'}
                  disabled={readOnly}
                  label="Underline"
                  onClick={() => void commit({ span: { textDecoration: nextDecoration(values.decoration, 'underline') } })}
                >
                  <Underline className="size-3.5" aria-hidden />
                </ToggleButton>
                <ToggleButton
                  active={!mixed.decoration && values.decoration === 'line-through'}
                  disabled={readOnly}
                  label="Strikethrough"
                  onClick={() => void commit({ span: { textDecoration: nextDecoration(values.decoration, 'line-through') } })}
                >
                  <Strikethrough className="size-3.5" aria-hidden />
                </ToggleButton>
              </div>
            </div>
            {mixed.italic && <MixedHint label="font style" />}
            {mixed.decoration && <MixedHint label="decoration" />}

            {/* Size + line height. */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="rsp-font-size">Size</Label>
                <Input
                  id="rsp-font-size"
                  type="number"
                  min={1}
                  step={1}
                  disabled={readOnly}
                  value={sizeDraft ?? (mixed.size ? '' : values.size)}
                  placeholder={mixed.size ? 'Mixed' : undefined}
                  onChange={(e) => setSizeDraft(e.target.value)}
                  onKeyDown={blurOnEnter}
                  onBlur={() => {
                    const draft = sizeDraft
                    setSizeDraft(null)
                    if (draft != null) commitNumber(draft, 'fontSize')
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rsp-line-height">Line height</Label>
                <Input
                  id="rsp-line-height"
                  type="number"
                  min={0}
                  step={0.1}
                  disabled={readOnly}
                  value={lineDraft ?? (mixed.lineHeight ? '' : values.lineHeight)}
                  placeholder={mixed.lineHeight ? 'Mixed' : undefined}
                  onChange={(e) => setLineDraft(e.target.value)}
                  onKeyDown={blurOnEnter}
                  onBlur={() => {
                    const draft = lineDraft
                    setLineDraft(null)
                    if (draft != null) commitNumber(draft, 'lineHeight')
                  }}
                />
              </div>
            </div>

            {/* Alignment — horizontal + vertical, under one title. */}
            <div className="space-y-1">
              <Caption>Alignment</Caption>
              <div className="flex gap-2">
                <div className="flex flex-1 gap-1">
                  {H_ALIGNS.map(({ value, Icon, label }) => (
                    <ToggleButton
                      key={value}
                      active={!mixed.hAlign && values.hAlign === value}
                      disabled={readOnly}
                      label={label}
                      onClick={() => void commit({ textAlign: value })}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </ToggleButton>
                  ))}
                </div>
                <div className="flex gap-1">
                  {V_ALIGNS.map(({ value, Icon, label }) => (
                    <ToggleButton
                      key={value}
                      active={values.vAlign === value}
                      disabled={readOnly}
                      label={label}
                      onClick={() => void commit({ verticalAlign: value })}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </ToggleButton>
                  ))}
                </div>
              </div>
              {mixed.hAlign && <MixedHint label="alignment" />}
            </div>

            {/* Letter spacing sits next to Case. (Paragraph spacing has no
                renderer backing, so it's omitted.) */}
            <div className="grid grid-cols-2 items-start gap-2">
              <div className="space-y-1">
                <Label htmlFor="rsp-letter-spacing">Letter spacing</Label>
                <Input
                  id="rsp-letter-spacing"
                  type="number"
                  step={0.1}
                  disabled={readOnly}
                  value={letterDraft ?? (mixed.letterSpacing ? '' : values.letterSpacing)}
                  placeholder={mixed.letterSpacing ? 'Mixed' : undefined}
                  onChange={(e) => setLetterDraft(e.target.value)}
                  onKeyDown={blurOnEnter}
                  onBlur={() => {
                    const draft = letterDraft
                    setLetterDraft(null)
                    if (draft != null) commitNumber(draft, 'letterSpacing')
                  }}
                />
              </div>
              <div className="space-y-1">
                <Caption>Case</Caption>
                <div className="flex gap-1">
                  {CASES.map(({ value, Icon, label }) => {
                    const active = !mixed.textCase && values.textCase === value
                    return (
                      <ToggleButton
                        key={value}
                        active={active}
                        disabled={readOnly}
                        label={label}
                        onClick={() =>
                          void commit({ span: { textTransform: active ? 'none' : value } })
                        }
                      >
                        <Icon className="size-3.5" aria-hidden />
                      </ToggleButton>
                    )
                  })}
                </div>
                {mixed.textCase && <MixedHint label="case" />}
              </div>
            </div>

            {/* Text direction (paragraph flow). */}
            <div className="space-y-1">
              <Caption>Direction</Caption>
              <div className="flex gap-1">
                {DIRECTIONS.map(({ value, label, title }) => {
                  const active = !mixed.direction && values.direction === value
                  return (
                    <Button
                      key={value}
                      type="button"
                      variant={active ? 'secondary' : 'outline'}
                      size="sm"
                      className="flex-1"
                      aria-pressed={active}
                      title={title}
                      disabled={readOnly}
                      onClick={() => void commit({ span: { textDirection: value } })}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
              {mixed.direction && <MixedHint label="direction" />}
            </div>
          </div>
        )}
      </div>

      <FontPickerPanel
        open={pickerOpen}
        anchorY={pickerAnchorY}
        currentFontId={values.fontId}
        onSelect={onFamilySelect}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}

/** Small uppercase caption used for grouped controls (Alignment, Case, Resizing). */
function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  )
}

/** Toggling the active decoration clears it; otherwise switches to `target`. */
function nextDecoration(current: Decoration, target: Exclude<Decoration, 'none'>): Decoration {
  return current === target ? 'none' : target
}

function ToggleButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="icon-sm"
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
