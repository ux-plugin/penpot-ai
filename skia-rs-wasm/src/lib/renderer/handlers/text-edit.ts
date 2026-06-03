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
} from '../api/text-editor'
import { requestRender } from '../api/rendering'
import { getTextDimensions } from '../api/text'
import {
  textEditorActive,
  textEditorShapeId,
  textCaretRect,
  textSelectionRects,
  textIsComposing,
} from '../signals/text-editor'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { applyChanges } from '../../page-crud'

/** Packed ARGB u32 (Skia `Color::new` order): a translucent blue selection and a
 * near-black opaque caret. NOTE: ARGB, not RGBA — writing these as RGBA puts the
 * intended RGB's last byte into the alpha slot, making the caret ~7% opaque
 * (invisible). */
const SELECTION_COLOR = 0x4d3b82f6
const CURSOR_COLOR = 0xff111111

/**
 * Enter edit mode for `shapeId`: focus the WASM editor, flip the render-loop
 * gate on, apply the caret/selection theme, and schedule a frame.
 */
export function startTextEdit(module: WasmModule, shapeId: string): void {
  textEditorFocus(module, shapeId)
  textEditorShapeId.value = shapeId
  textEditorActive.value = true
  textIsComposing.value = false
  textEditorApplyTheme(module, SELECTION_COLOR, CURSOR_COLOR)
  requestRender(module, 'text-edit-start')
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
export function syncTextEditGeometry(module: WasmModule, shapeId: string): void {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return
  const node = getPage(pageId)?.objects[shapeId] as
    | { selrect?: Selrect; growType?: string }
    | undefined
  const sel = node?.selrect
  if (!sel) return
  // Only content-driven boxes auto-resize while editing; `fixed` (the default)
  // keeps the size the user drew and stays resizable.
  const growType = node.growType ?? 'fixed'
  if (growType !== 'auto-width' && growType !== 'auto-height') return

  const dims = getTextDimensions(module, shapeId)
  const x = sel.x
  const y = sel.y
  const width = growType === 'auto-width' ? dims.width : sel.width
  const height = dims.height

  // Skip when nothing changed, to avoid per-frame applyChanges churn.
  if (Math.abs(width - sel.width) < 0.5 && Math.abs(height - sel.height) < 0.5) return

  const selrect = { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height }
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  const change = {
    type: 'mod-obj',
    id: shapeId,
    pageId,
    operations: [{ type: 'assign', value: { selrect, points, width, height } }],
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

/**
 * Commit the edited content back into the document model, then tear down the
 * WASM editor and clear all edit-mode signals. Safe to call once per session.
 */
export function commitTextEdit(module: WasmModule, shapeId: string): void {
  const exported = textEditorExportContent(module)
  const pageId = getActiveOrSinglePageId()

  if (exported && pageId) {
    const node = getPage(pageId)?.objects[shapeId] as { content?: unknown } | undefined
    const content = rebuildTextContent(node?.content, exported)
    const change = {
      type: 'mod-obj',
      id: shapeId,
      pageId,
      operations: [{ type: 'assign', value: { content } }],
    } as unknown as Change
    void applyChanges([change])
  }

  textEditorBlur(module)
  textEditorDispose(module)
  textEditorActive.value = false
  textEditorShapeId.value = null
  textCaretRect.value = null
  textSelectionRects.value = []
  textIsComposing.value = false
  requestRender(module, 'text-edit-end')
}
