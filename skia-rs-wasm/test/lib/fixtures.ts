/**
 * Shared test fixtures — a minimal styled PenpotDocument (one page, root frame,
 * rect, text) plus workspace reset + read helpers. Used by the tokens tests.
 *
 * Notes:
 *  - `PenpotPage.children` is a FLAT list `[root, shape1, shape2, …]`. Nested
 *    children only sit inside frames/groups via their own `children`. See
 *    `src/lib/worker/flatten.ts`.
 *  - `resetWorkspace()` clears docProxy + history so tests can't bleed state.
 */

import type {
  Fill,
  PenpotDocument,
  PenpotNode,
  PenpotPage,
  Stroke,
  TextContent,
} from 'penpot-exporter/types'
import { docProxy } from '../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../src/lib/history/history-store'

export const ROOT = '00000000-0000-0000-0000-000000000000'
export const PAGE_ID = 'page-1'
export const RECT_ID = 'rect-1'
export const TEXT_ID = 'text-1'

const rootSelrect = { x: 0, y: 0, width: 800, height: 600, x1: 0, y1: 0, x2: 800, y2: 600 }
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
          children: [
            {
              text: 'Hello',
              fontFamily: 'Inter',
              fontId: 'inter',
              fontSize: '14',
              fontWeight: '400',
            },
          ],
        },
      ],
    },
  ],
}

/** One page, one root frame, one rect, one text. */
export function makeBaseDocument(options: DocOptions = {}): PenpotDocument {
  const root: PenpotNode = {
    id: ROOT,
    type: 'frame',
    name: 'Root',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    selrect: rootSelrect,
    points: [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 800, y: 600 },
      { x: 0, y: 600 },
    ],
  }
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
    children: [root, rect, text],
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

/** Clean docProxy + history between tests. */
export function resetWorkspace(): void {
  docProxy.meta = null
  docProxy.pageMap.clear()
  docProxy.currentPageId = null
  docProxy.selectedIds.clear()
  useHistoryStore.setState({
    undoStack: [],
    redoStack: [],
    transaction: null,
    transactionHolders: new Set(),
    focusBuffer: null,
  })
}

/** Convenience: the rect's first fill from the live page map. */
export function readRectFill(): Fill | undefined {
  const node = docProxy.pageMap.get(PAGE_ID)?.objects[RECT_ID] as { fills?: Fill[] } | undefined
  return node?.fills?.[0]
}

/** Convenience: the rect's first stroke. */
export function readRectStroke(): Stroke | undefined {
  const node = docProxy.pageMap.get(PAGE_ID)?.objects[RECT_ID] as { strokes?: Stroke[] } | undefined
  return node?.strokes?.[0]
}

/** Convenience: the first text-node leaf (span) on TEXT_ID. */
export function readFirstSpan():
  | { fontFamily?: string; fontSize?: string; fontWeight?: string }
  | undefined {
  const node = docProxy.pageMap.get(PAGE_ID)?.objects[TEXT_ID] as
    | { content?: TextContent }
    | undefined
  return node?.content?.children?.[0]?.children?.[0]?.children?.[0]
}
