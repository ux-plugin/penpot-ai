/**
 * Two-way binding — the `Editable` sugar.
 *
 * The claim being tested is that "two-way" adds NO graph concept: it normalizes
 * into a sink, a source and a fold that already existed, so the reactive graph
 * stays acyclic and one-directional. Storing the sugar (rather than only the
 * expanded form) is what lets a target with a native two-way primitive — SwiftUI
 * `$x`, Vue `v-model` — emit it directly instead of pattern-matching a graph.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import {
  emptyPageInteractions,
  editableError,
  referencedNodeIds,
  reconcile,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import {
  setEditable,
  clearEditable,
  getEditable,
  addVariable,
  makeScalarVariable,
  addDerived,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'

beforeAll(() => initDefaultCatalog())

/** A page with one text field editing a `draft` string. */
function authorField(): PageInteractions {
  let ir = addVariable(emptyPageInteractions(), makeScalarVariable('draft', 'string', ''))
  ir = setEditable(ir, 'field', 'draft')
  return ir
}

const field: PNode = { nodeId: 'field', role: 'field' }
const page: PNode = { nodeId: 'root', role: 'container', children: [field] }

describe('editableError — writability is a property of the cell', () => {
  it('accepts a local variable', () => {
    const ir = addVariable(emptyPageInteractions(), makeScalarVariable('draft', 'string', ''))
    expect(editableError(ir, 'draft')).toBeNull()
  })

  it('rejects a derived value as a category error, not a missing feature', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('n', 'number', 0))
    ir = addDerived(ir, 'double', 'n * 2')
    expect(editableError(ir, 'double')).toMatch(/formula/)
  })

  it('rejects a port-sourced variable — business logic owns it', () => {
    const ir = addVariable(emptyPageInteractions(), {
      id: 'customerName',
      type: 'string',
      scope: 'page',
      initial: '',
      source: 'port',
    })
    expect(editableError(ir, 'customerName')).toMatch(/business logic/)
  })

  it('rejects an unknown or empty target', () => {
    const ir = emptyPageInteractions()
    expect(editableError(ir, 'nope')).toMatch(/not a variable/)
    expect(editableError(ir, '  ')).toMatch(/Pick a value/)
  })
})

describe('normalize — two-way expands into three one-directional primitives', () => {
  const graph = () => normalize(authorField())

  it('produces exactly a sink, a source and a fold for the editable', () => {
    const kinds = graph()
      .nodes.filter((n) => n.id.includes('edit'))
      .map((n) => n.kind)
      .sort()
    expect(kinds).toEqual(['fold', 'sink', 'source'])
  })

  it('reads through a sink fed by the cell', () => {
    const g = graph()
    const sink = g.nodes.find((n) => n.kind === 'sink')
    expect(sink).toMatchObject({ node: 'field', prop: 'value', from: 'draft' })
    expect(g.edges).toContainEqual({ from: 'var:draft', to: sink!.id })
  })

  it('writes through a fold driven by a discrete event — not a reverse edge', () => {
    const g = graph()
    const fold = g.nodes.find((n) => n.kind === 'fold')
    // not just any source — a variable is a source too; we want the change event
    const source = g.nodes.find((n) => n.kind === 'source' && n.id.includes('edit'))
    expect(fold).toMatchObject({ state: 'draft' })
    expect(source).toMatchObject({ produces: 'event' })
    expect(g.edges).toContainEqual({ from: source!.id, to: fold!.id })
  })

  it('leaves the graph acyclic — nothing points back into the cell', () => {
    // The write lands in a fold whose `state` names the cell; there is no edge
    // INTO `var:draft`, which is what would make this a feedback loop.
    expect(graph().edges.filter((e) => e.to === 'var:draft')).toEqual([])
  })
})

describe('emit — the controlled-component pattern', () => {
  const code = () => emitReactComponent(authorField(), page, { componentName: 'Form' })

  it('reads the cell into the value prop and writes the change back', () => {
    const src = code()
    expect(src).toContain('value={draft}')
    expect(src).toContain('onChange={(e) => setDraft(e.target.value)}')
  })

  it('still declares the cell as state', () => {
    expect(code()).toContain("const [draft, setDraft] = useState<string>(\"\")")
  })

  it('self-closes a void tag — an <input> with children is a React error', () => {
    const src = code()
    expect(src).not.toContain('</input>')
    expect(src.trimEnd()).toContain('/>')
  })
})

describe('editable reducers', () => {
  it('upserts rather than duplicating', () => {
    let ir = authorField()
    ir = setEditable(ir, 'field', 'other')
    expect(ir.editable).toHaveLength(1)
    expect(getEditable(ir, 'field')?.target).toBe('other')
  })

  it('an empty target clears it', () => {
    const ir = setEditable(authorField(), 'field', '')
    expect(ir.editable).toHaveLength(0)
  })

  it('clearEditable removes only the matching (node, prop)', () => {
    let ir = authorField()
    ir = setEditable(ir, 'other', 'draft')
    ir = clearEditable(ir, 'field')
    expect(ir.editable.map((e) => e.node)).toEqual(['other'])
  })

  it('does not mutate the input IR', () => {
    const before = authorField()
    const after = setEditable(before, 'field', 'changed')
    expect(before.editable[0].target).toBe('draft')
    expect(after).not.toBe(before)
  })
})

describe('merge contract', () => {
  it('an editable node counts as referenced, and dangles when the node goes', () => {
    const ir = authorField()
    expect(referencedNodeIds(ir).has('field')).toBe(true)
    const report = reconcile(ir, new Set(['root']))
    expect(report.ok).toBe(false)
    expect(report.dangling).toContainEqual({ kind: 'editable', node: 'field' })
  })
})

describe('the control type derives from the cell being edited', () => {
  const emitFor = (type: 'string' | 'number' | 'boolean') => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('cell', type, type === 'number' ? 0 : type === 'boolean' ? false : ''))
    ir = setEditable(ir, 'f', 'cell')
    return emitReactComponent(ir, { nodeId: 'f', role: 'field' })
  }

  it('boolean becomes a checkbox — no enum to keep in sync', () => {
    expect(emitFor('boolean')).toContain('type="checkbox"')
  })

  it('number becomes a number input', () => {
    expect(emitFor('number')).toContain('type="number"')
  })

  it('string is the default, so no type attribute is emitted', () => {
    expect(emitFor('string')).not.toContain('type=')
  })
})
