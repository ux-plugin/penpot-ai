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

/**
 * A page whose root holds a shell frame containing a slot, plus two top-level
 * view frames the slot references. Built as an indexed objects map directly so
 * the local `slot` fields (`views`/`activeView`, not in the upstream node union)
 * survive without a flatten round-trip.
 */
function slotPage(activeView?: string): IndexedPage {
  const objects: Record<string, unknown> = {
    [ZERO]: { id: ZERO, type: 'frame', name: 'Root', parentId: null, shapes: ['shell', 'home', 'about'] },
    shell: { id: 'shell', type: 'frame', name: 'Shell', parentId: ZERO, shapes: ['outlet'] },
    outlet: { id: 'outlet', type: 'slot', name: 'Outlet', parentId: 'shell', views: ['home', 'about'], activeView },
    home: { id: 'home', type: 'frame', name: 'Home', parentId: ZERO, shapes: ['homeTxt'] },
    homeTxt: { id: 'homeTxt', type: 'text', name: 'HomeText', parentId: 'home', content: 'Home view' },
    about: { id: 'about', type: 'frame', name: 'About', parentId: ZERO, shapes: ['aboutTxt'] },
    aboutTxt: { id: 'aboutTxt', type: 'text', name: 'AboutText', parentId: 'about', content: 'About view' },
  }
  return { id: 'p', name: 'P', objects } as unknown as IndexedPage
}

describe('nodesToPresentation — slot projection', () => {
  it('emits a slot descriptor carrying each candidate view as a projected subtree', () => {
    const root = nodesToPresentation(slotPage('home'))
    const shell = root?.children?.find((c) => c.nodeId === 'shell')
    const slot = shell?.children?.find((c) => c.nodeId === 'outlet')

    expect(slot?.slot).toBeDefined()
    expect(slot?.children).toBeUndefined() // a slot owns no children; views live under .slot
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home', 'about'])
    expect(slot?.slot?.activeView).toBe('home')

    // each candidate is fully walked, text included
    expect(slot?.slot?.views.home?.children?.[0]?.text).toBe('Home view')
    expect(slot?.slot?.views.about?.children?.[0]?.text).toBe('About view')
  })

  it('carries an undefined default when the slot has no active view', () => {
    const root = nodesToPresentation(slotPage())
    const slot = root?.children?.find((c) => c.nodeId === 'shell')?.children?.find((c) => c.nodeId === 'outlet')
    expect(slot?.slot?.activeView).toBeUndefined()
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home', 'about'])
  })

  it('skips a referenced view that is missing from the page', () => {
    const page = slotPage('home')
    delete (page.objects as Record<string, unknown>).about
    const slot = nodesToPresentation(page)
      ?.children?.find((c) => c.nodeId === 'shell')
      ?.children?.find((c) => c.nodeId === 'outlet')
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home'])
  })

  it('guards against a view that re-references the slot (no infinite recursion)', () => {
    const page = slotPage('home')
    // make Home contain the shell again -> outlet would re-project Home forever
    ;(page.objects as Record<string, { shapes?: string[] }>).home.shapes = ['homeTxt', 'shell']
    const slot = nodesToPresentation(page)
      ?.children?.find((c) => c.nodeId === 'shell')
      ?.children?.find((c) => c.nodeId === 'outlet')
    // Home is projected once; the nested outlet inside it re-projects About but
    // not Home (already in-flight), so it terminates.
    expect(slot?.slot?.views.home).toBeDefined()
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home', 'about'])
  })
})
