import { describe, it, expect } from 'vitest'
import { emptyPageInteractions, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { makeCollectionVariable } from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { interpret, type InterpretContext } from '../../../../src/lib/renderer/interactions/nl/interpret'
import { initRuntime, buildEnv, runInteraction } from '../../../../src/lib/renderer/interactions/preview/runtime'

const NODES = [
  { id: 'btn', name: 'Add button' },
  { id: 'list', name: 'Todo list' },
]

function ctxWith(ir: PageInteractions, extra: Partial<InterpretContext> = {}): InterpretContext {
  return { nodes: NODES, ir, newId: () => 'i1', ...extra }
}

/** IR seeded with a single `items` collection (the demo's view layer). */
function withItems(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.variables.push(makeCollectionVariable('items'))
  return ir
}

describe('interpret — stub NL → IR', () => {
  it('append: "when Add button is clicked, add an item to the todo list"', () => {
    const r = interpret('when Add button is clicked, add an item to the todo list', ctxWith(withItems()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ir = r.apply(withItems())
    expect(ir.interactions).toHaveLength(1)
    expect(ir.interactions[0]).toMatchObject({ on: { node: 'btn', trigger: { type: 'press' } } })
    expect(ir.interactions[0].do[0]).toMatchObject({ type: 'collection.append', target: 'items' })
    expect(r.reply).toContain('append an item to items')
  })

  it('clear: "when Add button is clicked, clear the list"', () => {
    const r = interpret('when Add button is clicked, clear the list', ctxWith(withItems()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ir = r.apply(withItems())
    expect(ir.interactions[0].do[0]).toEqual({ type: 'set-variable', target: 'items', value: '[]' })
  })

  it('creates a collection when none exists yet', () => {
    const r = interpret('when Add button is clicked, add an item to the todo', ctxWith(emptyPageInteractions()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ir = r.apply(emptyPageInteractions())
    expect(ir.variables).toHaveLength(1) // a collection got created
    expect(ir.variables[0].type).toEqual({ collection: 'object' })
    expect(ir.interactions[0].do[0].target).toBe(ir.variables[0].id)
  })

  it('"this" resolves to the selected node', () => {
    const r = interpret('when this is clicked, add an item to the list', ctxWith(withItems(), { selectedId: 'btn' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.apply(withItems()).interactions[0].on.node).toBe('btn')
  })

  it('unknown component → clarifying reply, no IR', () => {
    const r = interpret('when Save button is clicked, add an item to the list', ctxWith(withItems()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reply).toContain("couldn't find")
    expect(r.reply).toContain('Add button') // lists what exists
  })

  it('no trigger clause → help text', () => {
    expect(interpret('make the button blue', ctxWith(withItems())).ok).toBe(false)
    expect(interpret('', ctxWith(withItems())).ok).toBe(false)
  })

  it('navigation is recognized but declined (no other page yet)', () => {
    const r = interpret('when Add button is clicked, navigate to settings', ctxWith(withItems()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reply.toLowerCase()).toContain('another page')
  })
})

describe('chat-authored IR actually runs', () => {
  it('the appended interaction fires in the runtime', () => {
    const r = interpret('when Add button is clicked, add an item to the todo list', ctxWith(withItems()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ir = r.apply(withItems())
    const it = ir.interactions[0]
    let rt = initRuntime(ir)
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt))
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }, { label: 'Item 2' }])
  })
})
