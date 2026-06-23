/**
 * Library sync fan-out.
 *
 * When a paint or text style changes, every shape that references it
 * (`fillColorRefId` / `strokeColorRefId` / `typographyRefId` matches) needs
 * its cached value rewritten — the renderer only ever sees concrete values,
 * not refs, so without this pass shapes would visually freeze on the old
 * color or font until each one was touched manually.
 *
 * Sync ships as a CASCADE inside the same commit as the style edit: the
 * doc-meta arm carries `mod-paint-style` / `mod-text-style`, and the page
 * arm carries one `mod-obj` per affected shape. One frame on the undo stack
 * reverts both: the style and every cached value it touched.
 *
 * We never look at the OLD style's value when building the redo — only the
 * new style and the shape's existing fills/strokes/content. This means the
 * sync is idempotent: running it twice produces the same shape state. Undo
 * works because the inverse `mod-obj` carries the shape's pre-sync arrays
 * verbatim, captured at sync time.
 */

import { snapshot } from 'valtio'
import type {
  Change,
  Fill,
  ModObjChange,
  Paragraph,
  Stroke,
  TextContent,
  TextNode,
  TextStyle,
  Uuid,
} from 'penpot-exporter/types'
import { docProxy } from '../renderer/store/doc-proxy'
import {
  type LibraryColor,
  type LibraryTypography,
  libraryColorCanonical,
  libraryTypographyCanonical,
} from './types'

interface FillsOwner {
  fills?: Fill[]
}
interface StrokesOwner {
  strokes?: Stroke[]
}
interface TextOwner {
  content?: TextContent
  type?: string
}

/** Rewrite a fill's cached color from a (new) library color, preserving refs and image. */
function rewriteFillFromStyle(fill: Fill, style: LibraryColor): Fill {
  const c = libraryColorCanonical(style)
  return {
    ...fill,
    fillColor: c?.color,
    fillColorGradient: c?.gradient,
    fillOpacity: c?.opacity ?? fill.fillOpacity ?? 1,
    // Ref fields stay; ref-by-id is the link, ref-by-file is the home file.
  }
}

function rewriteStrokeFromStyle(stroke: Stroke, style: LibraryColor): Stroke {
  const c = libraryColorCanonical(style)
  return {
    ...stroke,
    strokeColor: c?.color,
    strokeColorGradient: c?.gradient,
    strokeOpacity: c?.opacity ?? stroke.strokeOpacity ?? 1,
  }
}

function buildModObj(
  pageId: string,
  id: string,
  assign: Record<string, unknown>,
): ModObjChange {
  return {
    type: 'mod-obj',
    id,
    pageId,
    operations: [{ type: 'assign', value: assign }],
  }
}

/**
 * Walk every shape on every page, find fills/strokes whose ref matches
 * `styleId`, build paired mod-obj redo/undo. Returned vectors are ready to be
 * concatenated into a `commitChanges({ redoChanges, undoChanges, ...
 * docMeta... })` call.
 */
export function collectPaintStyleSync(
  styleId: Uuid,
  next: LibraryColor,
): { redoChanges: Change[]; undoChanges: Change[] } {
  const redo: Change[] = []
  const undo: Change[] = []
  const docSnap = snapshot(docProxy)

  for (const [pageId, page] of docSnap.pageMap) {
    for (const id of Object.keys(page.objects)) {
      const shape = page.objects[id] as FillsOwner & StrokesOwner
      const fills = shape.fills
      const strokes = shape.strokes

      let touched = false
      const nextFills = fills?.map((f) =>
        f.fillColorRefId === styleId ? rewriteFillFromStyle(f, next) : f,
      )
      const nextStrokes = strokes?.map((s) =>
        s.strokeColorRefId === styleId ? rewriteStrokeFromStyle(s, next) : s,
      )

      if (fills && nextFills && nextFills.some((f, i) => f !== fills[i])) touched = true
      if (strokes && nextStrokes && nextStrokes.some((s, i) => s !== strokes[i])) touched = true
      if (!touched) continue

      const assignNext: Record<string, unknown> = {}
      const assignPrev: Record<string, unknown> = {}
      if (fills && nextFills && nextFills.some((f, i) => f !== fills[i])) {
        assignNext.fills = nextFills
        assignPrev.fills = fills.map((f) => ({ ...f }))
      }
      if (strokes && nextStrokes && nextStrokes.some((s, i) => s !== strokes[i])) {
        assignNext.strokes = nextStrokes
        assignPrev.strokes = strokes.map((s) => ({ ...s }))
      }

      redo.push(buildModObj(pageId, id, assignNext))
      // Prepend undo so replay-in-array-order matches reverse-order-of-redo.
      undo.unshift(buildModObj(pageId, id, assignPrev))
    }
  }
  return { redoChanges: redo, undoChanges: undo }
}

/**
 * Build a TextStyle patch from a new library typography — just the cached
 * font fields; ref fields stay on the shape.
 */
function typographyPatchFromStyle(style: LibraryTypography): TextStyle {
  const t = libraryTypographyCanonical(style)
  return {
    fontId: t.fontId,
    fontFamily: t.fontFamily,
    fontVariantId: t.fontVariantId,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
  }
}

/** Stamp a typography patch onto every span/paragraph carrying the matching ref. */
function rewriteContent(
  content: TextContent,
  styleId: Uuid,
  patch: TextStyle,
): { content: TextContent; touched: boolean } {
  let touched = false
  const next: TextContent = structuredClone(content)
  for (const set of next.children ?? []) {
    for (const paragraph of set.children ?? []) {
      const p = paragraph as Paragraph
      if (p.typographyRefId === styleId) {
        Object.assign(paragraph, patch)
        touched = true
      }
      for (const span of paragraph.children ?? []) {
        const s = span as TextNode
        if (s.typographyRefId === styleId) {
          Object.assign(span, patch)
          touched = true
        }
      }
    }
  }
  return { content: next, touched }
}

export function collectTextStyleSync(
  styleId: Uuid,
  next: LibraryTypography,
): { redoChanges: Change[]; undoChanges: Change[] } {
  const redo: Change[] = []
  const undo: Change[] = []
  const docSnap = snapshot(docProxy)
  const patch = typographyPatchFromStyle(next)

  for (const [pageId, page] of docSnap.pageMap) {
    for (const id of Object.keys(page.objects)) {
      const shape = page.objects[id] as TextOwner
      if (shape.type !== 'text' || !shape.content) continue
      const { content: rewritten, touched } = rewriteContent(shape.content, styleId, patch)
      if (!touched) continue
      redo.push(
        buildModObj(pageId, id, { content: rewritten }),
      )
      undo.unshift(
        buildModObj(pageId, id, { content: structuredClone(shape.content) }),
      )
    }
  }
  return { redoChanges: redo, undoChanges: undo }
}
