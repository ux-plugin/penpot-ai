/**
 * Ports — the values a design does NOT own.
 *
 * What the handover carries is the DESIGN, so a design has to be able to say
 * "I don't decide this." A port is that statement, and these tests pin down the
 * three places it has to survive:
 *
 *   - authoring: one namespace with variables and formulas, samples that follow
 *     the direction;
 *   - emission: a typed props interface where the sample and description reach
 *     the reader as doc comments — `object` widens to `any`, so the comment is
 *     the ONLY surviving statement of the expected shape;
 *   - preview: in-ports run on their samples, and an out-port call is recorded
 *     rather than silently dropped, because a click that reports outward would
 *     otherwise look like a click that did nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import {
  emptyPageInteractions,
  editableError,
  type Action,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import {
  addPort,
  removePort,
  setPortDir,
  setPortType,
  setPortSample,
  setPortDescription,
  isNameTaken,
  addVariable,
  addDerived,
  makeScalarVariable,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { emitReactComponent, emitAction, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { validatePageInteractions } from '../../../../src/lib/renderer/interactions/addressing'
import { initRuntime, applyAction, buildEnv, diffRuntime } from '../../../../src/lib/renderer/interactions/preview/runtime'

beforeAll(() => initDefaultCatalog())

const card: PNode = {
  nodeId: 'card',
  role: 'container',
  children: [{ nodeId: 'title', role: 'text', text: 'Sample product' }],
}

describe('authoring — one namespace, samples that follow direction', () => {
  it('seeds an in-port with a sample and leaves an out-port without one', () => {
    const ir = addPort(addPort(emptyPageInteractions(), 'title', 'in', 'string'), 'onAdd', 'out', 'string')
    expect(ir.ports.find((p) => p.id === 'title')?.sample).toBe('')
    expect(ir.ports.find((p) => p.id === 'onAdd')).not.toHaveProperty('sample')
  })

  it('refuses a name already used by a variable, a formula, or another port', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir = addDerived(ir, 'double', 'n * 2')
    ir = addPort(ir, 'title', 'in', 'string')
    for (const taken of ['n', 'double', 'title']) {
      expect(isNameTaken(ir, taken)).toBe(true)
      expect(addPort(ir, taken, 'in', 'string')).toBe(ir)
    }
    // and the guard runs the other way too — a variable can't shadow a port
    expect(addVariable(ir, makeScalarVariable('title', 'string', '')).variables).toHaveLength(1)
  })

  it('drops the sample when a port turns outward and restores one when it comes back', () => {
    let ir = addPort(emptyPageInteractions(), 'x', 'in', 'number')
    ir = setPortSample(ir, 'x', 42)
    ir = setPortDir(ir, 'x', 'out')
    expect(ir.ports[0]).not.toHaveProperty('sample')
    ir = setPortDir(ir, 'x', 'in')
    expect(ir.ports[0].sample).toBe(0)
  })

  it('resets the sample to the new type when retyped, and clears a blank description', () => {
    let ir = setPortSample(addPort(emptyPageInteractions(), 'x', 'in', 'string'), 'x', 'hello')
    ir = setPortType(ir, 'x', 'number')
    expect(ir.ports[0].sample).toBe(0)
    ir = setPortDescription(ir, 'x', '  the quantity  ')
    expect(ir.ports[0].description).toBe('the quantity')
    ir = setPortDescription(ir, 'x', '   ')
    expect(ir.ports[0]).not.toHaveProperty('description')
    expect(removePort(ir, 'x').ports).toEqual([])
  })

  it('refuses to make an in-port editable, and says why', () => {
    const ir = addPort(emptyPageInteractions(), 'customerName', 'in', 'string')
    expect(editableError(ir, 'customerName')).toMatch(/comes from outside/)
  })
})

describe('emission — the props interface is the declaration of what it does not decide', () => {
  function irWithPorts(): PageInteractions {
    const ir = emptyPageInteractions()
    ir.ports.push(
      { id: 'product', dir: 'in', type: 'object', sample: { title: 'Sample product' }, description: 'the product shown here' },
      { id: 'onAddToCart', dir: 'out', type: 'string' },
    )
    ir.bindings.push({ node: 'title', prop: 'text', from: 'product.title' })
    return ir
  }

  it('emits in-ports as values and out-ports as callbacks, destructured', () => {
    const src = emitReactComponent(irWithPorts(), card, { componentName: 'Card' })
    expect(src).toContain('interface CardProps {')
    expect(src).toContain('  product: any')
    expect(src).toContain('  onAddToCart: (value: string) => void')
    expect(src).toContain('export function Card({ product, onAddToCart }: CardProps) {')
  })

  it('carries the description and the sample into the doc comment', () => {
    const src = emitReactComponent(irWithPorts(), card, { componentName: 'Card' })
    // `object` widens to `any`, so this comment is the only surviving statement
    // of the shape — the thing that stops a downstream reader from guessing.
    expect(src).toContain('/** the product shown here — e.g. {"title":"Sample product"} */')
  })

  it('a bound port reads as a bare identifier, not props.x', () => {
    const src = emitReactComponent(irWithPorts(), card, { componentName: 'Card' })
    expect(src).toContain('{product.title}')
    expect(src).not.toContain('props.product')
  })

  it('emits no interface and no parameter when the design declares no ports', () => {
    const src = emitReactComponent(emptyPageInteractions(), card, { componentName: 'Card' })
    expect(src).not.toContain('interface')
    expect(src).toContain('export function Card() {')
  })

  it('emits a variable as state regardless — a variable is always design-owned', () => {
    const ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    expect(emitReactComponent(ir, card, { componentName: 'Card' })).toContain('useState<number>(0)')
  })
})

describe('port.call — the one effect that leaves the design', () => {
  const action: Action = { type: 'port.call', target: 'onAddToCart', value: 'product.title' }

  it('emits a plain call on the destructured callback', () => {
    expect(emitAction(action)).toBe('onAddToCart(product.title)')
  })

  it('is recorded by the preview rather than dropped, and reported as a change', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'onAddToCart', dir: 'out', type: 'string' })
    const before = initRuntime(ir)
    const after = applyAction(action, { product: { title: 'Sample product' } }, before)
    expect(after.emitted).toEqual([{ port: 'onAddToCart', value: 'Sample product' }])
    expect(diffRuntime(before, after)).toEqual([
      { kind: 'port-call', id: 'onAddToCart', before: undefined, after: 'Sample product' },
    ])
  })

  it('reports a repeated identical call — append-only, so the tail is the news', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'onPing', dir: 'out', type: 'string' })
    const ping: Action = { type: 'port.call', target: 'onPing', value: '"x"' }
    const once = applyAction(ping, {}, initRuntime(ir))
    const twice = applyAction(ping, {}, once)
    // a record-diff would see no difference here; the tail slice does
    expect(diffRuntime(once, twice)).toHaveLength(1)
  })

  it('terminates at the port node in the normalized graph', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'onAdd', dir: 'out', type: 'string' })
    ir.interactions.push({ on: { node: 'btn', trigger: { type: 'press' } }, do: [{ type: 'port.call', target: 'onAdd', value: '"x"' }] })
    const g = normalize(ir)
    expect(g.edges.some((e) => e.to === 'port:onAdd')).toBe(true)
  })
})

describe('preview — in-ports run on their samples', () => {
  it('seeds the store from the sample, so the design shows something real', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'productTitle', dir: 'in', type: 'string', sample: 'Sample product' })
    expect(buildEnv(ir, initRuntime(ir)).productTitle).toBe('Sample product')
  })

  it('leaves a sample-less in-port undefined rather than inventing a value', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'productTitle', dir: 'in', type: 'string' })
    expect(initRuntime(ir).store.productTitle).toBeUndefined()
  })

  it('does not seed out-ports — nothing arrives through them', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'onAdd', dir: 'out', type: 'string' })
    expect(Object.keys(initRuntime(ir).store)).toEqual([])
  })
})

describe('addressing — ownership decides what an action may do', () => {
  const nodes = new Set(['btn', 'row'])

  it('accepts a port.call on an out-port', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'onAdd', dir: 'out', type: 'string' })
    ir.interactions.push({ on: { node: 'btn', trigger: { type: 'press' } }, do: [{ type: 'port.call', target: 'onAdd', value: '"x"' }] })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('rejects a port.call aimed at an in-port or a variable', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'title', dir: 'in', type: 'string', sample: '' })
    ir.variables.push({ id: 'n', type: 'number', scope: 'page', initial: 0 })
    ir.interactions.push({
      on: { node: 'btn', trigger: { type: 'press' } },
      do: [
        { type: 'port.call', target: 'title', value: '"x"' },
        { type: 'port.call', target: 'n', value: '"x"' },
      ],
    })
    expect(validatePageInteractions(ir, nodes)).toHaveLength(2)
    expect(validatePageInteractions(ir, nodes)[0].message).toMatch(/outgoing port/)
  })

  it('repeats over a list that arrives from outside — reading needs no ownership', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'rows', dir: 'in', type: { collection: 'object' }, sample: [] })
    ir.repeaters.push({ node: 'row', over: 'rows' })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('still refuses to MUTATE a list it does not own', () => {
    const ir = emptyPageInteractions()
    ir.ports.push({ id: 'rows', dir: 'in', type: { collection: 'object' }, sample: [] })
    ir.interactions.push({
      on: { node: 'btn', trigger: { type: 'press' } },
      do: [{ type: 'collection.append', target: 'rows', value: '1' }],
    })
    expect(validatePageInteractions(ir, nodes)[0].message).toMatch(/collection variable/)
  })

  it('accepts an increment with no amount — blank means +1 in both the runtime and the emitter', () => {
    const ir = emptyPageInteractions()
    ir.variables.push({ id: 'n', type: 'number', scope: 'page', initial: 0 })
    ir.interactions.push({ on: { node: 'btn', trigger: { type: 'press' } }, do: [{ type: 'increment', target: 'n' }] })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })
})
