import { describe, it, expect } from 'vitest'
import type { PenpotPage } from 'penpot-exporter/types'
import { flattenPageToIndexed } from '../../../../src/lib/worker/flatten'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { initRuntime } from '../../../../src/lib/renderer/interactions/preview/runtime'

const ZERO = '00000000-0000-0000-0000-000000000000'

describe('runtime clone — proxy-safe (DataCloneError regression)', () => {
  it('clones a Proxy-wrapped variable initial without throwing', () => {
    // useSnapshot wraps the IR in a tracking Proxy that structuredClone rejects.
    const ir = emptyPageInteractions()
    ir.variables.push({
      id: 'items',
      type: { collection: 'object' },
      scope: 'page',
      initial: new Proxy([{ a: 1 }], {}) as unknown as [],
          })
    const rt = initRuntime(ir)
    expect(rt.store.items).toEqual([{ a: 1 }])
  })
})

describe('nodesToPresentation — shape fill → inline style', () => {
  it('maps a solid fill to background (and text fill to color)', () => {
    const page = {
      id: 'p',
      name: 'P',
      children: [
        { id: ZERO, type: 'frame', name: 'Root' },
        { id: 'btn', type: 'rect', name: 'Add button', fills: [{ fillColor: '#e11d48', fillOpacity: 1 }] },
        { id: 'label', type: 'text', name: 'Label', content: 'Hi', fills: [{ fillColor: '#1d4ed8' }] },
      ],
    } as unknown as PenpotPage

    const root = nodesToPresentation(flattenPageToIndexed(page))
    const kids = root?.children ?? []
    expect(kids.find((k) => k.nodeId === 'btn')?.style).toEqual({ background: '#e11d48' })
    expect(kids.find((k) => k.nodeId === 'label')?.style).toEqual({ color: '#1d4ed8' })
  })

  it('leaves style undefined for an unfilled shape', () => {
    const page = {
      id: 'p',
      children: [
        { id: ZERO, type: 'frame', name: 'Root' },
        { id: 'btn', type: 'rect', name: 'Add button' },
      ],
    } as unknown as PenpotPage
    const root = nodesToPresentation(flattenPageToIndexed(page))
    expect(root?.children?.[0]?.style).toBeUndefined()
  })
})

describe('emit-react — style prop', () => {
  it("the design's value wins over the browser reset beneath it", () => {
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Add', style: { background: '#e11d48' } }
    const code = emitReactComponent(emptyPageInteractions(), root, { componentName: 'Screen' })
    // reset lands first, the design overwrites the same key — one entry, design's
    expect(code).toContain('"background": "#e11d48"')
    expect(code).not.toContain('"background": "none"')
  })

  it('emits a button as a plain box — nothing to neutralize', () => {
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Add' }
    const code = emitReactComponent(emptyPageInteractions(), root, { componentName: 'Screen' })
    expect(code).toContain('<div')
    expect(code).not.toContain('<button')
    // no user-agent styling arrives, so there is no reset to carry
    expect(code).not.toContain('"appearance": "none"')
    expect(code).toContain('"cursor": "pointer"') // affordance the design cannot express
  })

  it('puts back, in code, what the <button> element used to provide', () => {
    const ir = emptyPageInteractions()
    ir.interactions.push({ id: 'i1', on: { node: 'btn', trigger: { type: 'press' } }, do: [] })
    const code = emitReactComponent(ir, { nodeId: 'btn', role: 'button', text: 'Add' }, { componentName: 'Screen' })
    expect(code).toContain('role="button"') // announced
    expect(code).toContain('tabIndex={0}') // reachable
    expect(code).toContain('onKeyDown={onActivate(handle_btn_press, ["Enter"," "])}') // activatable
    expect(code).toContain('const onActivate =') // helper emitted once
  })

  it('does not announce a decorative box as a broken button', () => {
    const code = emitReactComponent(emptyPageInteractions(), { nodeId: 'btn', role: 'button' }, { componentName: 'Screen' })
    expect(code).not.toContain('tabIndex')
    expect(code).not.toContain('onActivate')
  })

  it('gives a plain container only the box-sizing base, no invented look', () => {
    const root: PNode = { nodeId: 'box', role: 'container' }
    const code = emitReactComponent(emptyPageInteractions(), root, { componentName: 'Screen' })
    expect(code).toContain('style={{ "boxSizing": "border-box" }}')
  })
})

describe('emit-react — style-prop bindings (wire fill to state)', () => {
  it('routes a background binding into inline style, overriding the static fill', () => {
    const ir = emptyPageInteractions()
    ir.variables.push({ id: 'accent', type: 'string', scope: 'page', initial: '#e11d48' })
    ir.bindings.push({ node: 'btn', prop: 'background', from: 'accent' })
    const root: PNode = { nodeId: 'btn', role: 'button', text: 'Buy', style: { background: '#999999' } }
    const code = emitReactComponent(ir, root, { componentName: 'Screen' })
    expect(code).toContain('"background": accent') // dynamic expression
    expect(code).not.toContain('"background": "#999999"') // static fill overridden, not duplicated
  })

  it('a non-CSS binding stays a raw element prop', () => {
    const ir = emptyPageInteractions()
    ir.bindings.push({ node: 'inp', prop: 'value', from: 'query' })
    const root: PNode = { nodeId: 'inp', role: 'field' }
    const code = emitReactComponent(ir, root, { componentName: 'Screen' })
    expect(code).toContain('value={query}')
    // it is a prop, not a style entry — the only style present is the reset
    expect(code).not.toContain('"value":')
  })
})
