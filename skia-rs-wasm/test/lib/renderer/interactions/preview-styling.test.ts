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
      source: 'local',
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
  it('emits an inline style when the PNode has one', () => {
    const root: PNode = { nodeId: 'btn', tag: 'button', text: 'Add', style: { background: '#e11d48' } }
    const code = emitReactComponent(emptyPageInteractions(), root, { componentName: 'Screen' })
    expect(code).toContain('style={{ "background": "#e11d48" }}')
  })

  it('omits style when there is none', () => {
    const root: PNode = { nodeId: 'btn', tag: 'button', text: 'Add' }
    const code = emitReactComponent(emptyPageInteractions(), root, { componentName: 'Screen' })
    expect(code).not.toContain('style=')
  })
})
