/**
 * The document side of behaviour: its records travel through import/export
 * beside the pages, and `nodesToPresentation` turns a page's shapes into the
 * engine's presentation tree, with roles derived from the behaviour on them.
 */
import { beforeEach, describe, it, expect } from 'vitest'
import type { PenpotDocument, PenpotNode, PenpotPage } from 'penpot-exporter/types'
import type { Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import type { PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { nodesToPresentation, findPNode } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { currentBehaviour } from '../../../../src/lib/renderer/interactions/document/behaviour'
import { exportDocument, ROOT, type DocumentRecords } from '../../../../src/lib/doc'
import { resetWorkspace, seedDocument } from '../../fixtures'
import { beh, listCell, PAGE, pageCell } from './behaviour-fixtures'

function docOf(pages: PenpotPage[], b?: Behaviour): PenpotDocument {
  const records: DocumentRecords = b ? { cell: [...b.cells], binding: [...b.bindings], rule: [...b.rules] } : {}
  return {
    name: 'Test',
    children: pages,
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
    records,
  } as PenpotDocument
}

/** A page: two top-level siblings (a button and a list w/ a row). */
function makePage(): PenpotPage {
  return {
    id: PAGE,
    name: 'Page 1',
    background: '#ffffff',
    children: [
      { id: 'addBtn', type: 'rect', name: 'Add button' },
      {
        id: 'list',
        type: 'frame',
        name: 'Todo list',
        children: [{ id: 'row', type: 'text', name: 'Row', content: 'Item' }],
      },
    ],
  } as unknown as PenpotPage
}

beforeEach(resetWorkspace)

describe('serialization — behaviour records survive import/export', () => {
  it('carries cells, bindings and rules through the round-trip', () => {
    const b = beh({
      cells: [listCell('items')],
      bindings: [{ node: 'row', prop: 'repeat', expr: 'items' }],
      rules: [{ id: 'r1', node: 'addBtn', on: { type: 'press' }, do: [] }],
    })

    seedDocument(docOf([makePage()], b))
    expect(currentBehaviour(PAGE)).toEqual(b)

    const out = (exportDocument() as PenpotDocument & { records?: DocumentRecords }).records
    expect(out?.cell?.map((c) => c.name)).toEqual(['items'])
    expect(out?.binding?.map((x) => `${x.node}.${x.prop}`)).toEqual(['row.repeat'])
    expect(out?.rule?.map((r) => r.id)).toEqual(['r1'])
  })

  it('exports no records when the document has no behaviour', () => {
    seedDocument(docOf([makePage()]))
    expect(currentBehaviour(PAGE)).toEqual({ cells: [], bindings: [], rules: [] })
    expect((exportDocument() as PenpotDocument & { records?: DocumentRecords }).records).toEqual({})
  })
})

describe('nodesToPresentation — shapes -> PNode tree with anchors', () => {
  it('maps the shape hierarchy to anchors + text', () => {
    seedDocument(docOf([makePage()]))
    const root = nodesToPresentation(PAGE)

    expect(root?.nodeId).toBe(ROOT)

    const list = (root?.children ?? []).find((k) => k.nodeId === 'list')
    const row = list?.children?.[0]
    expect(row?.nodeId).toBe('row')
    expect(row?.text).toBe('Item')
  })

  it('gives a shape with no behaviour a plain role, whatever it is CALLED', () => {
    seedDocument(docOf([makePage()]))
    const root = nodesToPresentation(PAGE)
    const kids = root?.children ?? []
    expect(root?.role).toBe('container')
    expect(kids.find((k) => k.nodeId === 'addBtn')?.role).toBe('container')
    expect(kids.find((k) => k.nodeId === 'list')?.role).toBe('container')
    expect(kids.find((k) => k.nodeId === 'list')?.children?.[0]?.role).toBe('text')
  })

  it('derives roles from the behaviour authored on each node', () => {
    const b = beh({
      cells: [pageCell('draft', 'string', ''), listCell('items')],
      bindings: [
        { node: 'addBtn', prop: 'value', expr: 'draft' },
        { node: 'row', prop: 'repeat', expr: 'items' },
      ],
    })

    seedDocument(docOf([makePage()], b))
    const root = nodesToPresentation(PAGE)
    const kids = root?.children ?? []
    expect(kids.find((k) => k.nodeId === 'addBtn')?.role).toBe('field')
    expect(kids.find((k) => k.nodeId === 'list')?.role).toBe('list')
    expect(kids.find((k) => k.nodeId === 'list')?.children?.[0]?.role).toBe('item')
  })

  it('a press makes a node a button; open-url makes it a link', () => {
    const press = beh({ rules: [{ id: 'i1', node: 'addBtn', on: { type: 'press' }, do: [] }] })
    seedDocument(docOf([makePage()], press))
    expect(nodesToPresentation(PAGE)?.children?.find((k) => k.nodeId === 'addBtn')?.role).toBe('button')

    const link = beh({
      rules: [{ id: 'i1', node: 'addBtn', on: { type: 'press' }, do: [{ type: 'open-url', value: '"https://example.com"' }] }],
    })
    seedDocument(docOf([makePage()], link))
    expect(nodesToPresentation(PAGE)?.children?.find((k) => k.nodeId === 'addBtn')?.role).toBe('link')
  })

  it('returns null for a page that does not exist', () => {
    seedDocument(docOf([makePage()]))
    expect(nodesToPresentation('nope')).toBeNull()
  })
})

/**
 * A page whose root holds a shell frame containing a slot, plus two top-level
 * view frames the slot references. The local `slot` fields (`views`/`activeView`,
 * not in the upstream node union) ride through import untouched.
 */
function slotPage(activeView?: string, opts: { withAbout?: boolean; shellInsideHome?: boolean } = {}): PenpotPage {
  const withAbout = opts.withAbout ?? true
  const shell = { id: 'shell', type: 'frame', name: 'Shell', children: [
    { id: 'outlet', type: 'slot', name: 'Outlet', views: ['home', 'about'], activeView },
  ] }
  const home = { id: 'home', type: 'frame', name: 'Home', children: [
    { id: 'homeTxt', type: 'text', name: 'HomeText', content: 'Home view' },
    ...(opts.shellInsideHome ? [shell] : []),
  ] }
  const about = { id: 'about', type: 'frame', name: 'About', children: [
    { id: 'aboutTxt', type: 'text', name: 'AboutText', content: 'About view' },
  ] }
  const children: unknown[] = [...(opts.shellInsideHome ? [] : [shell]), home, ...(withAbout ? [about] : [])]
  return { id: 'p', name: 'P', children: children as PenpotNode[] } as unknown as PenpotPage
}

describe('nodesToPresentation — slot projection', () => {
  it('emits a slot descriptor carrying each candidate view as a projected subtree', () => {
    seedDocument(docOf([slotPage('home')]))
    const root = nodesToPresentation('p')
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
    seedDocument(docOf([slotPage()]))
    const root = nodesToPresentation('p')
    const slot = root?.children?.find((c) => c.nodeId === 'shell')?.children?.find((c) => c.nodeId === 'outlet')
    expect(slot?.slot?.activeView).toBeUndefined()
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home', 'about'])
  })

  it('skips a referenced view that is missing from the page', () => {
    seedDocument(docOf([slotPage('home', { withAbout: false })]))
    const slot = nodesToPresentation('p')
      ?.children?.find((c) => c.nodeId === 'shell')
      ?.children?.find((c) => c.nodeId === 'outlet')
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home'])
  })

  it('guards against a view that re-references the slot (no infinite recursion)', () => {
    // Home contains the shell -> outlet would re-project Home forever
    seedDocument(docOf([slotPage('home', { shellInsideHome: true })]))
    const slot = findPNode(nodesToPresentation('p')!, 'outlet')
    // Home is projected once; the nested outlet inside it re-projects About but
    // not Home (already in-flight), so it terminates.
    expect(slot?.slot?.views.home).toBeDefined()
    expect(Object.keys(slot?.slot?.views ?? {})).toEqual(['home', 'about'])
  })
})

/** A page whose shapes carry real design properties, not just names. */
function makeStyledPage(): PenpotPage {
  return {
    id: PAGE,
    name: 'Page 1',
    background: '#ffffff',
    children: [
      {
        id: 'card',
        type: 'frame',
        name: 'Card',
        selrect: { x: 10, y: 20, width: 320, height: 180 },
        fills: [{ fillColor: '#ffffff', fillOpacity: 1 }],
        strokes: [{ strokeColor: '#e5e7eb', strokeWidth: 1, strokeStyle: 'solid' }],
        r1: 12,
        r2: 12,
        r3: 12,
        r4: 12,
        children: [
          {
            id: 'title',
            type: 'text',
            name: 'Title',
            selrect: { x: 20, y: 30, width: 200, height: 24 },
            fills: [{ fillColor: '#111827' }],
            content: { children: [{ fontSize: 18, fontWeight: 600, textAlign: 'left', children: [{ text: 'Hello' }] }] },
          },
        ],
      },
      {
        id: 'ghost',
        type: 'rect',
        name: 'Hidden box',
        hidden: true,
        selrect: { x: 0, y: 0, width: 50, height: 50 },
      },
      {
        id: 'faded',
        type: 'rect',
        name: 'Faded',
        opacity: 0.5,
        selrect: { x: 0, y: 0, width: 40, height: 40 },
        fills: [{ fillColor: '#3B82F6', fillOpacity: 0.5 }],
      },
    ],
  } as unknown as PenpotPage
}

describe('nodesToPresentation — design properties become inline CSS', () => {
  const build = () => {
    seedDocument(docOf([makeStyledPage()]))
    return nodesToPresentation(PAGE)
  }
  const find = (id: string) => {
    const root = build()
    return root ? findPNode(root, id) : null
  }

  it('carries size from the selrect so a shape is not a zero-height div', () => {
    expect(find('card')?.style).toMatchObject({ width: '320px', minHeight: '180px' })
  })

  it('exempts the page root from sizing — it adapts to its container', () => {
    const root = build()
    expect(root?.style?.width).toBeUndefined()
    expect(root?.style?.minHeight).toBeUndefined()
  })

  it('carries fill, border and radius', () => {
    expect(find('card')?.style).toMatchObject({
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: '12px',
    })
  })

  it('makes containers stack their children as a column', () => {
    expect(find('card')?.style).toMatchObject({ display: 'flex', flexDirection: 'column', gap: '8px' })
    expect(find('title')?.style?.display).toBeUndefined() // leaf, not a container
  })

  it('maps a text fill to color plus typography, not background', () => {
    const title = find('title')?.style
    expect(title).toMatchObject({ color: '#111827', fontSize: '18px', fontWeight: '600', textAlign: 'left' })
    expect(title?.background).toBeUndefined()
  })

  it('folds fill opacity into the colour and carries shape opacity', () => {
    expect(find('faded')?.style).toMatchObject({ background: '#3B82F680', opacity: '0.5' })
  })

  it('hides a hidden shape but keeps its anchor element', () => {
    expect(find('ghost')?.style?.display).toBe('none')
    expect(find('ghost')?.nodeId).toBe('ghost') // still present: one node, one anchor
  })
})

describe('findPNode — the scoping primitive for "show only the selection"', () => {
  const tree = () => {
    seedDocument(docOf([makeStyledPage()]))
    return nodesToPresentation(PAGE)!
  }

  it('finds a nested node and returns its whole subtree', () => {
    const card = findPNode(tree(), 'card')
    expect(card?.nodeId).toBe('card')
    expect(card?.children?.map((c) => c.nodeId)).toEqual(['title'])
  })

  it('finds the root itself', () => {
    expect(findPNode(tree(), ROOT)?.nodeId).toBe(ROOT)
  })

  it('returns null for an id that is not in the tree', () => {
    expect(findPNode(tree(), 'nope')).toBeNull()
  })

  it('searches inside a slot’s candidate views, not just children', () => {
    const root: PNode = {
      nodeId: 'root',
      role: 'container',
      slot: { activeView: 'viewA', views: { viewA: { nodeId: 'viewA', role: 'container', children: [{ nodeId: 'deep', role: 'text' }] } } },
    }
    expect(findPNode(root, 'deep')?.nodeId).toBe('deep')
  })
})
