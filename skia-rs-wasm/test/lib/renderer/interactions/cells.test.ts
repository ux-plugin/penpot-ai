/**
 * Cells — the one kind of addressable state, and the plumbing derived from them.
 *
 * The design rule these tests exist to hold: a designer authors ONE kind of thing
 * and only ever wires it (this trigger changes that cell, this text reads that
 * cell). Everything about how a value reaches the real app — props, callbacks,
 * whether a write leaves at all — is derived at lowering and never named by them.
 *
 * So the assertions come in two halves. The authoring half checks that marking a
 * cell "from outside" changes nothing about its identity or its wiring. The
 * derivation half checks that the SAME authored interaction lowers two different
 * ways depending only on that mark — which is what makes an outward event exist
 * without anyone declaring one.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog, listActions } from '../../../../src/lib/renderer/interactions/catalog'
import {
  emptyPageInteractions,
  editableError,
  type Action,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import {
  addVariable,
  removeVariable,
  addDerived,
  makeScalarVariable,
  makeCollectionVariable,
  setVariableOutside,
  setVariableDescription,
  setVariableScope,
  setVariableType,
  isNameTaken,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { emitReactComponent, emitAction, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { validatePageInteractions } from '../../../../src/lib/renderer/interactions/addressing'
import {
  initRuntime,
  applyAction,
  buildEnv,
  diffRuntime,
  leavesDesign,
} from '../../../../src/lib/renderer/interactions/preview/runtime'

beforeAll(() => initDefaultCatalog())

const card: PNode = {
  nodeId: 'card',
  role: 'container',
  children: [{ nodeId: 'title', role: 'text', text: 'Sample product' }],
}

/** A cell the app supplies, holding `value` as the sample the preview runs on. */
function outsideCell(ir: PageInteractions, id: string, value: string | number, description?: string): PageInteractions {
  let next = addVariable(ir, makeScalarVariable(id, typeof value === 'number' ? 'number' : 'string', value))
  next = setVariableOutside(next, id, true)
  return description ? setVariableDescription(next, id, description) : next
}

describe('authoring — marking a cell "from outside" changes nothing else about it', () => {
  it('keeps the id, type, value and scope; only adds the mark', () => {
    const before = addVariable(emptyPageInteractions(), makeScalarVariable('productTitle', 'string', 'Sample product'))
    const after = setVariableOutside(before, 'productTitle', true)
    expect(after.variables[0]).toMatchObject({ id: 'productTitle', type: 'string', scope: 'page', initial: 'Sample product' })
    expect(after.variables[0].outside).toEqual({})
    // and unticking it is a clean round trip — nothing was consumed on the way
    expect(setVariableOutside(after, 'productTitle', false).variables[0]).toEqual(before.variables[0])
  })

  it('preserves the value as the sample — a design with a placeholder already has one', () => {
    expect(outsideCell(emptyPageInteractions(), 'productTitle', 'Sample product').variables[0].initial).toBe('Sample product')
  })

  it('takes a description only on an outside cell — a design-owned value owes no one an explanation', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir = setVariableDescription(ir, 'n', 'ignored')
    expect(ir.variables[0]).not.toHaveProperty('outside')

    ir = setVariableOutside(ir, 'n', true)
    ir = setVariableDescription(ir, 'n', '  the quantity  ')
    expect(ir.variables[0].outside).toEqual({ description: 'the quantity' })
    ir = setVariableDescription(ir, 'n', '   ')
    expect(ir.variables[0].outside).toEqual({})
  })

  it('lets the designer put a cell anywhere, including a component flag document-wide', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('menuOpen', 'boolean', false))
    ir = setVariableScope(ir, 'menuOpen', 'global')
    // No second-guessing: this is a legitimate thing to want, not a mistake.
    expect(ir.variables[0].scope).toBe('global')
    expect(validatePageInteractions(ir, new Set())).toEqual([])
  })

  it('shares one namespace with formulas', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir = addDerived(ir, 'double', 'n * 2')
    expect(isNameTaken(ir, 'n')).toBe(true)
    expect(isNameTaken(ir, 'double')).toBe(true)
    expect(addVariable(ir, makeScalarVariable('double', 'string', '')).variables).toHaveLength(1)
    expect(removeVariable(ir, 'n').variables).toEqual([])
  })

  it('retypes like any other cell', () => {
    let ir = outsideCell(emptyPageInteractions(), 'x', 'hello')
    ir = setVariableType(ir, 'x', 'number')
    expect(ir.variables[0]).toMatchObject({ type: 'number', initial: 0 })
    expect(ir.variables[0].outside).toBeDefined()
  })

  it('refuses only formulas as edit targets — an outside cell is editable', () => {
    let ir = outsideCell(emptyPageInteractions(), 'query', '')
    ir = addDerived(ir, 'double', 'query')
    expect(editableError(ir, 'query')).toBeNull()
    expect(editableError(ir, 'double')).toMatch(/formula/)
    expect(editableError(ir, 'nope')).toMatch(/not a value/)
    expect(editableError(ir, '  ')).toMatch(/Pick a value/)
  })

  it('has no "send out" action to author — reporting outward is not an authoring act', () => {
    expect(listActions().map((a) => a.key)).not.toContain('port.call')
  })
})

describe('derivation — one authored write, two lowerings', () => {
  /** "When the card is clicked, add to `items`." Authored once, reused below. */
  function clickAppends(outside: boolean): PageInteractions {
    let ir = addVariable(emptyPageInteractions(), makeCollectionVariable('items'))
    if (outside) ir = setVariableOutside(ir, 'items', true)
    ir.interactions.push({
      on: { node: 'card', trigger: { type: 'press' } },
      do: [{ type: 'collection.append', target: 'items', value: '1' }],
    })
    return ir
  }

  it('a design-owned cell becomes state, and the write becomes setState', () => {
    const src = emitReactComponent(clickAppends(false), card, { componentName: 'Card' })
    expect(src).toContain('const [items, setItems] = useState')
    expect(src).toContain('setItems((prev) => [...prev, 1])')
    expect(src).toContain('export function Card() {')
    expect(src).not.toContain('interface CardProps')
  })

  it('the SAME write on an outside cell becomes a prop and a derived callback', () => {
    const src = emitReactComponent(clickAppends(true), card, { componentName: 'Card' })
    expect(src).not.toContain('useState') // no local state — the value arrives
    expect(src).toContain('  items: any[]')
    expect(src).toContain('  onItemsChange: (next: any[]) => void') // the event nobody declared
    expect(src).toContain('export function Card({ items, onItemsChange }: CardProps) {')
    // the next value is computed from the prop, not from React's `prev`
    expect(src).toContain('onItemsChange([...items, 1])')
  })

  it('an outside cell the design never writes gets a value prop and NO callback', () => {
    const ir = outsideCell(emptyPageInteractions(), 'productTitle', 'Sample product', 'the product shown here')
    ir.bindings.push({ node: 'title', prop: 'text', from: 'productTitle' })
    const src = emitReactComponent(ir, card, { componentName: 'Card' })
    expect(src).toContain('  productTitle: string')
    expect(src).not.toContain('onProductTitleChange')
  })

  it('carries the description and sample into the doc comment', () => {
    const ir = outsideCell(emptyPageInteractions(), 'productTitle', 'Sample product', 'the product shown here')
    // `object` widens to `any`, so this comment is the only surviving statement
    // of the expected shape — the thing that stops a reader from guessing.
    expect(emitReactComponent(ir, card, { componentName: 'Card' })).toContain(
      '/** the product shown here — e.g. "Sample product" */',
    )
  })

  it('reads a cell as a bare identifier either way, so expressions never change', () => {
    const ir = outsideCell(emptyPageInteractions(), 'productTitle', 'Sample product')
    ir.bindings.push({ node: 'title', prop: 'text', from: 'productTitle' })
    const src = emitReactComponent(ir, card, { componentName: 'Card' })
    expect(src).toContain('{productTitle}')
    expect(src).not.toContain('props.productTitle')
  })

  it('routes a two-way field outward too — same derivation, different trigger', () => {
    const ir = outsideCell(emptyPageInteractions(), 'query', '')
    ir.editable.push({ node: 'title', prop: 'value', target: 'query' })
    expect(emitReactComponent(ir, card, { componentName: 'Card' })).toContain(
      'onChange={(e) => onQueryChange(e.target.value)}',
    )
  })

  it('leaves variant state alone — a node state is not a cell anyone outside supplies', () => {
    const a: Action = { type: 'node.setState', target: 'card.state', value: '"open"' }
    expect(emitAction(a)).toBe('setCardState("open")')
  })

  it('grows an inbound port in the graph for an outside cell, and an outbound one when written', () => {
    const read = normalize(outsideCell(emptyPageInteractions(), 'productTitle', 'x'))
    expect(read.nodes.some((n) => n.kind === 'port' && n.dir === 'in')).toBe(true)
    expect(read.nodes.some((n) => n.kind === 'port' && n.dir === 'out')).toBe(false)

    const written = normalize(clickAppends(true))
    expect(written.nodes.some((n) => n.kind === 'port' && n.dir === 'out')).toBe(true)
    expect(written.edges.some((e) => e.to === 'port:out:items')).toBe(true)
  })

  it('grows exactly one outbound port however many actions write the cell', () => {
    const ir = clickAppends(true)
    ir.interactions[0].do.push({ type: 'collection.clear', target: 'items' })
    expect(normalize(ir).nodes.filter((n) => n.kind === 'port' && n.dir === 'out')).toHaveLength(1)
  })

  it('keeps a design-owned cell free of ports entirely', () => {
    expect(normalize(clickAppends(false)).nodes.some((n) => n.kind === 'port')).toBe(false)
  })
})

describe('preview — every cell runs on its own value', () => {
  it('seeds an outside cell from its sample, so the design shows something real', () => {
    const ir = outsideCell(emptyPageInteractions(), 'productTitle', 'Sample product')
    expect(buildEnv(ir, initRuntime(ir)).productTitle).toBe('Sample product')
  })

  it('leaves a sample-less cell empty rather than inventing a value', () => {
    const ir = setVariableOutside(
      addVariable(emptyPageInteractions(), { id: 'productTitle', type: 'string', scope: 'page', initial: null }),
      'productTitle',
      true,
    )
    expect(initRuntime(ir).store.productTitle).toBeNull()
  })

  it('writes an outside cell locally — the preview is the design, not the real app', () => {
    const ir = outsideCell(emptyPageInteractions(), 'n', 1)
    expect(applyAction({ type: 'increment', target: 'n' }, {}, initRuntime(ir)).store.n).toBe(2)
  })

  it('reports that the write left the design — derived from the cell, not a log', () => {
    const ir = outsideCell(emptyPageInteractions(), 'n', 1)
    const changes = diffRuntime(initRuntime(ir), applyAction({ type: 'increment', target: 'n' }, {}, initRuntime(ir)))
    expect(changes).toHaveLength(1)
    expect(leavesDesign(ir, changes[0])).toBe(true)
  })

  it('does not report a design-owned write as leaving', () => {
    const ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 1))
    const changes = diffRuntime(initRuntime(ir), applyAction({ type: 'increment', target: 'n' }, {}, initRuntime(ir)))
    expect(leavesDesign(ir, changes[0])).toBe(false)
  })
})

describe('addressing — a cell is a cell, wherever its value comes from', () => {
  const nodes = new Set(['btn', 'row'])

  it('appends to a list the app supplies — the write leaving is plumbing, not a veto', () => {
    const ir = setVariableOutside(addVariable(emptyPageInteractions(), makeCollectionVariable('rows')), 'rows', true)
    ir.interactions.push({
      on: { node: 'btn', trigger: { type: 'press' } },
      do: [{ type: 'collection.append', target: 'rows', value: '1' }],
    })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('repeats over a list the app supplies', () => {
    const ir = setVariableOutside(addVariable(emptyPageInteractions(), makeCollectionVariable('rows')), 'rows', true)
    ir.repeaters.push({ node: 'row', over: 'rows' })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('still refuses a non-list as a list target', () => {
    const ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir.repeaters.push({ node: 'row', over: 'n' })
    expect(validatePageInteractions(ir, nodes)[0].message).toMatch(/not a list/)
  })

  it('accepts an increment with no amount — blank means +1 in both the runtime and the emitter', () => {
    const ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir.interactions.push({ on: { node: 'btn', trigger: { type: 'press' } }, do: [{ type: 'increment', target: 'n' }] })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })
})
