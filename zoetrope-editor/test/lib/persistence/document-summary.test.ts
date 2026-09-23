import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotDocument, PenpotNode } from 'penpot-exporter/types'
import { importDocument } from '../../../src/lib/doc'
import { boardCount, pageCount, summarizeImported, summarizeLive } from '../../../src/lib/persistence/document-summary'
import { resetWorkspace, seedDocument } from '../fixtures'

const ROOT = '00000000-0000-0000-0000-000000000000'
const shape = (id: string, type: string, children: PenpotNode[] = []): PenpotNode =>
  ({ id, type, name: id, x: 0, y: 0, width: 1, height: 1, children }) as unknown as PenpotNode

const doc = (): PenpotDocument =>
  ({
    name: 'Library',
    components: {},
    children: [
      { id: 'p1', name: 'Home', children: [shape(ROOT, 'frame', [shape('b1', 'frame', [shape('inner', 'frame')]), shape('b2', 'frame'), shape('r', 'rect')])] },
      { id: 'p2', name: '', children: [] },
    ],
  }) as unknown as PenpotDocument

beforeEach(() => resetWorkspace())

describe('document summary', () => {
  it('describes each page by id, name, and its top-level boards', () => {
    const s = summarizeImported(importDocument(doc()))
    expect(s).toEqual({
      name: 'Library',
      pages: [
        { id: 'p1', name: 'Home', boardCount: 2 },
        { id: 'p2', name: 'Page 2', boardCount: 0 },
      ],
    })
    expect([pageCount(s), boardCount(s)]).toEqual([2, 2])
  })

  it('the editor copy summarizes the same way', () => {
    seedDocument(doc())
    expect(summarizeLive()).toEqual(summarizeImported(importDocument(doc())))
  })

  it('never shows a blank name', () => {
    expect(summarizeImported(importDocument({ ...doc(), name: '' } as PenpotDocument)).name).toBe('Untitled')
  })
})
