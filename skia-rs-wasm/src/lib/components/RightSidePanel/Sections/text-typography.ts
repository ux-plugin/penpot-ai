/**
 * Pure helpers for the Typography section.
 *
 * Bridges the Penpot text content tree (root → paragraph-set → paragraph →
 * span) and the flat set of controls the panel exposes. Typography lives on
 * the spans (and is mirrored onto the paragraph as a fallback, the way Penpot
 * stores it); horizontal align lives on the paragraph; vertical align on the
 * root; and grow behaviour (`auto-width` / `auto-height` / `fixed`) is a
 * shape-level attribute, not part of `content`.
 *
 * Only attributes the WASM serializer actually honours are represented here
 * (see `api/text.ts` `writeSpans` / `writeParagraph` and `api/serializers.ts`
 * for the enum maps). Paragraph spacing has no backing in the renderer, so it
 * is intentionally absent.
 */

import type { Fill, PenpotNode, TextContent, Paragraph, TextNode } from 'penpot-exporter/types'
import { MULTIPLE, type CurrentStyles, type MaybeMultiple } from '@/lib/renderer/api/text-editor'

export type HAlign = 'left' | 'center' | 'right' | 'justify'
export type VAlign = 'top' | 'center' | 'bottom'
export type GrowType = 'fixed' | 'auto-width' | 'auto-height'
export type Decoration = 'none' | 'underline' | 'line-through'
export type TextCase = 'none' | 'uppercase' | 'lowercase' | 'capitalize'
export type TextDirection = 'ltr' | 'rtl'

// The font family list now comes straight from the catalog
// (`renderer/api/google-fonts` → `FONT_FAMILIES`), surfaced through the
// searchable `FontPickerPanel`. Weights are per-family (a family only ships some
// faces), so the panel reads them from `familyMeta()`; the labels below name the
// standard CSS weight steps.

/** CSS weight value → human name, for the weight dropdown. */
export const WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin',
  200: 'Extralight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extrabold',
  900: 'Black',
}

/** Label for a weight, falling back to the bare number for off-step values. */
export function weightLabel(weight: number): string {
  return WEIGHT_LABELS[weight] ?? String(weight)
}

export const DEFAULTS = {
  family: 'Source Sans Pro',
  fontId: 'sourcesanspro',
  weight: '400',
  size: '14',
  /** Unitless multiplier — `serializeLineHeight` treats it as relative. */
  lineHeight: '1.2',
  letterSpacing: '0',
} as const

export interface TypographyValues {
  family: string
  fontId: string
  weight: string
  italic: boolean
  size: string
  lineHeight: string
  letterSpacing: string
  decoration: Decoration
  textCase: TextCase
  hAlign: HAlign
  vAlign: VAlign
  direction: TextDirection
  growType: GrowType
}

type NodeWithText = PenpotNode & { content?: TextContent; growType?: string }

function allParagraphs(content: TextContent | undefined): Paragraph[] {
  if (!content?.children) return []
  return content.children.flatMap((set) => set.children ?? [])
}

function firstSpan(content: TextContent | undefined): TextNode | undefined {
  for (const paragraph of allParagraphs(content)) {
    const span = paragraph.children?.[0]
    if (span) return span
  }
  return undefined
}

/**
 * Representative fills shown by the fill panel for a text shape. Text colour
 * lives on the content leaves (per-range capable), not the shape-level `fills`,
 * so the first span's fills stand in for the whole shape — the same
 * "first/common value" convention `readTypography` uses. Edits apply to every
 * leaf via `patchContent({ span: { fills } })`.
 */
export function textContentFills(content: TextContent | undefined): Fill[] {
  const fills = firstSpan(content)?.fills
  return fills ? [...fills] : []
}

/**
 * Reads the representative typography values shown in the panel. Mirrors
 * Penpot's "first/common value" behaviour: the first span (with paragraph- and
 * root-level fallbacks) stands in for the whole shape, since edits are applied
 * uniformly across every span/paragraph.
 */
export function readTypography(node: NodeWithText): TypographyValues {
  const content = node.content
  const span = firstSpan(content)
  const paragraph = allParagraphs(content)[0]

  const pick = <K extends keyof Paragraph & keyof TextNode>(key: K): string | undefined => {
    const fromSpan = span?.[key]
    if (fromSpan != null) return String(fromSpan)
    const fromParagraph = paragraph?.[key]
    return fromParagraph != null ? String(fromParagraph) : undefined
  }

  return {
    family: span?.fontFamily ?? span?.fontId ?? DEFAULTS.family,
    fontId: span?.fontId ?? DEFAULTS.fontId,
    weight: pick('fontWeight') ?? DEFAULTS.weight,
    italic: pick('fontStyle') === 'italic',
    size: pick('fontSize') ?? DEFAULTS.size,
    lineHeight: pick('lineHeight') ?? DEFAULTS.lineHeight,
    letterSpacing: pick('letterSpacing') ?? DEFAULTS.letterSpacing,
    decoration: (pick('textDecoration') as Decoration | undefined) ?? 'none',
    textCase: (pick('textTransform') as TextCase | undefined) ?? 'none',
    hAlign: (paragraph?.textAlign as HAlign | undefined) ?? 'left',
    vAlign: (content?.verticalAlign as VAlign | undefined) ?? 'top',
    direction: pick('textDirection') === 'rtl' ? 'rtl' : 'ltr',
    growType: (node.growType as GrowType | undefined) ?? 'fixed',
  }
}

/** Span-level typography attributes the panel can set. */
export type SpanPatch = Partial<
  Pick<
    TextNode,
    | 'fontFamily'
    | 'fontId'
    | 'fontWeight'
    | 'fontStyle'
    | 'fontSize'
    | 'lineHeight'
    | 'letterSpacing'
    | 'textDecoration'
    | 'textTransform'
    | 'textDirection'
    | 'fills'
  >
>

export interface ContentPatch {
  /** Applied to every span and mirrored onto every paragraph as a fallback. */
  span?: SpanPatch
  /** Horizontal alignment, applied to every paragraph. */
  textAlign?: HAlign
  /** Vertical alignment, applied to the content root. */
  verticalAlign?: VAlign
}

const EMPTY_CONTENT: TextContent = {
  type: 'root',
  verticalAlign: 'top',
  children: [],
}

/**
 * Returns a deep copy of `content` with the patch applied uniformly. Span
 * typography is written to both spans and their paragraph (Penpot keeps a copy
 * on the paragraph node, which the serializer reads as a fallback).
 */
export function patchContent(
  content: TextContent | undefined,
  patch: ContentPatch,
): TextContent {
  const next: TextContent = structuredClone(content ?? EMPTY_CONTENT)

  if (patch.verticalAlign) next.verticalAlign = patch.verticalAlign

  for (const set of next.children ?? []) {
    for (const paragraph of set.children ?? []) {
      if (patch.textAlign) paragraph.textAlign = patch.textAlign
      if (patch.span) Object.assign(paragraph, patch.span)
      for (const span of paragraph.children ?? []) {
        if (patch.span) Object.assign(span, patch.span)
      }
    }
  }

  return next
}

/** True when the node is a text shape (drives whether the panel renders). */
export function isTextNode(node: { type?: string } | null | undefined): boolean {
  return node?.type === 'text'
}

/** True when a text content tree has no characters in any span. */
export function isEmptyTextContent(content: TextContent | undefined): boolean {
  for (const paragraph of allParagraphs(content)) {
    for (const span of paragraph.children ?? []) {
      if ((span.text ?? '').length > 0) return false
    }
  }
  return true
}

// ─── Auto-size (grow type) ──────────────────────────────────────────────────
// render-wasm has exactly three text-size modes in a single `grow-type`:
// `fixed`, `auto-width` (single line — width and height both hug the text), and
// `auto-height` (fixed width, height hugs the wrapped text). The standalone
// "Auto resize" control picks one mode directly; `pinGrowAxis` is the fallback
// for when the user sizes a single axis (typing a value / dragging that edge).

/**
 * Pin one axis to a user-set size — typing a value into W/H, or dragging that
 * edge. The pinned axis stops being content-driven; the other keeps its mode
 * where that's legal. Pinning height always lands on `fixed`, since
 * "width-auto + fixed height" isn't a legal mode.
 */
export function pinGrowAxis(current: GrowType | string | undefined, axis: 'w' | 'h'): GrowType {
  const g = current ?? 'fixed'
  if (axis === 'h') return 'fixed'
  // Pinning width: drop auto-width to fixed; auto-height keeps its fixed width.
  return g === 'auto-width' ? 'fixed' : g === 'auto-height' ? 'auto-height' : 'fixed'
}

// ─── Live (in-editor) typography display ────────────────────────────────────
// While a text shape is being edited, the panel shows the style at the caret /
// across the current selection, read from the WASM editor (`currentStyles`)
// rather than the doc model. A per-property `MULTIPLE` value renders as a blank
// "Mixed" control. This module only maps the editor's read model onto the
// panel's value shape; it never writes (writes still go through `patchContent`
// in P1, replaced by an apply-to-selection path in P2).

export interface DisplayTypography {
  /** Concrete values to bind to controls; mixed fields fall back to a neutral. */
  values: TypographyValues
  /** Which fields differ across the selection (render as "Mixed"/indeterminate). */
  mixed: Partial<Record<keyof TypographyValues, true>>
}

/** Collapse a `MaybeMultiple<T>` to a concrete value plus a mixed flag. */
function resolveMaybe<T>(mm: MaybeMultiple<T>, fallback: T): { value: T; mixed: boolean } {
  if (mm === MULTIPLE) return { value: fallback, mixed: true }
  if (mm == null) return { value: fallback, mixed: false }
  return { value: mm, mixed: false }
}

/**
 * Map the editor's mixed-aware `CurrentStyles` onto the panel's value shape,
 * using `fallback` (the doc-model `readTypography`) for anything the editor
 * can't supply: the font *name* (the editor identifies fonts by UUID, so only
 * the Mixed flag is live), `growType` (shape-level), and as the neutral value
 * for mixed fields. `fontStyle`/italic has no "multiple" state in the read
 * buffer, so mixed italic shows as a single value (a known P1 limitation).
 */
export function displayFromCurrentStyles(
  cs: CurrentStyles,
  fallback: TypographyValues,
): DisplayTypography {
  const weight = resolveMaybe(cs.fontWeight, parseInt(fallback.weight, 10) || 400)
  const size = resolveMaybe(cs.fontSize, parseFloat(fallback.size) || 14)
  const lineHeight = resolveMaybe(cs.lineHeight, parseFloat(fallback.lineHeight) || 1.2)
  const letterSpacing = resolveMaybe(cs.letterSpacing, parseFloat(fallback.letterSpacing) || 0)
  // The editor exposes `overline`, which the panel's 3-state control can't show.
  const decRaw: MaybeMultiple<Decoration> =
    cs.textDecoration === 'overline' ? 'none' : (cs.textDecoration as MaybeMultiple<Decoration>)
  const decoration = resolveMaybe<Decoration>(decRaw, fallback.decoration)
  const textCase = resolveMaybe<TextCase>(cs.textTransform as MaybeMultiple<TextCase>, fallback.textCase)
  const hAlign = resolveMaybe<HAlign>(cs.textAlign, fallback.hAlign)
  const direction = resolveMaybe<TextDirection>(cs.textDirection, fallback.direction)
  const familyMixed = cs.fontFamily === MULTIPLE

  const mixed: Partial<Record<keyof TypographyValues, true>> = {}
  if (weight.mixed) mixed.weight = true
  if (size.mixed) mixed.size = true
  if (lineHeight.mixed) mixed.lineHeight = true
  if (letterSpacing.mixed) mixed.letterSpacing = true
  if (decoration.mixed) mixed.decoration = true
  if (textCase.mixed) mixed.textCase = true
  if (hAlign.mixed) mixed.hAlign = true
  if (direction.mixed) mixed.direction = true
  if (familyMixed) {
    mixed.family = true
    mixed.fontId = true
  }

  const values: TypographyValues = {
    // Name stays from the doc model (editor identifies fonts by UUID).
    family: fallback.family,
    fontId: fallback.fontId,
    weight: String(weight.value),
    italic: cs.fontStyle === 'italic',
    size: String(size.value),
    lineHeight: String(lineHeight.value),
    letterSpacing: String(letterSpacing.value),
    decoration: decoration.value,
    textCase: textCase.value,
    hAlign: hAlign.value,
    vAlign: (cs.verticalAlign as VAlign) ?? fallback.vAlign,
    direction: direction.value,
    growType: fallback.growType,
  }

  return { values, mixed }
}
