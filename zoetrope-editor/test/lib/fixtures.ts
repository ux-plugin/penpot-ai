/**
 * Shared test fixtures — a minimal styled PenpotDocument (one page, rect, text)
 * plus store reset and seed helpers.
 *
 * `seedDocument` loads a document straight into the tables (no renderer, no
 * worker, no history), the way a test wants it. `resetWorkspace` empties the
 * store, the selection and the undo stack.
 */
import type { Fill, PenpotDocument, PenpotNode, PenpotPage, Stroke, TextContent } from 'penpot-exporter/types'
import { rebuildDerived } from '../../src/lib/doc/derived'
import {
  clearHistory,
  clearTables,
  currentPageId,
  getNode,
  importDocument,
  loadImported,
  meta,
} from '../../src/lib/doc'
import { clearSelection } from '../../src/lib/renderer/store/document-selection'

export const ROOT = '00000000-0000-0000-0000-000000000000'
export const PAGE_ID = 'page-1'
export const RECT_ID = 'rect-1'
export const TEXT_ID = 'text-1'

const rectSelrect = { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 }
const textSelrect = { x: 120, y: 0, width: 200, height: 32, x1: 120, y1: 0, x2: 320, y2: 32 }

export interface DocOptions {
  rectFill?: Fill
  rectStroke?: Stroke
  textContent?: TextContent
}

const defaultRectFill: Fill = { fillColor: '#888888', fillOpacity: 1 }

const defaultTextContent: TextContent = {
  type: 'root',
  verticalAlign: 'top',
  children: [
    {
      type: 'paragraph-set',
      children: [
        {
          type: 'paragraph',
          fontFamily: 'Inter',
          fontId: 'inter',
          fontSize: '14',
          fontWeight: '400',
          children: [{ text: 'Hello', fontFamily: 'Inter', fontId: 'inter', fontSize: '14', fontWeight: '400' }],
        },
      ],
    },
  ],
}

/** One page, one rect, one text. */
export function makeBaseDocument(options: DocOptions = {}): PenpotDocument {
  const rect: PenpotNode = {
    id: RECT_ID,
    type: 'rect',
    name: 'Rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: rectSelrect,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ],
    fills: [options.rectFill ?? defaultRectFill],
    ...(options.rectStroke ? { strokes: [options.rectStroke] } : {}),
  }
  const text = {
    id: TEXT_ID,
    type: 'text' as const,
    name: 'Text',
    x: 120,
    y: 0,
    width: 200,
    height: 32,
    selrect: textSelrect,
    points: [
      { x: 120, y: 0 },
      { x: 320, y: 0 },
      { x: 320, y: 32 },
      { x: 120, y: 32 },
    ],
    content: options.textContent ?? defaultTextContent,
  } as unknown as PenpotNode

  const page: PenpotPage = {
    id: PAGE_ID,
    name: 'Page 1',
    background: '#FFFFFF',
    children: [rect, text],
  }

  return {
    name: 'Test',
    children: [page],
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  }
}

/** Load `doc` into the store directly. First page becomes current. */
export function seedDocument(doc: PenpotDocument): void {
  const imported = importDocument(doc)
  loadImported(imported)
  currentPageId.value = imported.pages[0]?.id ?? null
}

/** A fresh document with one page holding a plain 10×10 rect per id. */
export function seedNodes(nodeIds: readonly string[], pageId = PAGE_ID): void {
  resetWorkspace()
  const node = (id: string) => ({ id, type: 'rect', name: id, x: 0, y: 0, width: 10, height: 10 }) as unknown as PenpotNode
  seedDocument({
    id: 'doc',
    name: 'doc',
    components: {},
    children: [{ id: pageId, name: 'Page', children: nodeIds.map(node) }],
  } as unknown as PenpotDocument)
}

/** Empty store, selection and history between tests. */
export function resetWorkspace(): void {
  clearTables()
  rebuildDerived()
  meta.value = null
  currentPageId.value = null
  clearSelection()
  clearHistory()
}

export function readRectFill(): Fill | undefined {
  return (getNode(RECT_ID) as { fills?: Fill[] } | undefined)?.fills?.[0]
}

export function readRectStroke(): Stroke | undefined {
  return (getNode(RECT_ID) as { strokes?: Stroke[] } | undefined)?.strokes?.[0]
}

/** The first text-node leaf (span) on TEXT_ID. */
export function readFirstSpan(): { fontFamily?: string; fontSize?: string; fontWeight?: string } | undefined {
  const node = getNode(TEXT_ID) as { content?: TextContent } | undefined
  return node?.content?.children?.[0]?.children?.[0]?.children?.[0]
}
