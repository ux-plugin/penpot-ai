import { beforeEach, describe, it, expect } from 'vitest'
import type { PenpotDocument, PenpotPage } from 'penpot-exporter/types'
import { EMPTY_BEHAVIOUR } from '../../../../src/lib/renderer/interactions/ir'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { initRuntime } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { resetWorkspace, seedDocument } from '../../fixtures'
import { beh, cell, pageCell } from './behaviour-fixtures'

function docOf(page: PenpotPage): PenpotDocument {
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

beforeEach(resetWorkspace)

describe('runtime clone — proxy-safe (DataCloneError regression)', () => {
  it('clones a Proxy-wrapped cell initial without throwing', () => {
    const rt = initRuntime({
      ...EMPTY_BEHAVIOUR,
      cells: [cell('items', { collection: 'object' }, new Proxy([{ a: 1 }], {}) as unknown as [])],
    })
    expect(rt.store.items).toEqual([{ a: 1 }])
  })
})

describe('nodesToPresentation — shape fill → inline style', () => {
  it('maps a solid fill to background (and text fill to color)', () => {
    const page = {
      id: 'p',
      name: 'P',
      children: [
        { id: 'btn', type: 'rect', name: 'Add button', fills: [{ fillColor: '#e11d48', fillOpacity: 1 }] },
        { id: 'label', type: 'text', name: 'Label', content: 'Hi', fills: [{ fillColor: '#1d4ed8' }] },
      ],
    } as unknown as PenpotPage

    seedDocument(docOf(page))
    const root = nodesToPresentation('p')
    const kids = root?.children ?? []
    expect(kids.find((k) => k.nodeId === 'btn')?.style).toEqual({ background: '#e11d48' })
    expect(kids.find((k) => k.nodeId === 'label')?.style).toEqual({ color: '#1d4ed8' })
  })

  it('leaves style undefined for an unfilled shape', () => {
    const page = {
      id: 'p',
      children: [{ id: 'btn', type: 'rect', name: 'Add button' }],
    } as unknown as PenpotPage
    seedDocument(docOf(page))
    const root = nodesToPresentation('p')
    expect(root?.children?.[0]?.style).toBeUndefined()
  })
})

describe('emit-react — style prop', () => {
  it("the design's value wins over the browser reset beneath it", () => {
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Add', style: { background: '#e11d48' } }
    const code = emitReactComponent(EMPTY_BEHAVIOUR, root, { componentName: 'Screen' })
    // reset lands first, the design overwrites the same key — one entry, design's
    expect(code).toContain('"background": "#e11d48"')
    expect(code).not.toContain('"background": "none"')
  })

  it('emits a button as a plain box — no affordance added on top', () => {
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Add' }
    const code = emitReactComponent(EMPTY_BEHAVIOUR, root, { componentName: 'Screen' })
    expect(code).toContain('<div')
    expect(code).not.toContain('<button')
    // no user-agent styling arrives, so there is no reset to carry
    expect(code).not.toContain('"appearance": "none"')
    // and nothing the designer didn't author: no cursor, no role, no tab stop
    expect(code).not.toContain('cursor')
    expect(code).not.toContain('role=')
    expect(code).not.toContain('tabIndex')
  })

  it('emits ONLY the authored click on a button — no keyboard or ARIA assumed', () => {
    const ir = beh({ rules: [{ id: 'i1', node: 'btn', on: { type: 'press' }, do: [] }] })
    const code = emitReactComponent(ir, { nodeId: 'btn', role: 'button', text: 'Add' }, { componentName: 'Screen' })
    expect(code).toContain('onClick={handle_btn_press}') // what the designer authored
    expect(code).not.toContain('role=') // and nothing else on top
    expect(code).not.toContain('tabIndex')
    expect(code).not.toContain('onKeyDown')
    expect(code).not.toContain('onActivate')
  })

  it('gives a plain container only the box-sizing base, no invented look', () => {
    const root: PNode = { nodeId: 'box', role: 'container' }
    const code = emitReactComponent(EMPTY_BEHAVIOUR, root, { componentName: 'Screen' })
    expect(code).toContain('style={{ "boxSizing": "border-box" }}')
  })
})

describe('emit-react — style-prop references (wire fill to state)', () => {
  it('routes a background reference into inline style, overriding the static fill', () => {
    const ir = beh({ cells: [pageCell('accent', 'string', '#e11d48')], bindings: [{ node: 'btn', prop: 'background', expr: 'accent' }] })
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Buy', style: { background: '#999999' } }
    const code = emitReactComponent(ir, root, { componentName: 'Screen' })
    expect(code).toContain('"background": accent') // dynamic expression
    expect(code).not.toContain('"background": "#999999"') // static fill overridden, not duplicated
  })

  it('a non-CSS reference stays a raw element prop', () => {
    // `query` is not a cell on this page: an unresolved name still emits as the identifier it names.
    const ir = beh({ bindings: [{ node: 'inp', prop: 'value', expr: 'query' }] })
    const root: PNode = { nodeId: 'inp', role: 'field' }
    const code = emitReactComponent(ir, root, { componentName: 'Screen' })
    expect(code).toContain('value={query}')
    // it is a prop, not a style entry — the only style present is the reset
    expect(code).not.toContain('"value":')
  })
})
