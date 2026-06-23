/**
 * Library apply / detach / CRUD.
 *
 * Two responsibilities live here:
 *
 *   1. **Library CRUD** — create / modify / delete paint and text styles on
 *      `docProxy.meta.{paintStyles,textStyles}`. Routed through `commitChanges`
 *      with `docMetaRedoChanges` / `docMetaUndoChanges` so the library edit
 *      joins the unified undo stack.
 *
 *   2. **Apply / detach** — write a style's cached value + `*RefId` / `*RefFile`
 *      onto a shape's fill, stroke, or text spans (apply); strip the ref fields
 *      while keeping the cached value (detach). Reuses the existing
 *      `commitNodePartialUpdate` page-change path; no new commit infrastructure.
 *
 * Sync (fan-out on style edit) lives in `./sync.ts` (P1.5), not here. CRUD just
 * mutates the doc-meta arm; sync is the cascading rewrite that follows.
 */

import { snapshot } from 'valtio'
import type { Fill, PenpotNode, Stroke, TextContent, Uuid } from 'penpot-exporter/types'
import {
  docProxy,
  getActiveOrSinglePageId,
} from '../renderer/store/doc-proxy'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../renderer/properties/commit-node-properties'
import { commitChanges } from '../renderer/store/commit'
import { patchContent } from '../components/RightSidePanel/Sections/text-typography'
import type { DocMetaChange } from '../changes/doc-meta-change'
import {
  type LibraryColor,
  type LibraryTypography,
  libraryColorCanonical,
  libraryColorToFill,
  libraryTypographyToTextStyle,
} from './types'
import { collectPaintStyleSync, collectTextStyleSync } from './sync'

// ── CRUD ───────────────────────────────────────────────────────────────────

/** Commit a single doc-meta redo/undo pair as one undoable frame. */
async function commitDocMetaPair(redo: DocMetaChange, undo: DocMetaChange): Promise<void> {
  await commitChanges({
    redoChanges: [],
    undoChanges: [],
    docMetaRedoChanges: [redo],
    docMetaUndoChanges: [undo],
  })
}

export async function addPaintStyle(id: Uuid, style: LibraryColor): Promise<void> {
  await commitDocMetaPair(
    { type: 'add-paint-style', id, style },
    { type: 'del-paint-style', id },
  )
}

export async function modifyPaintStyle(id: Uuid, next: LibraryColor): Promise<void> {
  const prior = snapshot(docProxy).meta?.paintStyles[id] as LibraryColor | undefined
  if (!prior) return
  // Cascade: every fill/stroke whose `*ColorRefId === id` gets its cached
  // value rewritten in the SAME commit, so Cmd+Z reverts the style edit and
  // every shape it touched atomically.
  const sync = collectPaintStyleSync(id, next)
  await commitChanges({
    redoChanges: sync.redoChanges,
    undoChanges: sync.undoChanges,
    docMetaRedoChanges: [{ type: 'mod-paint-style', id, style: next }],
    docMetaUndoChanges: [{ type: 'mod-paint-style', id, style: prior as LibraryColor }],
  })
}

export async function deletePaintStyle(id: Uuid): Promise<void> {
  const prior = snapshot(docProxy).meta?.paintStyles[id] as LibraryColor | undefined
  if (!prior) return
  await commitDocMetaPair(
    { type: 'del-paint-style', id },
    { type: 'add-paint-style', id, style: prior as LibraryColor },
  )
}

export async function addTextStyle(id: Uuid, style: LibraryTypography): Promise<void> {
  await commitDocMetaPair(
    { type: 'add-text-style', id, style },
    { type: 'del-text-style', id },
  )
}

export async function modifyTextStyle(id: Uuid, next: LibraryTypography): Promise<void> {
  const prior = snapshot(docProxy).meta?.textStyles[id] as LibraryTypography | undefined
  if (!prior) return
  const sync = collectTextStyleSync(id, next)
  await commitChanges({
    redoChanges: sync.redoChanges,
    undoChanges: sync.undoChanges,
    docMetaRedoChanges: [{ type: 'mod-text-style', id, style: next }],
    docMetaUndoChanges: [{ type: 'mod-text-style', id, style: prior as LibraryTypography }],
  })
}

export async function deleteTextStyle(id: Uuid): Promise<void> {
  const prior = snapshot(docProxy).meta?.textStyles[id] as LibraryTypography | undefined
  if (!prior) return
  await commitDocMetaPair(
    { type: 'del-text-style', id },
    { type: 'add-text-style', id, style: prior as LibraryTypography },
  )
}

// ── Apply / detach ─────────────────────────────────────────────────────────

interface FillsOwner {
  fills?: Fill[]
}
interface StrokesOwner {
  strokes?: Stroke[]
}
interface TextOwner {
  content?: TextContent
}

/** Read paintStyles[id] off the live proxy (snapshot for stable read). */
function getPaintStyle(id: Uuid): LibraryColor | undefined {
  return snapshot(docProxy).meta?.paintStyles[id] as LibraryColor | undefined
}

function getTextStyle(id: Uuid): LibraryTypography | undefined {
  return snapshot(docProxy).meta?.textStyles[id] as LibraryTypography | undefined
}

/** Translate a library color into the stroke-shaped fields (mirrors fillToStroke axis-shift). */
function libraryColorToStrokeFields(
  style: LibraryColor,
  fileId: Uuid | undefined,
): Partial<Stroke> {
  const c = libraryColorCanonical(style)
  return {
    strokeColor: c?.color,
    strokeColorGradient: c?.gradient,
    strokeOpacity: c?.opacity ?? 1,
    strokeColorRefId: c?.id,
    strokeColorRefFile: fileId,
  }
}

/**
 * Apply a paint style to a fill at `fillIndex`. The cached color/opacity/
 * gradient is copied in alongside `fillColorRefId/RefFile` so the renderer
 * still sees a concrete fill (the renderer is ref-blind) and the sync path
 * can find references later.
 *
 * `fileId` is the home file of the style — undefined for now (no cross-file
 * libraries yet). Threaded through so the field structure matches Penpot when
 * shared libraries land.
 */
export async function applyColorStyleToFill(
  nodeId: string,
  fillIndex: number,
  styleId: Uuid,
  fileId?: Uuid,
): Promise<void> {
  const style = getPaintStyle(styleId)
  if (!style) return
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  const pid = getActiveOrSinglePageId()
  const currentFills = (before as FillsOwner).fills ?? []
  if (fillIndex < 0 || fillIndex > currentFills.length) return
  const next = [...currentFills]
  next[fillIndex] = libraryColorToFill(style, fileId)
  await commitNodePartialUpdate(nodeId, before, { fills: next } as Partial<PenpotNode>, pid)
}

export async function applyColorStyleToStroke(
  nodeId: string,
  strokeIndex: number,
  styleId: Uuid,
  fileId?: Uuid,
): Promise<void> {
  const style = getPaintStyle(styleId)
  if (!style) return
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  const pid = getActiveOrSinglePageId()
  const currentStrokes = (before as StrokesOwner).strokes ?? []
  if (strokeIndex < 0 || strokeIndex >= currentStrokes.length) return
  const next = [...currentStrokes]
  const existing = currentStrokes[strokeIndex] ?? {}
  // Preserve stroke-only attributes (width, alignment, style, caps), replace
  // the color-bearing fields and ref pair.
  next[strokeIndex] = { ...existing, ...libraryColorToStrokeFields(style, fileId) }
  await commitNodePartialUpdate(nodeId, before, { strokes: next } as Partial<PenpotNode>, pid)
}

/** Apply a typography to every paragraph/span on a text node. */
export async function applyTypographyToTextNode(
  nodeId: string,
  typographyId: Uuid,
  fileId?: Uuid,
): Promise<void> {
  const style = getTextStyle(typographyId)
  if (!style) return
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before || (before as { type?: string }).type !== 'text') return
  const pid = getActiveOrSinglePageId()
  const ts = libraryTypographyToTextStyle(style, fileId)
  const content = patchContent((before as TextOwner).content, { span: ts })
  await commitNodePartialUpdate(nodeId, before, { content } as Partial<PenpotNode>, pid)
}

/** Drop ref fields from a fill while keeping its cached value. */
export async function detachFill(nodeId: string, fillIndex: number): Promise<void> {
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  const pid = getActiveOrSinglePageId()
  const currentFills = (before as FillsOwner).fills ?? []
  const target = currentFills[fillIndex]
  if (!target) return
  const { fillColorRefId: _r, fillColorRefFile: _f, ...rest } = target
  const next = [...currentFills]
  next[fillIndex] = rest
  await commitNodePartialUpdate(nodeId, before, { fills: next } as Partial<PenpotNode>, pid)
}

export async function detachStroke(nodeId: string, strokeIndex: number): Promise<void> {
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  const pid = getActiveOrSinglePageId()
  const currentStrokes = (before as StrokesOwner).strokes ?? []
  const target = currentStrokes[strokeIndex]
  if (!target) return
  const { strokeColorRefId: _r, strokeColorRefFile: _f, ...rest } = target
  const next = [...currentStrokes]
  next[strokeIndex] = rest
  await commitNodePartialUpdate(nodeId, before, { strokes: next } as Partial<PenpotNode>, pid)
}

/** Strip typography ref fields from every span/paragraph; keep cached props. */
export async function detachTypography(nodeId: string): Promise<void> {
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before || (before as { type?: string }).type !== 'text') return
  const pid = getActiveOrSinglePageId()
  const content = (before as TextOwner).content
  if (!content) return
  const next: TextContent = structuredClone(content)
  for (const set of next.children ?? []) {
    for (const paragraph of set.children ?? []) {
      // Don't reuse patchContent here — it only assigns, doesn't strip.
      delete (paragraph as { typographyRefId?: string }).typographyRefId
      delete (paragraph as { typographyRefFile?: string }).typographyRefFile
      for (const span of paragraph.children ?? []) {
        delete (span as { typographyRefId?: string }).typographyRefId
        delete (span as { typographyRefFile?: string }).typographyRefFile
      }
    }
  }
  await commitNodePartialUpdate(nodeId, before, { content: next } as Partial<PenpotNode>, pid)
}
