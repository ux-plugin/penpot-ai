import { describe, it, expect } from 'vitest'
import type { PenpotPage } from 'penpot-exporter/types'
import { flattenPageToIndexed, unflattenIndexedPageToPage } from '../../../../src/lib/worker/flatten'
import { emptyPageInteractions, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'

const ZERO = '00000000-0000-0000-0000-000000000000'

/** A page: nil-UUID root frame + two top-level siblings (a button and a list w/ a row). */
function makePage(interactions?: PageInteractions): PenpotPage {
  return {
    id: 'page-1',
    name: 'Page 1',
    background: '#ffffff',
    children: [
      { id: ZERO, type: 'frame', name: 'Root' },
      { id: 'addBtn', type: 'rect', name: 'Add button' },
      {
        id: 'list',
        type: 'frame',
        name: 'Todo list',
        children: [{ id: 'row', type: 'text', name: 'Row', content: 'Item' }],
      },
    ],
    interactions,
  } as unknown as PenpotPage
}

describe('serialization — interactions survive flatten/unflatten', () => {
  it('carries PageInteractions through the round-trip', () => {
    const ir = emptyPageInteractions()
    ir.variables.push({ id: 'items', type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' })

    const indexed = flattenPageToIndexed(makePage(ir))
    expect(indexed.interactions?.variables.map((v) => v.id)).toEqual(['items'])

    const page = unflattenIndexedPageToPage(indexed) as PenpotPage & { interactions?: PageInteractions }
    expect(page.interactions?.variables[0]?.id).toBe('items')
  })

  it('leaves interactions undefined when the page has none', () => {
    const indexed = flattenPageToIndexed(makePage())
    expect(indexed.interactions).toBeUndefined()
  })
})

describe('nodesToPresentation — shapes -> PNode tree with anchors', () => {
  it('maps the shape hierarchy to tags + anchors + text', () => {
    const indexed = flattenPageToIndexed(makePage())
    const root = nodesToPresentation(indexed)

    expect(root?.nodeId).toBe(ZERO)
    expect(root?.tag).toBe('div')

    const kids = root?.children ?? []
    const addBtn = kids.find((k) => k.nodeId === 'addBtn')
    const list = kids.find((k) => k.nodeId === 'list')
    expect(addBtn?.tag).toBe('button') // name "Add button" -> button heuristic
    expect(list?.tag).toBe('ul') // name "Todo list" -> list heuristic

    const row = list?.children?.[0]
    expect(row?.nodeId).toBe('row')
    expect(row?.tag).toBe('li') // name "Row" -> li heuristic
    expect(row?.text).toBe('Item') // text content extracted
  })

  it('returns null for an empty page', () => {
    expect(nodesToPresentation({ id: 'p', objects: {} })).toBeNull()
  })
})
