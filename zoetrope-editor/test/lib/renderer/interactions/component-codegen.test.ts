import { describe, expect, it } from 'vitest'
import type { PenpotPage } from 'penpot-exporter/types'
import { flattenPageToIndexed } from '../../../../src/lib/worker/flatten'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { emitReactComponent } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import type { LocalComponent } from '../../../../src/lib/common/component'

const ZERO = '00000000-0000-0000-0000-000000000000'
const COMPONENT_ID = 'component-1'

/**
 * A Button main (label + icon) and one copy of it, wired the way
 * `instantiateComponent` wires a copy: fresh ids, `shapeRef` per node.
 */
function page(): PenpotPage {
  return {
    id: 'p',
    name: 'P',
    children: [
      { id: ZERO, type: 'frame', name: 'Root' },
      {
        id: 'main',
        type: 'frame',
        name: 'Button',
        componentId: COMPONENT_ID,
        componentRoot: true,
        mainInstance: true,
        children: [
          { id: 'main-label', type: 'text', name: 'Label', content: 'Click me' },
          { id: 'main-icon', type: 'rect', name: 'Icon' },
        ],
      },
      {
        id: 'copy',
        type: 'frame',
        name: 'Button',
        componentId: COMPONENT_ID,
        componentRoot: true,
        shapeRef: 'main',
        propValues: { 'prop-label': 'Save' },
        children: [
          { id: 'copy-label', type: 'text', name: 'Label', content: 'Click me', shapeRef: 'main-label' },
          { id: 'copy-icon', type: 'rect', name: 'Icon', shapeRef: 'main-icon' },
        ],
      },
    ],
  } as unknown as PenpotPage
}

const component: LocalComponent = {
  id: COMPONENT_ID,
  name: 'Button',
  path: '',
  mainInstanceId: 'main',
  mainInstancePage: 'p',
  props: [
    {
      id: 'prop-label',
      name: 'label',
      type: 'text',
      defaultValue: 'Click me',
      targets: [{ nodeId: 'main-label', attr: 'content' }],
    },
    {
      id: 'prop-showIcon',
      name: 'showIcon',
      type: 'boolean',
      defaultValue: true,
      targets: [{ nodeId: 'main-icon', attr: 'hidden' }],
    },
  ],
}

const library = { [COMPONENT_ID]: component }

function emit(): string {
  const root = nodesToPresentation(flattenPageToIndexed(page()), library)!
  return emitReactComponent(emptyPageInteractions(), root, { componentName: 'Page' })
}

describe('component codegen', () => {
  it('emits a component function with its declared props as parameters', () => {
    expect(emit()).toContain('function Button({ label, showIcon })')
  })

  it('emits the copy as a call carrying its resolved prop values', () => {
    const source = emit()
    expect(source).toContain('<Button ')
    expect(source).toContain('label={"Save"}')
    // Never set on this copy, so the declared default is emitted.
    expect(source).toContain('showIcon={true}')
  })

  it('does not inline the copy subtree at the call site', () => {
    const source = emit()
    const callIndex = source.indexOf('<Button ')
    expect(callIndex).toBeGreaterThan(-1)
    // The copy's own children never appear as elements.
    expect(source).not.toContain('data-node-id="copy-label"')
    expect(source).not.toContain('data-node-id="copy-icon"')
  })

  it('reads prop-driven nodes from the prop inside the definition', () => {
    const source = emit()
    // The text prop's target reads {label}, not the main's literal string.
    expect(source).toMatch(/data-node-id="main-label"[^>]*>\{label\}</)
    // The boolean prop's target renders behind its condition.
    expect(source).toContain('{showIcon && (')
  })

  it('emits the main as a call too, so the page holds no literal duplicate', () => {
    const source = emit()
    // The main's own body appears once, inside the definition — not again in the
    // page as a literal <button>Click me</button>.
    expect(source.match(/data-node-id="main-label"/g)).toHaveLength(1)
    expect(source).toContain('label={"Click me"}')
  })

  it('emits one definition however many copies there are', () => {
    const twoCopies = page()
    const extra = JSON.parse(JSON.stringify((twoCopies.children as unknown[])[2])) as Record<
      string,
      unknown
    >
    extra.id = 'copy2'
    extra.propValues = { 'prop-label': 'Cancel' }
    ;(extra.children as Array<Record<string, unknown>>)[0].id = 'copy2-label'
    ;(extra.children as Array<Record<string, unknown>>)[1].id = 'copy2-icon'
    ;(twoCopies.children as unknown[]).push(extra)

    const root = nodesToPresentation(flattenPageToIndexed(twoCopies), library)!
    const source = emitReactComponent(emptyPageInteractions(), root)

    expect(source.match(/function Button\(/g)).toHaveLength(1)
    // Three call sites: the main plus both copies.
    expect(source.match(/<Button /g)).toHaveLength(3)
    expect(source).toContain('label={"Cancel"}')
  })

  it('falls back to inlining when the library is not supplied', () => {
    const root = nodesToPresentation(flattenPageToIndexed(page()))!
    const source = emitReactComponent(emptyPageInteractions(), root)

    expect(source).not.toContain('function Button(')
    expect(source).toContain('data-node-id="copy-label"')
  })
})
