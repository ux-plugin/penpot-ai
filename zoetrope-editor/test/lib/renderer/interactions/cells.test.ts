/**
 * Cells & stores — the one kind of addressable state, and the plumbing derived
 * from where it lives.
 *
 * The design rule these tests hold: a designer authors ONE kind of value and only
 * ever wires it (this trigger changes that cell, this text reads that cell). A
 * value the real app supplies isn't a second kind and isn't a flag — it is a cell
 * that lives in a STORE the designer created. Everything about how a value reaches
 * the real app — props, callbacks, whether a write leaves at all — is derived at
 * lowering from that membership, and never named.
 *
 * So the assertions come in two halves. The authoring half checks that moving a
 * cell into a store changes nothing about its identity or its wiring. The
 * derivation half checks that the SAME authored interaction lowers two different
 * ways depending only on where the cell lives.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog, listActions } from '../../../../src/lib/renderer/interactions/catalog'
import {
  emptyPageInteractions,
  editableError,
  isBacked,
  type PageInteractions,
  type Store,
} from '../../../../src/lib/renderer/interactions/ir'
import {
  addCell,
  makeCell,
  makeListCell,
  makeFormula,
  addStore,
  removeStore,
  detachStore,
  addStoreField,
  setCellStore,
  setCellDescription,
  setCellOwner,
  setCellType,
  isNameTaken,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { validatePageInteractions } from '../../../../src/lib/renderer/interactions/addressing'
import {
  initRuntime,
  applyAction,
  buildEnv,
  diffRuntime,
  leavesDesign,
} from '../../../../src/lib/renderer/interactions/preview/runtime'
import { act, ex, refs, variantCell, up } from './todo-ir'

beforeAll(() => initDefaultCatalog())

const card: PNode = {
  nodeId: 'card',
  role: 'container',
  children: [{ nodeId: 'title', role: 'text', text: 'Sample product' }],
}

/** The document's stores: one, called `app`. */
const APP: Store[] = addStore([], 'app')

/** A cell that lives in the `app` store, holding `value` as the sample. */
function backedCell(ir: PageInteractions, id: string, value: string | number, description?: string): PageInteractions {
  let next = addCell(ir, makeCell(id, typeof value === 'number' ? 'number' : 'string', value), APP)
  next = setCellStore(next, id, 'app', APP)
  return description ? setCellDescription(next, id, description) : next
}

describe('authoring — moving a cell into a store changes nothing else about it', () => {
  it('keeps the id, type, value and owner; only adds membership', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('productTitle', 'string', 'Sample product'), APP)
    const before = ir.cells[0]
    const moved = setCellStore(ir, 'productTitle', 'app', APP)
    expect(moved.cells[0]).toMatchObject({ id: 'productTitle', type: 'string', owner: { kind: 'page' }, initial: 'Sample product' })
    expect(moved.cells[0].store).toBe('app')
    // and moving it back out is a clean round trip — nothing was consumed
    expect(setCellStore(moved, 'productTitle', undefined, APP).cells[0]).toEqual(before)
  })

  it('refuses a store the document does not have', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('x', 'string', ''))
    expect(setCellStore(ir, 'x', 'ghost', APP).cells[0]).not.toHaveProperty('store')
  })

  it('a cell in a store IS backed; a cell on its own is not', () => {
    const ir = backedCell(emptyPageInteractions(), 'productTitle', 'Sample product')
    expect(isBacked(ir.cells[0])).toBe(true)
    const local = addCell(emptyPageInteractions(), makeCell('n', 'number', 0))
    expect(isBacked(local.cells[0])).toBe(false)
  })

  it('preserves the value as the sample — a design with a placeholder already has one', () => {
    expect(backedCell(emptyPageInteractions(), 'productTitle', 'Sample product').cells[0].initial).toBe('Sample product')
  })

  it('carries a description and clears a blank one', () => {
    let ir = backedCell(emptyPageInteractions(), 'n', 1)
    ir = setCellDescription(ir, 'n', '  the quantity  ')
    expect(ir.cells[0].description).toBe('the quantity')
    ir = setCellDescription(ir, 'n', '   ')
    expect(ir.cells[0]).not.toHaveProperty('description')
  })

  it('adds a field straight into a store, seeded from its type', () => {
    const stores = addStore([], 'products')
    const ir = addStoreField(emptyPageInteractions(), stores, 'products', 'title', 'string')
    expect(ir.cells[0]).toMatchObject({ id: 'title', store: 'products', initial: '', owner: { kind: 'document' } })
    // and refuses to add to a store that doesn't exist
    expect(addStoreField(ir, stores, 'nope', 'x', 'string').cells).toHaveLength(1)
  })

  it('lets the designer put a local cell anywhere, including a component flag document-wide', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('menuOpen', 'boolean', false))
    ir = setCellOwner(ir, 'menuOpen', { kind: 'document' })
    expect(ir.cells[0].owner).toEqual({ kind: 'document' })
    expect(validatePageInteractions(ir, new Set())).toEqual([])
  })

  it('shares one namespace across stores, formulas and cells', () => {
    const stores = addStore([], 'cart')
    let ir = addCell(emptyPageInteractions(), makeCell('n', 'number', 0), stores)
    ir = addCell(ir, makeFormula('double', ex(ir, 'n * 2')), stores)
    for (const taken of ['cart', 'n', 'double']) expect(isNameTaken(ir, taken, stores)).toBe(true)
    expect(addCell(ir, makeCell('cart', 'string', ''), stores).cells).toHaveLength(2) // a cell can't shadow a store
    expect(addStore(stores, 'cart')).toHaveLength(1) // nor a store itself
  })

  it('deleting a store keeps its cells, as local — the wiring survives', () => {
    let ir = backedCell(emptyPageInteractions(), 'title', 'x')
    expect(removeStore(APP, 'app')).toEqual([])
    ir = detachStore(ir, 'app')
    expect(ir.cells[0]).toMatchObject({ id: 'title' })
    expect(ir.cells[0]).not.toHaveProperty('store')
  })

  it('retypes a store cell like any other, staying in the store', () => {
    let ir = backedCell(emptyPageInteractions(), 'x', 'hello')
    ir = setCellType(ir, 'x', 'number')
    expect(ir.cells[0]).toMatchObject({ type: 'number', initial: 0, store: 'app' })
  })

  it('refuses only formulas as edit targets — a store cell is editable', () => {
    let ir = backedCell(emptyPageInteractions(), 'query', '')
    ir = addCell(ir, makeFormula('double', ex(ir, 'query')))
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
  function clickAppends(backed: boolean): PageInteractions {
    let ir = addCell(emptyPageInteractions(), makeListCell('items'), APP)
    if (backed) ir = setCellStore(ir, 'items', 'app', APP)
    ir.interactions.push({
      on: { node: 'card', trigger: { type: 'press' } },
      do: [act(ir, { type: 'collection.append', target: 'items', value: '1' })],
    })
    return ir
  }

  it('a component-local cell becomes state, and the write becomes setState', () => {
    const src = emitReactComponent(clickAppends(false), card, { componentName: 'Card' })
    expect(src).toContain('const [items, setItems] = useState')
    expect(src).toContain('setItems((prev) => [...prev, 1])')
    expect(src).toContain('export function Card() {')
    expect(src).not.toContain('interface CardProps')
  })

  it('the SAME write on a store cell becomes a prop and a derived callback', () => {
    const src = emitReactComponent(clickAppends(true), card, { componentName: 'Card' })
    expect(src).not.toContain('useState') // no local state — the value arrives
    expect(src).toContain('  items: any[]')
    expect(src).toContain('  onItemsChange: (next: any[]) => void') // the event nobody declared
    expect(src).toContain('export function Card({ items, onItemsChange }: CardProps) {')
    // the next value is computed from the prop, not from React's `prev`
    expect(src).toContain('onItemsChange([...items, 1])')
  })

  it('a store cell the design never writes gets a value prop and NO callback', () => {
    const ir = backedCell(emptyPageInteractions(), 'productTitle', 'Sample product', 'the product shown here')
    ir.refs.push(refs(ir, 'title', { text: 'productTitle' }))
    const src = emitReactComponent(ir, card, { componentName: 'Card' })
    expect(src).toContain('  productTitle: string')
    expect(src).not.toContain('onProductTitleChange')
  })

  it('carries the description and sample into the doc comment', () => {
    const ir = backedCell(emptyPageInteractions(), 'productTitle', 'Sample product', 'the product shown here')
    // `object` widens to `any`, so this comment is the only surviving statement
    // of the expected shape — the thing that stops a reader from guessing.
    expect(emitReactComponent(ir, card, { componentName: 'Card' })).toContain(
      '/** the product shown here — e.g. "Sample product" */',
    )
  })

  it('reads a cell as a bare identifier either way, so expressions never change', () => {
    const ir = backedCell(emptyPageInteractions(), 'productTitle', 'Sample product')
    ir.refs.push(refs(ir, 'title', { text: 'productTitle' }))
    const src = emitReactComponent(ir, card, { componentName: 'Card' })
    expect(src).toContain('{productTitle}')
    expect(src).not.toContain('props.productTitle')
  })

  it('routes a two-way field outward too — same derivation, different trigger', () => {
    const ir = backedCell(emptyPageInteractions(), 'query', '')
    ir.refs.push(refs(ir, 'title', { value: 'query' }))
    expect(emitReactComponent(ir, card, { componentName: 'Card' })).toContain(
      'onChange={(e) => onQueryChange(e.target.value)}',
    )
  })

  it("a node's variant set is a cell it owns — written like any other, through its own hook", () => {
    const ir = up({
      cells: [variantCell('card', ['closed', 'open'])],
      interactions: [{ on: { node: 'card', trigger: { type: 'press' } }, do: [{ type: 'set-variable', target: 'card.state', value: '"open"' }] }],
    })
    const src = emitReactComponent(ir, card, { componentName: 'Card' })
    expect(src).toContain('const [card_state, setCard_state] = useState')
    expect(src).toContain('setCard_state("open")')
    expect(src).not.toContain('interface CardProps') // nobody outside supplies it
  })

  it('grows an inbound port for a store cell, and an outbound one when written', () => {
    const read = normalize(backedCell(emptyPageInteractions(), 'productTitle', 'x'))
    expect(read.nodes.some((n) => n.kind === 'port' && n.dir === 'in')).toBe(true)
    expect(read.nodes.some((n) => n.kind === 'port' && n.dir === 'out')).toBe(false)

    const written = normalize(clickAppends(true))
    expect(written.nodes.some((n) => n.kind === 'port' && n.dir === 'out')).toBe(true)
    expect(written.edges.some((e) => e.to === 'port:out:items')).toBe(true)
  })

  it('grows exactly one outbound port however many actions write the cell', () => {
    const ir = clickAppends(true)
    ir.interactions[0].do.push(act(ir, { type: 'collection.clear', target: 'items' }))
    expect(normalize(ir).nodes.filter((n) => n.kind === 'port' && n.dir === 'out')).toHaveLength(1)
  })

  it('keeps a component-local cell free of ports entirely', () => {
    expect(normalize(clickAppends(false)).nodes.some((n) => n.kind === 'port')).toBe(false)
  })
})

describe('preview — every cell runs on its own value', () => {
  it('seeds a store cell from its sample, so the design shows something real', () => {
    const ir = backedCell(emptyPageInteractions(), 'productTitle', 'Sample product')
    expect(buildEnv(ir, initRuntime(ir)).productTitle).toBe('Sample product')
  })

  it('leaves a sample-less cell empty rather than inventing a value', () => {
    const ir = addCell(emptyPageInteractions(), { ...makeCell('productTitle', 'string', null), store: 'app' }, APP)
    expect(initRuntime(ir).store.productTitle).toBeNull()
  })

  it('writes a store cell locally — the preview is the design, not the real app', () => {
    const ir = backedCell(emptyPageInteractions(), 'n', 1)
    expect(applyAction(act(ir, { type: 'increment', target: 'n' }), {}, initRuntime(ir), ir).store.n).toBe(2)
  })

  it('reports that the write left the design — derived from where the cell lives', () => {
    const ir = backedCell(emptyPageInteractions(), 'n', 1)
    const changes = diffRuntime(initRuntime(ir), applyAction(act(ir, { type: 'increment', target: 'n' }), {}, initRuntime(ir), ir))
    expect(changes).toHaveLength(1)
    expect(leavesDesign(ir, changes[0])).toBe(true)
  })

  it('does not report a local write as leaving', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('n', 'number', 1))
    const changes = diffRuntime(initRuntime(ir), applyAction(act(ir, { type: 'increment', target: 'n' }), {}, initRuntime(ir), ir))
    expect(leavesDesign(ir, changes[0])).toBe(false)
  })

  it("seeds a node's variant set on its first value and evaluates it as <node>.<cell>", () => {
    const ir = up({ cells: [variantCell('card', ['closed', 'open'])] })
    const rt = initRuntime(ir)
    expect(rt.store['card.state']).toBe('closed')
    expect(buildEnv(ir, rt)).toMatchObject({ card: { state: 'closed' } })
    const next = applyAction(act(ir, { type: 'set-variable', target: 'card.state', value: '"open"' }), buildEnv(ir, rt), rt, ir)
    expect(next.store['card.state']).toBe('open')
  })
})

describe('addressing — a cell is a cell, wherever it lives', () => {
  const nodes = new Set(['btn', 'row'])

  function backedList(id: string): PageInteractions {
    const ir = addCell(emptyPageInteractions(), makeListCell(id), APP)
    return setCellStore(ir, id, 'app', APP)
  }

  it('appends to a list a store supplies — the write leaving is plumbing, not a veto', () => {
    const ir = backedList('rows')
    ir.interactions.push({
      on: { node: 'btn', trigger: { type: 'press' } },
      do: [act(ir, { type: 'collection.append', target: 'rows', value: '1' })],
    })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('repeats over a list a store supplies', () => {
    const ir = backedList('rows')
    ir.refs.push(refs(ir, 'row', { repeat: 'rows' }))
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })

  it('still refuses a non-list as a list target', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('n', 'number', 0))
    ir.refs.push(refs(ir, 'row', { repeat: 'n' }))
    expect(validatePageInteractions(ir, nodes)[0].message).toMatch(/not a list/)
  })

  it('accepts an increment with no amount — blank means +1 in both the runtime and the emitter', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('n', 'number', 0))
    ir.interactions.push({ on: { node: 'btn', trigger: { type: 'press' } }, do: [act(ir, { type: 'increment', target: 'n' })] })
    expect(validatePageInteractions(ir, nodes)).toEqual([])
  })
})
