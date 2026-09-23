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
 * So the assertions come in two halves. The authoring half commits edits to a
 * seeded document and reads them back, checking that moving a cell into a store
 * changes nothing about its identity or its wiring. The derivation half checks
 * that the SAME authored rule lowers two different ways depending only on where
 * the cell lives.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDefaultCatalog, listActions } from '../../../../src/lib/renderer/interactions/catalog'
import { editableError, isBacked, ownerKind, type Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import {
  addCell,
  makeCell,
  makeFormula,
  addStore,
  removeStore,
  addStoreField,
  setCellStore,
  setCellDescription,
  setCellOwner,
  setCellType,
  isNameTaken,
  pageHome,
  DOCUMENT,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { currentStores } from '../../../../src/lib/renderer/interactions/document/behaviour'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { validateBehaviour } from '../../../../src/lib/renderer/interactions/addressing'
import {
  initRuntime,
  applyAction,
  buildEnv,
  diffRuntime,
  leavesDesign,
} from '../../../../src/lib/renderer/interactions/preview/runtime'
import { act, beh, commit, ex, listCell, live, pageCell, PAGE, seedPage, variantCell } from './behaviour-fixtures'
import type { TextBehaviour, TextCell } from '../../../../src/lib/renderer/interactions/expr'

beforeAll(() => initDefaultCatalog())

const card: PNode = {
  nodeId: 'card',
  role: 'container',
  children: [{ nodeId: 'title', role: 'text', text: 'Sample product' }],
}

const HOME = pageHome(PAGE)

/** Create the store `name` in the document. */
async function withStore(name = 'app'): Promise<void> {
  await commit(addStore(currentStores(), name))
}

/** Add a page cell and move it into the `app` store, holding `value` as the sample. */
async function backedCell(name: string, value: string | number, description?: string): Promise<void> {
  await commit(addCell(live(), makeCell(name, typeof value === 'number' ? 'number' : 'string', value, HOME, name), currentStores()))
  await commit(setCellStore(live(), name, 'app', currentStores()))
  if (description) await commit(setCellDescription(live(), name, description))
}

/** A page cell in the `app` store, in text form, for the engine tests. */
const storeCell = (name: string, value: string | number | null, extra: Partial<TextCell> = {}): TextCell =>
  pageCell(name, typeof value === 'number' ? 'number' : 'string', value, { store: 'app', ...extra })

describe('authoring — moving a cell into a store changes nothing else about it', () => {
  beforeEach(async () => {
    seedPage()
    await withStore()
  })

  it('keeps the id, name, type, value and home; only adds membership', async () => {
    await commit(addCell(live(), makeCell('productTitle', 'string', 'Sample product', HOME, 'c1'), currentStores()))
    const before = live().cells[0]
    await commit(setCellStore(live(), 'productTitle', 'app', currentStores()))
    const moved = live().cells[0]
    expect(moved).toMatchObject({ id: 'c1', name: 'productTitle', type: 'string', page: PAGE, initial: 'Sample product' })
    expect(ownerKind(moved)).toBe('page')
    expect(moved.store).toBe('app')
    await commit(setCellStore(live(), 'productTitle', undefined, currentStores()))
    expect(live().cells[0]).toEqual(before)
  })

  it('refuses a store the document does not have', async () => {
    await commit(addCell(live(), makeCell('x', 'string', '', HOME)))
    await commit(setCellStore(live(), 'x', 'ghost', currentStores()))
    expect(live().cells[0].store).toBeUndefined()
  })

  it('a cell in a store IS backed; a cell on its own is not', async () => {
    await backedCell('productTitle', 'Sample product')
    await commit(addCell(live(), makeCell('n', 'number', 0, HOME)))
    const byName = (name: string) => live().cells.find((c) => c.name === name)!
    expect(isBacked(byName('productTitle'))).toBe(true)
    expect(isBacked(byName('n'))).toBe(false)
  })

  it('preserves the value as the sample — a design with a placeholder already has one', async () => {
    await backedCell('productTitle', 'Sample product')
    expect(live().cells[0].initial).toBe('Sample product')
  })

  it('carries a description and clears a blank one', async () => {
    await backedCell('n', 1)
    await commit(setCellDescription(live(), 'n', '  the quantity  '))
    expect(live().cells[0].description).toBe('the quantity')
    await commit(setCellDescription(live(), 'n', '   '))
    expect(live().cells[0].description).toBeUndefined()
  })

  it('adds a field straight into a store, seeded from its type', async () => {
    await withStore('products')
    await commit(addStoreField(live(), currentStores(), 'products', 'title', 'string'))
    const [field] = live().cells
    expect(field).toMatchObject({ name: 'title', store: 'products', initial: '' })
    expect(ownerKind(field)).toBe('document')
    expect(addStoreField(live(), currentStores(), 'nope', 'x', 'string')).toEqual([])
  })

  it('lets the designer put a local cell anywhere, including a component flag document-wide', async () => {
    await commit(addCell(live(), makeCell('menuOpen', 'boolean', false, HOME)))
    await commit(setCellOwner(live(), 'menuOpen', DOCUMENT))
    expect(ownerKind(live().cells[0])).toBe('document')
    expect(validateBehaviour(live(), new Set())).toEqual([])
  })

  it('shares one namespace across stores, formulas and cells', async () => {
    await withStore('cart')
    await commit(addCell(live(), makeCell('n', 'number', 0, HOME), currentStores()))
    await commit(addCell(live(), makeFormula('double', ex(live(), 'n * 2'), HOME), currentStores()))
    for (const taken of ['cart', 'n', 'double']) expect(isNameTaken(live(), taken, currentStores())).toBe(true)
    expect(addCell(live(), makeCell('cart', 'string', '', HOME), currentStores())).toEqual([])
    expect(addStore(currentStores(), 'cart')).toEqual([])
  })

  it('deleting a store keeps its cells, as local — the wiring survives', async () => {
    await backedCell('title', 'x')
    await commit(removeStore('app'))
    expect(currentStores()).toEqual([])
    expect(live().cells[0]).toMatchObject({ name: 'title' })
    expect(live().cells[0].store).toBeUndefined()
  })

  it('retypes a store cell like any other, staying in the store', async () => {
    await backedCell('x', 'hello')
    await commit(setCellType(live(), 'x', 'number'))
    expect(live().cells[0]).toMatchObject({ type: 'number', initial: 0, store: 'app' })
  })

  it('refuses only formulas as edit targets — a store cell is editable', async () => {
    await backedCell('query', '')
    await commit(addCell(live(), makeFormula('double', ex(live(), 'query'), HOME)))
    expect(editableError(live(), 'query')).toBeNull()
    expect(editableError(live(), 'double')).toMatch(/formula/)
    expect(editableError(live(), 'nope')).toMatch(/not a value/)
    expect(editableError(live(), '  ')).toMatch(/Pick a value/)
  })

  it('has no "send out" action to author — reporting outward is not an authoring act', () => {
    expect(listActions().map((a) => a.key)).not.toContain('port.call')
  })
})

describe('derivation — one authored write, two lowerings', () => {
  /** "When the card is clicked, add to `items`." Authored once, reused below. */
  function clickAppends(backed: boolean, extra: TextBehaviour['rules'][number]['do'] = []): Behaviour {
    return beh({
      cells: [listCell('items', [], backed ? { store: 'app' } : {})],
      rules: [{ node: 'card', on: { type: 'press' }, do: [{ type: 'collection.append', target: 'items', value: '1' }, ...extra] }],
    })
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
    expect(src).not.toContain('useState')
    expect(src).toContain('  items: any[]')
    expect(src).toContain('  onItemsChange: (next: any[]) => void')
    expect(src).toContain('export function Card({ items, onItemsChange }: CardProps) {')
    expect(src).toContain('onItemsChange([...items, 1])')
  })

  it('derives exactly one callback however many actions write the cell', () => {
    const src = emitReactComponent(clickAppends(true, [{ type: 'collection.clear', target: 'items' }]), card, { componentName: 'Card' })
    expect(src.match(/onItemsChange: /g)).toHaveLength(1)
  })

  it('a store cell the design never writes gets a value prop and NO callback', () => {
    const b = beh({
      cells: [storeCell('productTitle', 'Sample product', { description: 'the product shown here' })],
      bindings: [{ node: 'title', prop: 'text', expr: 'productTitle' }],
    })
    const src = emitReactComponent(b, card, { componentName: 'Card' })
    expect(src).toContain('  productTitle: string')
    expect(src).not.toContain('onProductTitleChange')
  })

  it('carries the description and sample into the doc comment', () => {
    const b = beh({ cells: [storeCell('productTitle', 'Sample product', { description: 'the product shown here' })] })
    expect(emitReactComponent(b, card, { componentName: 'Card' })).toContain('/** the product shown here — e.g. "Sample product" */')
  })

  it('reads a cell as a bare identifier either way, so expressions never change', () => {
    const b = beh({
      cells: [storeCell('productTitle', 'Sample product')],
      bindings: [{ node: 'title', prop: 'text', expr: 'productTitle' }],
    })
    const src = emitReactComponent(b, card, { componentName: 'Card' })
    expect(src).toContain('{productTitle}')
    expect(src).not.toContain('props.productTitle')
  })

  it('routes a two-way field outward too — same derivation, different trigger', () => {
    const b = beh({ cells: [storeCell('query', '')], bindings: [{ node: 'title', prop: 'value', expr: 'query' }] })
    expect(emitReactComponent(b, card, { componentName: 'Card' })).toContain('onChange={(e) => onQueryChange(e.target.value)}')
  })

  it("a node's variant set is a cell it owns — written like any other, through its own hook", () => {
    const b = beh({
      cells: [variantCell('card', ['closed', 'open'])],
      rules: [{ node: 'card', on: { type: 'press' }, do: [{ type: 'set-variable', target: 'card.state', value: '"open"' }] }],
    })
    const src = emitReactComponent(b, card, { componentName: 'Card' })
    expect(src).toContain('const [card_state, setCard_state] = useState')
    expect(src).toContain('setCard_state("open")')
    expect(src).not.toContain('interface CardProps')
  })
})

describe('preview — every cell runs on its own value', () => {
  it('seeds a store cell from its sample, so the design shows something real', () => {
    const b = beh({ cells: [storeCell('productTitle', 'Sample product')] })
    expect(buildEnv(b, initRuntime(b)).productTitle).toBe('Sample product')
  })

  it('leaves a sample-less cell empty rather than inventing a value', () => {
    const b = beh({ cells: [storeCell('productTitle', null)] })
    expect(initRuntime(b).store.productTitle).toBeNull()
  })

  it('writes a store cell locally — the preview is the design, not the real app', () => {
    const b = beh({ cells: [storeCell('n', 1)] })
    expect(applyAction(act(b, { type: 'increment', target: 'n' }), {}, initRuntime(b), b).store.n).toBe(2)
  })

  it('reports that the write left the design — derived from where the cell lives', () => {
    const b = beh({ cells: [storeCell('n', 1)] })
    const changes = diffRuntime(initRuntime(b), applyAction(act(b, { type: 'increment', target: 'n' }), {}, initRuntime(b), b))
    expect(changes).toHaveLength(1)
    expect(leavesDesign(b, changes[0])).toBe(true)
  })

  it('does not report a local write as leaving', () => {
    const b = beh({ cells: [pageCell('n', 'number', 1)] })
    const changes = diffRuntime(initRuntime(b), applyAction(act(b, { type: 'increment', target: 'n' }), {}, initRuntime(b), b))
    expect(leavesDesign(b, changes[0])).toBe(false)
  })

  it("seeds a node's variant set on its first value and evaluates it as <node>.<cell>", () => {
    const b = beh({ cells: [variantCell('card', ['closed', 'open'])] })
    const rt = initRuntime(b)
    expect(rt.store['card.state']).toBe('closed')
    expect(buildEnv(b, rt)).toMatchObject({ card: { state: 'closed' } })
    const next = applyAction(act(b, { type: 'set-variable', target: 'card.state', value: '"open"' }), buildEnv(b, rt), rt, b)
    expect(next.store['card.state']).toBe('open')
  })
})

describe('addressing — a cell is a cell, wherever it lives', () => {
  const nodes = new Set(['btn', 'row'])
  const backedList = listCell('rows', [], { store: 'app' })

  it('appends to a list a store supplies — the write leaving is plumbing, not a veto', () => {
    const b = beh({
      cells: [backedList],
      rules: [{ node: 'btn', on: { type: 'press' }, do: [{ type: 'collection.append', target: 'rows', value: '1' }] }],
    })
    expect(validateBehaviour(b, nodes)).toEqual([])
  })

  it('repeats over a list a store supplies', () => {
    const b = beh({ cells: [backedList], bindings: [{ node: 'row', prop: 'repeat', expr: 'rows' }] })
    expect(validateBehaviour(b, nodes)).toEqual([])
  })

  it('still refuses a non-list as a list target', () => {
    const b = beh({ cells: [pageCell('n', 'number', 0)], bindings: [{ node: 'row', prop: 'repeat', expr: 'n' }] })
    expect(validateBehaviour(b, nodes)[0].message).toMatch(/not a list/)
  })

  it('accepts an increment with no amount — blank means +1 in both the runtime and the emitter', () => {
    const b = beh({
      cells: [pageCell('n', 'number', 0)],
      rules: [{ node: 'btn', on: { type: 'press' }, do: [{ type: 'increment', target: 'n' }] }],
    })
    expect(validateBehaviour(b, nodes)).toEqual([])
  })
})
