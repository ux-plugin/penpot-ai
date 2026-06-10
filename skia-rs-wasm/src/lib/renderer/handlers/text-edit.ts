/**
 * Text-editing session glue: enter/commit/exit lifecycle around the WASM
 * interactive text editor (`api/text-editor.ts`).
 *
 * The editing *mode* lives in the canvas machine (`textEditing` state). These
 * helpers drive the low-level signals the render loop reads (`textEditorActive`
 * etc.), focus/dispose the WASM editor, and on exit export the edited content
 * back into the JS document model via the normal `applyChanges` pipeline so
 * docProxy / worker / history stay consistent.
 */

import type { WasmModule } from '../wasm-types'
import type { Change } from 'penpot-exporter/types'
import {
  textEditorFocus,
  textEditorBlur,
  textEditorDispose,
  textEditorApplyTheme,
  textEditorExportContent,
  textEditorExportStyled,
  textEditorSelectAll,
  textEditorGetCurrentStyles,
} from '../api/text-editor'
import type { StyledContent, StyledSpan, StyledFill } from '../api/text-editor'
import { fontUuidToSlugOrNull } from '../api/font-id-map'
import { u32ToUUID, round2 } from '@skia-rs-wasm/common/conversions'
import { requestRender } from '../api/rendering'
import { getTextDimensions } from '../api/text'
import {
  textEditorActive,
  textEditorShapeId,
  textCaretRect,
  textSelectionRects,
  textIsComposing,
  currentStyles,
  textEditorIsEmpty,
} from '../signals/text-editor'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { getSelectedIdsSet, setSelectedIds } from '../store/document-selection'
import { applyChanges } from '../../page-crud'

/** Packed ARGB u32 (Skia `Color::new` order): a translucent blue selection and a
 * near-black opaque caret. NOTE: ARGB, not RGBA — writing these as RGBA puts the
 * intended RGB's last byte into the alpha slot, making the caret ~7% opaque
 * (invisible). */
const SELECTION_COLOR = 0x4d3b82f6
const CURSOR_COLOR = 0xff111111

/**
 * Pull the editor's mixed-aware style of the caret/selection into the
 * `currentStyles` signal so the typography/fills panels reflect the live
 * selection. Call after any editor interaction that can move the caret or change
 * the selection (the WASM ops refresh their internal style buffer first). Cheap:
 * one buffer read of the aggregated styles.
 *
 * Also refreshes `textEditorIsEmpty` from the live editor content (typed text
 * isn't in `node.content` until commit) so the selection overlay can reveal the
 * box outline the instant the first character is typed.
 */
export function refreshEditorStyles(module: WasmModule): void {
  currentStyles.value = textEditorGetCurrentStyles(module)
  textEditorIsEmpty.value = (textEditorExportContent(module) ?? []).flat().join('').length === 0
}

/**
 * Enter edit mode for `shapeId`: focus the WASM editor, flip the render-loop
 * gate on, apply the caret/selection theme, and schedule a frame.
 *
 * Returns whether focus succeeded. A just-created shape may not be in the WASM
 * scene yet, so `_text_editor_focus` can return false on the first try; the
 * caller retries on the next frame (otherwise the caret never shows on the very
 * first click that creates the box).
 */
export function startTextEdit(module: WasmModule, shapeId: string): boolean {
  const focused = textEditorFocus(module, shapeId)
  if (!focused) return false
  // Select all on entry so the caret/selection is visible immediately (without
  // this the editor focuses but shows no cursor until a click places one) and
  // you can type straight over the text — a single click still drops the caret.
  textEditorSelectAll(module)
  textEditorShapeId.value = shapeId
  textEditorActive.value = true
  textIsComposing.value = false
  refreshEditorStyles(module)
  textEditorApplyTheme(module, SELECTION_COLOR, CURSOR_COLOR)
  requestRender(module, 'text-edit-start')
  return true
}

interface Selrect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Grow the edited shape's geometry to fit the current text, every keystroke —
 * the size half of Penpot's `sync-wasm-text-editor-content!` (`get-wasm-text-new-size`).
 *
 * The WASM editor mutates the shape's text in place but does NOT resize the
 * shape's `selrect` during editing; the renderer's tile coverage and the caret's
 * clip bounds both follow the selrect, so without this, text typed past the
 * original box is clipped at a tile edge and the caret falls outside the rendered
 * region (invisible). We read the laid-out size from the WASM editor and push a
 * geometry-only `mod-obj` (selrect/points/width/height) — no `content`, so the
 * live editor buffer and cursor are untouched. Content is synced on commit.
 */
/** Selrect plus the derived corner coords the document model stores. */
interface FullSelrect extends Selrect {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface AutoSize {
  selrect: FullSelrect
  points: { x: number; y: number }[]
  width: number
  height: number
}

/**
 * The auto-size geometry the edited text should have, read from the WASM
 * editor's laid-out size. Null for `fixed` boxes (which keep the user's drawn
 * size) or when the shape/selrect is missing. Used both for the per-keystroke
 * grow and to re-assert the final size on commit.
 */
function computeAutoSize(module: WasmModule, shapeId: string): AutoSize | null {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const node = getPage(pageId)?.objects[shapeId] as
    | { selrect?: Selrect; growType?: string }
    | undefined
  const sel = node?.selrect
  if (!sel) return null
  const growType = node.growType ?? 'fixed'
  if (growType !== 'auto-width' && growType !== 'auto-height') return null

  const dims = getTextDimensions(module, shapeId)
  const x = sel.x
  const y = sel.y
  const width = growType === 'auto-width' ? dims.width : sel.width
  const height = dims.height

  const selrect: FullSelrect = { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height }
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  return { selrect, points, width, height }
}

export function syncTextEditGeometry(module: WasmModule, shapeId: string): void {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return
  const geom = computeAutoSize(module, shapeId)
  if (!geom) return
  const sel = (getPage(pageId)?.objects[shapeId] as { selrect?: Selrect } | undefined)?.selrect

  // Skip when nothing changed, to avoid per-frame applyChanges churn.
  if (sel && Math.abs(geom.width - sel.width) < 0.5 && Math.abs(geom.height - sel.height) < 0.5) {
    return
  }
  const change = {
    type: 'mod-obj',
    id: shapeId,
    pageId,
    operations: [{ type: 'assign', value: geom }],
  } as unknown as Change
  void applyChanges([change])
}

/** Minimal shape view of a text leaf/paragraph style we carry across a commit. */
interface SpanStyle {
  fontFamily?: string
  fontId?: string
  fontSize?: number | string
  fontStyle?: string
  fontWeight?: number | string
  lineHeight?: number | string
  letterSpacing?: number | string
  fills?: unknown
}

/**
 * Rebuild a Penpot text `content` tree from the editor's exported text
 * (`string[][]` = paragraphs → span texts), reusing the original shape's first
 * span style for every span. MVP fidelity: mixed per-span styles collapse to
 * the dominant (first) style.
 */
function rebuildTextContent(original: unknown, paragraphs: string[][]): unknown {
  const orig = (original ?? {}) as {
    verticalAlign?: string
    children?: Array<{ children?: Array<{ children?: SpanStyle[] } & SpanStyle> }>
  }
  const origParagraph = orig.children?.[0]?.children?.[0]
  const origSpan = origParagraph?.children?.[0] ?? origParagraph

  const style: SpanStyle = {
    fontFamily: origSpan?.fontFamily ?? 'sourcesanspro',
    fontId: origSpan?.fontId,
    fontSize: origSpan?.fontSize ?? 14,
    fontStyle: origSpan?.fontStyle ?? 'normal',
    fontWeight: origSpan?.fontWeight ?? 400,
    lineHeight: origSpan?.lineHeight,
    letterSpacing: origSpan?.letterSpacing,
    fills: origSpan?.fills ?? [{ fillColor: '#000000', fillOpacity: 1 }],
  }

  const paras = paragraphs.length > 0 ? paragraphs : [['']]

  return {
    type: 'root',
    verticalAlign: orig.verticalAlign ?? 'top',
    children: [
      {
        type: 'paragraph-set',
        children: paras.map((spans) => ({
          type: 'paragraph',
          ...style,
          children: (spans.length > 0 ? spans : ['']).map((text) => ({
            type: 'text',
            text,
            ...style,
          })),
        })),
      },
    ],
  }
}

// Index → string maps for the styled export's numeric enum fields. These match
// the WASM style-data encoding (and the `api/text-editor` decoder arrays).
const STYLED_VERTICAL_ALIGN = ['top', 'center', 'bottom'] as const
const STYLED_PARA_ALIGN = ['left', 'center', 'right', 'justify'] as const
const STYLED_FONT_STYLE = ['normal', 'italic', 'oblique'] as const
// `overline` (index 3) has no panel control, so it folds to `none`.
const STYLED_DECORATION = ['none', 'underline', 'line-through', 'none'] as const
const STYLED_TRANSFORM = ['none', 'uppercase', 'lowercase', 'capitalize'] as const
const STYLED_DIRECTION = ['ltr', 'rtl'] as const

/** Minimal view of the original shape's first span (family/variant/fills). */
interface OrigSpanShape {
  fontFamily?: string
  fontId?: string
  fontVariantId?: string | number
  fills?: unknown
}

/**
 * Penpot fills from the styled export. Solid fills round-trip exactly; non-solid
 * fills (`{k}`) can't yet, so a span carrying only those keeps its original
 * fills. Empty fills fall back to opaque black (matches `rebuildTextContent`).
 */
function fillsFromStyled(fl: StyledFill[] | undefined, origFills: unknown): unknown {
  const fallback = (origFills as unknown[] | undefined) ?? [{ fillColor: '#000000', fillOpacity: 1 }]
  if (!fl || fl.length === 0) return fallback
  const out: unknown[] = []
  for (const f of fl) {
    if ('c' in f) out.push({ fillColor: f.c, fillOpacity: f.o })
  }
  return out.length > 0 ? out : fallback
}

/**
 * Build a faithful Penpot `content` tree from the editor's styled export — the
 * per-range counterpart of `rebuildTextContent`. Per-span typography, decoration,
 * (solid) fills and font family all come from the export; family is resolved from
 * the span's UUID back to a catalog slug (falling back to the original family for
 * unknown ids). Variant comes from the original shape. Typography is mirrored
 * onto each paragraph from its first span (Penpot's fallback convention).
 */
function buildContentFromStyled(styled: StyledContent, original: unknown): unknown {
  const orig = (original ?? {}) as {
    children?: Array<{ children?: Array<{ children?: OrigSpanShape[] } & OrigSpanShape> }>
  }
  const origParagraph = orig.children?.[0]?.children?.[0]
  const origSpan = (origParagraph?.children?.[0] ?? origParagraph) as OrigSpanShape | undefined
  const origFamily = origSpan?.fontFamily ?? 'sourcesanspro'
  const origFontId = origSpan?.fontId ?? origFamily
  const origVariant = origSpan?.fontVariantId

  const spanStyle = (s: StyledSpan) => {
    // Resolve the span's font UUID back to a catalog slug (per-range family);
    // fall back to the original family when the id isn't a known catalog font.
    const slug = fontUuidToSlugOrNull(u32ToUUID(s.ff)) ?? origFontId
    return {
    fontFamily: slug,
    fontId: slug,
    fontVariantId: origVariant,
    fontWeight: String(s.fw),
    fontStyle: STYLED_FONT_STYLE[s.fy] ?? 'normal',
    // f32 round-trip noise (1.2 → 1.2000000476…) must not be committed into
    // the document — panels and serializers read these strings back.
    fontSize: String(round2(s.sz)),
    lineHeight: String(round2(s.lh)),
    letterSpacing: String(round2(s.ls)),
    textDecoration: STYLED_DECORATION[s.td] ?? 'none',
    textTransform: STYLED_TRANSFORM[s.tt] ?? 'none',
    textDirection: STYLED_DIRECTION[s.dr] ?? 'ltr',
    fills: fillsFromStyled(s.fl, origSpan?.fills),
    }
  }

  const EMPTY_SPAN: StyledSpan = {
    tx: '', ff: [0, 0, 0, 0], fy: 0, fw: 400, sz: 14, lh: 1.2, ls: 0, td: 0, tt: 0, dr: 0, fl: [],
  }
  const paras = styled.ps.length > 0 ? styled.ps : [{ ta: 0, ss: [] }]

  return {
    type: 'root',
    verticalAlign: STYLED_VERTICAL_ALIGN[styled.va] ?? 'top',
    children: [
      {
        type: 'paragraph-set',
        children: paras.map((p) => {
          const spans = p.ss.length > 0 ? p.ss : [EMPTY_SPAN]
          return {
            type: 'paragraph',
            textAlign: STYLED_PARA_ALIGN[p.ta] ?? 'left',
            ...spanStyle(spans[0]),
            children: spans.map((s) => ({ type: 'text', text: s.tx ?? '', ...spanStyle(s) })),
          }
        }),
      },
    ],
  }
}

/**
 * Commit the edited content back into the document model, then tear down the
 * WASM editor and clear all edit-mode signals. Safe to call once per session.
 */
export function commitTextEdit(module: WasmModule, shapeId: string): void {
  const exported = textEditorExportContent(module)
  const pageId = getActiveOrSinglePageId()

  if (pageId) {
    // Concatenate everything typed; an empty result means the user created the
    // box and left without typing (or deleted all text) — remove the shape
    // rather than leaving an empty box behind (matches Penpot/Figma).
    const typed = (exported ?? []).flat().join('')
    if (typed.length === 0) {
      const change = { type: 'del-obj', id: shapeId, pageId } as unknown as Change
      void applyChanges([change])
      const selected = getSelectedIdsSet()
      if (selected.has(shapeId)) {
        const next = new Set(selected)
        next.delete(shapeId)
        setSelectedIds(next)
      }
    } else if (exported) {
      const node = getPage(pageId)?.objects[shapeId] as { content?: unknown } | undefined
      // Prefer the styled export (per-range styling survives the commit); fall
      // back to the text-only rebuild if it's unavailable.
      const styled = textEditorExportStyled(module)
      const content = styled
        ? buildContentFromStyled(styled, node?.content)
        : rebuildTextContent(node?.content, exported)
      // Re-assert the final auto-size geometry with the content. The commit only
      // wrote `content` before, so re-serializing it reverted the box to a stale
      // single-line size and clipped any lines added after a break (auto-width/
      // auto-height). `fixed` boxes return null here and keep their drawn size.
      const value: Record<string, unknown> = { content }
      const geom = computeAutoSize(module, shapeId)
      if (geom) Object.assign(value, geom)
      const change = {
        type: 'mod-obj',
        id: shapeId,
        pageId,
        operations: [{ type: 'assign', value }],
      } as unknown as Change
      void applyChanges([change])
    }
  }

  textEditorBlur(module)
  textEditorDispose(module)
  textEditorActive.value = false
  textEditorShapeId.value = null
  textCaretRect.value = null
  textSelectionRects.value = []
  textIsComposing.value = false
  currentStyles.value = null
  textEditorIsEmpty.value = true
  requestRender(module, 'text-edit-end')
}
