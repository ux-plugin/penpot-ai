/**
 * Summaries drive the documents list — including the filmstrip, which draws one
 * cell per page — so they must be derivable from any document the store might
 * hold, including ones that arrive malformed from an import. Every unexpected
 * shape counts as zero rather than throwing: a bad summary must never fail the
 * save that produced it.
 */

import { describe, expect, it } from 'vitest'
import type { PenpotDocument } from 'penpot-exporter/types'
import { boardCount, pageCount, summarize } from '../../../src/lib/persistence/document-summary'

const ROOT = '00000000-0000-0000-0000-000000000000'

/** A page whose root frame holds `boards` boards plus one non-board shape. */
function page(id: string, boards: number, name = id) {
  return {
    id,
    name,
    children: [
      {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        children: [
          ...Array.from({ length: boards }, (_, i) => ({
            id: `${id}-board-${i}`,
            type: 'frame',
            name: `Board ${i}`,
          })),
          { id: `${id}-rect`, type: 'rect', name: 'Loose shape' },
        ],
      },
    ],
  }
}

const doc = (fields: Record<string, unknown>) => fields as unknown as PenpotDocument

describe('document summary', () => {
  it('describes each page by id, name, and board count', () => {
    const summary = summarize(
      doc({ name: 'Kestrel', children: [page('p1', 3, 'Sign up'), page('p2', 2, 'Verify')] }),
    )
    expect(summary).toEqual({
      name: 'Kestrel',
      pages: [
        { id: 'p1', name: 'Sign up', boardCount: 3 },
        { id: 'p2', name: 'Verify', boardCount: 2 },
      ],
    })
  })

  it('derives both totals from the pages', () => {
    const summary = summarize(doc({ name: 'D', children: [page('p1', 3), page('p2', 2)] }))
    expect(pageCount(summary)).toBe(2)
    expect(boardCount(summary)).toBe(5)
  })

  it('counts only boards, not other shapes on the root frame', () => {
    expect(summarize(doc({ name: 'D', children: [page('p1', 0)] })).pages[0]!.boardCount).toBe(0)
  })

  it('falls back to the first child when no root frame carries the root id', () => {
    const odd = doc({
      name: 'Imported',
      children: [
        {
          id: 'p1',
          name: 'p1',
          children: [{ id: 'other-root', type: 'frame', children: [{ id: 'b', type: 'frame' }] }],
        },
      ],
    })
    expect(summarize(odd).pages).toEqual([{ id: 'p1', name: 'p1', boardCount: 1 }])
  })

  it('survives missing, empty, and malformed shapes', () => {
    expect(summarize(doc({ name: 'No pages' }))).toEqual({ name: 'No pages', pages: [] })
    expect(summarize(doc({ name: 'D', children: [{ id: 'p1', name: 'p1' }] })).pages).toEqual([
      { id: 'p1', name: 'p1', boardCount: 0 },
    ])
    expect(summarize(doc({ name: 'D', children: 'nonsense' })).pages).toEqual([])
  })

  it('substitutes names so the list and filmstrip never show a blank label', () => {
    expect(summarize(doc({ children: [] })).name).toBe('Untitled')
    expect(summarize(doc({ name: '', children: [] })).name).toBe('Untitled')
    const unnamed = summarize(doc({ name: 'D', children: [{ children: [] }, { children: [] }] }))
    expect(unnamed.pages.map((p) => p.name)).toEqual(['Page 1', 'Page 2'])
    expect(unnamed.pages.map((p) => p.id)).toEqual(['page-0', 'page-1'])
  })
})
