/**
 * Interactive text-editor binding layer.
 *
 * Mirrors `frontend/src/app/render_wasm/text_editor.cljs` against the
 * render-wasm `text_editor_*` exports (declared in wasm-types.d.ts). This is
 * the TypeScript counterpart Penpot drives from ClojureScript: lifecycle,
 * keyboard/IME/pointer input, selection, content export/commit, the caret +
 * selection overlay loop, and the v3 style-data read/apply.
 *
 * Heap conventions (see utils.ts): string input is written into the
 * `_alloc_bytes` buffer (HEAPU8.set) and the no-arg export reads it; pointer
 * returns point into BUFFERU8 and must be released with `_free_bytes()`.
 */

import type { WasmModule } from '../wasm-types'
import { checkContext } from './context'
import { allocBytes, freeBytes, offset8To32 } from '../utils'
import { uuidToU32Tuple, u32ToUUID } from '@skia-rs-wasm/common/conversions'
import { FILL_U8_SIZE } from './constants'

// ─── Types ─────────────────────────────────────────────────────────────────

/** Mirrors render-wasm `CursorDirection`. */
export enum CursorDirection {
  Left = 0,
  Right = 1,
  Up = 2,
  Down = 3,
  Home = 4,
  End = 5,
}

/** Per-property aggregation state across the current selection. */
export const MULTIPLE = 'multiple' as const
export type MaybeMultiple<T> = T | typeof MULTIPLE | null

export interface TextSelection {
  anchorPara: number
  anchorOffset: number
  focusPara: number
  focusOffset: number
}

export interface NormalizedSelection {
  startPara: number
  startOffset: number
  endPara: number
  endOffset: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type SolidFill = { type: 'solid'; color: string; opacity: number }
export type NonSolidFill = { type: 'gradient' | 'image' | 'unknown' }
export type EditorFill = SolidFill | NonSolidFill

export type TextAlign = 'left' | 'center' | 'right' | 'justify'
export type TextDirection = 'ltr' | 'rtl'
export type TextDecoration = 'none' | 'underline' | 'line-through' | 'overline'
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize'
export type VerticalAlign = 'top' | 'center' | 'bottom'
export type FontStyle = 'normal' | 'italic' | 'oblique'

export interface CurrentStyles {
  verticalAlign: VerticalAlign
  textAlign: MaybeMultiple<TextAlign>
  textDirection: MaybeMultiple<TextDirection>
  textDecoration: MaybeMultiple<TextDecoration>
  textTransform: MaybeMultiple<TextTransform>
  fontFamily: MaybeMultiple<string>
  fontId: MaybeMultiple<string>
  fontSize: MaybeMultiple<number>
  fontWeight: MaybeMultiple<number>
  fontStyle: FontStyle
  fontVariantId: MaybeMultiple<string>
  lineHeight: MaybeMultiple<number>
  letterSpacing: MaybeMultiple<number>
  /** When fills are mixed across the selection, `fills` is MULTIPLE and the
   * actual list is preserved here. */
  selectedColors: EditorFill[] | null
  fills: EditorFill[] | typeof MULTIPLE
}

// ─── Internal helpers ────────────────────────────────────────────────────────

const encoder = new TextEncoder()

/** Writes a UTF-8 string into the alloc buffer for the editor's no-arg readers
 * (insert_text, composition_update, composition_end). Caller frees afterwards. */
function pushEditorText(module: WasmModule, text: string): void {
  const bytes = encoder.encode(text)
  const offset = allocBytes(module, bytes.length)
  module.HEAPU8.set(bytes, offset)
}

/** Reads a null-terminated UTF-8 string from a returned pointer, then frees. */
function readPtrString(module: WasmModule, ptr: number): string | null {
  if (!ptr) return null
  const s = module.UTF8ToString(ptr)
  freeBytes(module)
  return s
}

/** State machine for a per-property `Multiple<T>` word: 0=undefined, 1=single,
 * 2=multiple. Returns the value for single, MULTIPLE for mixed, default else. */
function fromState<T>(state: number, value: T, defaultValue: T | null = null): MaybeMultiple<T> {
  switch (state) {
    case 1:
      return value
    case 2:
      return MULTIPLE
    default:
      return defaultValue
  }
}

const TEXT_ALIGN: TextAlign[] = ['left', 'center', 'right', 'justify']
const TEXT_DIRECTION: TextDirection[] = ['ltr', 'rtl']
const TEXT_DECORATION: TextDecoration[] = ['none', 'underline', 'line-through', 'overline']
const TEXT_TRANSFORM: TextTransform[] = ['none', 'uppercase', 'lowercase', 'capitalize']
const VERTICAL_ALIGN: VerticalAlign[] = ['top', 'center', 'bottom']
const FONT_STYLE: FontStyle[] = ['normal', 'italic', 'oblique']

/** ARGB u32 → { color: "#rrggbb", opacity }. Inverse of colorToU32ARGB. */
function decodeArgb(argb: number): { color: string; opacity: number } {
  const a = (argb >>> 24) & 0xff
  const r = (argb >>> 16) & 0xff
  const g = (argb >>> 8) & 0xff
  const b = argb & 0xff
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return { color: `#${hex(r)}${hex(g)}${hex(b)}`, opacity: a / 255 }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function textEditorFocus(module: WasmModule, shapeId: string): boolean {
  checkContext()
  const [a, b, c, d] = uuidToU32Tuple(shapeId)
  return module._text_editor_focus(a, b, c, d)
}

export function textEditorBlur(module: WasmModule): boolean {
  return module._text_editor_blur()
}

export function textEditorDispose(module: WasmModule): boolean {
  return module._text_editor_dispose()
}

export function textEditorHasFocus(module: WasmModule): boolean {
  return module._text_editor_has_focus()
}

export function textEditorHasFocusWithId(module: WasmModule, shapeId: string): boolean {
  const [a, b, c, d] = uuidToU32Tuple(shapeId)
  return module._text_editor_has_focus_with_id(a, b, c, d)
}

export function textEditorHasSelection(module: WasmModule): boolean {
  return module._text_editor_has_selection()
}

/** Reads the active editing shape's UUID, or null when not editing. */
export function textEditorGetActiveShapeId(module: WasmModule): string | null {
  const ptr = allocBytes(module, 16)
  module._text_editor_get_active_shape_id(ptr)
  const o = offset8To32(ptr)
  const u32 = module.HEAPU32
  const id = u32ToUUID([u32[o], u32[o + 1], u32[o + 2], u32[o + 3]])
  freeBytes(module)
  return id === '00000000-0000-0000-0000-000000000000' ? null : id
}

/** selectionColor / cursorColor are packed RGBA u32. */
export function textEditorApplyTheme(module: WasmModule, selectionColor: number, cursorColor: number): void {
  module._text_editor_apply_theme(selectionColor, cursorColor)
}

// ─── Input ───────────────────────────────────────────────────────────────────

export function textEditorInsertText(module: WasmModule, text: string): void {
  checkContext()
  pushEditorText(module, text)
  module._text_editor_insert_text()
  freeBytes(module)
}

export function textEditorInsertParagraph(module: WasmModule): void {
  module._text_editor_insert_paragraph()
}

export function textEditorDeleteBackward(module: WasmModule, wordBoundary = false): void {
  module._text_editor_delete_backward(wordBoundary)
}

export function textEditorDeleteForward(module: WasmModule, wordBoundary = false): void {
  module._text_editor_delete_forward(wordBoundary)
}

export function textEditorMoveCursor(
  module: WasmModule,
  direction: CursorDirection,
  wordBoundary = false,
  extendSelection = false
): void {
  module._text_editor_move_cursor(direction, wordBoundary, extendSelection)
}

export function textEditorToggleOvertypeMode(module: WasmModule): void {
  module._text_editor_toggle_overtype_mode()
}

export function textEditorCompositionStart(module: WasmModule): void {
  module._text_editor_composition_start()
}

export function textEditorCompositionUpdate(module: WasmModule, text: string): void {
  pushEditorText(module, text)
  module._text_editor_composition_update()
  freeBytes(module)
}

export function textEditorCompositionEnd(module: WasmModule, text: string): void {
  pushEditorText(module, text)
  module._text_editor_composition_end()
  freeBytes(module)
}

// ─── Pointer ─────────────────────────────────────────────────────────────────

export function textEditorPointerDown(module: WasmModule, x: number, y: number): void {
  module._text_editor_pointer_down(x, y)
}

export function textEditorPointerMove(module: WasmModule, x: number, y: number): void {
  module._text_editor_pointer_move(x, y)
}

export function textEditorPointerUp(module: WasmModule, x: number, y: number): void {
  module._text_editor_pointer_up(x, y)
}

export function textEditorSetCursorFromOffset(module: WasmModule, x: number, y: number): void {
  module._text_editor_set_cursor_from_offset(x, y)
}

export function textEditorSetCursorFromPoint(module: WasmModule, x: number, y: number): void {
  module._text_editor_set_cursor_from_point(x, y)
}

export function textEditorSelectWordBoundary(module: WasmModule, x: number, y: number): void {
  module._text_editor_select_word_boundary(x, y)
}

export function textEditorSelectAll(module: WasmModule): boolean {
  return module._text_editor_select_all()
}

// ─── Selection ───────────────────────────────────────────────────────────────

export function textEditorGetSelection(module: WasmModule): TextSelection | null {
  const ptr = allocBytes(module, 16)
  const has = module._text_editor_get_selection(ptr)
  if (!has) {
    freeBytes(module)
    return null
  }
  const o = offset8To32(ptr)
  const u32 = module.HEAPU32
  const sel: TextSelection = {
    anchorPara: u32[o],
    anchorOffset: u32[o + 1],
    focusPara: u32[o + 2],
    focusOffset: u32[o + 3],
  }
  freeBytes(module)
  return sel
}

/** Reorders so start <= end (anchor/focus may be reversed for upward/RTL). */
export function normalizeSelection(sel: TextSelection): NormalizedSelection {
  const before =
    sel.anchorPara < sel.focusPara ||
    (sel.anchorPara === sel.focusPara && sel.anchorOffset <= sel.focusOffset)
  return before
    ? { startPara: sel.anchorPara, startOffset: sel.anchorOffset, endPara: sel.focusPara, endOffset: sel.focusOffset }
    : { startPara: sel.focusPara, startOffset: sel.focusOffset, endPara: sel.anchorPara, endOffset: sel.anchorOffset }
}

export function isSelectionCollapsed(sel: TextSelection): boolean {
  return sel.anchorPara === sel.focusPara && sel.anchorOffset === sel.focusOffset
}

// ─── Render / overlay (called each frame) ───────────────────────────────────

export function textEditorUpdateBlink(module: WasmModule, timestampMs: number): void {
  module._text_editor_update_blink(timestampMs)
}

export function textEditorRenderOverlay(module: WasmModule): void {
  module._text_editor_render_overlay()
}

/** Nonzero when an editor event happened this frame and a re-render is needed. */
export function textEditorPollEvent(module: WasmModule): number {
  return module._text_editor_poll_event()
}

// ─── Geometry getters ────────────────────────────────────────────────────────

export function textEditorGetCursorRect(module: WasmModule): Rect | null {
  const ptr = module._text_editor_get_cursor_rect()
  if (!ptr) return null
  const o = offset8To32(ptr)
  const f32 = module.HEAPF32
  const rect: Rect = { x: f32[o], y: f32[o + 1], width: f32[o + 2], height: f32[o + 3] }
  freeBytes(module)
  return rect
}

export function textEditorGetSelectionRects(module: WasmModule): Rect[] {
  const ptr = module._text_editor_get_selection_rects()
  if (!ptr) return []
  const o = offset8To32(ptr)
  const u32 = module.HEAPU32
  const f32 = module.HEAPF32
  const count = u32[o]
  const rects: Rect[] = []
  for (let i = 0; i < count; i++) {
    const b = o + 1 + i * 4
    rects.push({ x: f32[b], y: f32[b + 1], width: f32[b + 2], height: f32[b + 3] })
  }
  freeBytes(module)
  return rects
}

// ─── Content export ──────────────────────────────────────────────────────────

/** Editor content as nested arrays of span text: [[p1span1, p1span2], [p2..]]. */
export function textEditorExportContent(module: WasmModule): string[][] | null {
  const ptr = module._text_editor_export_content()
  const json = readPtrString(module, ptr)
  if (json == null) return null
  try {
    return JSON.parse(json) as string[][]
  } catch {
    return null
  }
}

/** Currently-selected text as a plain string. */
export function textEditorExportSelection(module: WasmModule): string | null {
  const ptr = module._text_editor_export_selection()
  return readPtrString(module, ptr)
}

// ─── v3 styles (read) ────────────────────────────────────────────────────────

/**
 * Decodes the style-data buffer produced by `text_editor_get_current_styles`.
 * Layout contract (see render-wasm/src/wasm/text_editor.rs): little-endian,
 * 13-word header (indices 0..=12), 18-word value section (13..=30), then
 * `fillCount` × FILL_U8_SIZE fill records starting at byte 124.
 */
export function textEditorGetCurrentStyles(module: WasmModule): CurrentStyles | null {
  const ptr = module._text_editor_get_current_styles()
  if (!ptr) return null

  const o = offset8To32(ptr)
  const u32 = module.HEAPU32
  const i32 = module.HEAP32
  const f32 = module.HEAPF32

  // Header (states + counts)
  const verticalAlignRaw = u32[o + 0]
  const textAlignState = u32[o + 1]
  const textDirectionState = u32[o + 2]
  const textDecorationState = u32[o + 3]
  const textTransformState = u32[o + 4]
  const fontFamilyState = u32[o + 5]
  const fontSizeState = u32[o + 6]
  const fontWeightState = u32[o + 7]
  const fontVariantState = u32[o + 8]
  const lineHeightState = u32[o + 9]
  const letterSpacingState = u32[o + 10]
  const fillCount = u32[o + 11]
  const fillMultiple = u32[o + 12]

  // Values
  const textAlignVal = TEXT_ALIGN[u32[o + 13]] ?? 'left'
  const textDirectionVal = TEXT_DIRECTION[u32[o + 14]] ?? 'ltr'
  const textDecorationVal = TEXT_DECORATION[u32[o + 15]] ?? 'none'
  const textTransformVal = TEXT_TRANSFORM[u32[o + 16]] ?? 'none'
  const fontFamilyId = u32ToUUID([u32[o + 17], u32[o + 18], u32[o + 19], u32[o + 20]])
  const fontStyleVal = FONT_STYLE[u32[o + 21]] ?? 'normal'
  const fontSizeVal = f32[o + 23]
  const fontWeightVal = i32[o + 24]
  const fontVariantId = u32ToUUID([u32[o + 25], u32[o + 26], u32[o + 27], u32[o + 28]])
  const lineHeightVal = f32[o + 29]
  const letterSpacingVal = f32[o + 30]

  // Fills (after the 124-byte fixed section)
  const fills: EditorFill[] = []
  const view = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset)
  for (let i = 0; i < fillCount; i++) {
    const fo = ptr + 124 + i * FILL_U8_SIZE
    const type = view.getUint8(fo)
    if (type === 0x00) {
      fills.push({ type: 'solid', ...decodeArgb(view.getUint32(fo + 4, true)) })
    } else if (type === 0x01 || type === 0x02) {
      fills.push({ type: 'gradient' })
    } else {
      fills.push({ type: 'image' })
    }
  }

  const isMixed = fillMultiple === 1
  freeBytes(module)

  return {
    verticalAlign: VERTICAL_ALIGN[verticalAlignRaw] ?? 'top',
    textAlign: fromState(textAlignState, textAlignVal),
    textDirection: fromState(textDirectionState, textDirectionVal),
    textDecoration: fromState(textDecorationState, textDecorationVal),
    textTransform: fromState(textTransformState, textTransformVal),
    fontFamily: fromState(fontFamilyState, fontFamilyId),
    fontId: fromState(fontFamilyState, fontFamilyId),
    fontSize: fromState(fontSizeState, fontSizeVal),
    fontWeight: fromState(fontWeightState, fontWeightVal),
    fontStyle: fontStyleVal,
    fontVariantId: fromState(fontVariantState, fontVariantId),
    lineHeight: fromState(lineHeightState, lineHeightVal),
    letterSpacing: fromState(letterSpacingState, letterSpacingVal),
    selectedColors: isMixed ? fills : null,
    fills: isMixed ? MULTIPLE : fills,
  }
}
