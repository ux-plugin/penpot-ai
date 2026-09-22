/**
 * Two-way editing — a `value` property that references a bare writable cell.
 *
 * The claim being tested is that "two-way" adds NO IR concept and NO graph
 * concept: it is an ordinary property reference whose expression happens to be
 * a cell that can be written, and it normalizes into a sink, a source and a
 * fold that already existed, so the reactive graph stays acyclic and
 * one-directional. Keeping it a plain reference (rather than only the expanded
 * form) is what lets a target with a native two-way primitive — SwiftUI `$x`,
 * Vue `v-model` — emit it directly instead of pattern-matching a graph.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import {
  emptyPageInteractions,
  editableError,
  editedCell,
  referencedNodeIds,
  reconcile,
  VALUE_PROP,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import {
  setRef,
  clearRef,
  addCell,
  makeCell,
  makeFormula,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { ex, text, txt } from './todo-ir'

beforeAll(() => initDefaultCatalog())

/** A page with one text field editing a `draft` string. */
function authorField(): PageInteractions {
  let ir = addCell(emptyPageInteractions(), makeCell('draft', 'string', ''))
  ir = setRef(ir, 'field', VALUE_PROP, 'draft')
  return ir
}

const field: PNode = { nodeId: 'field', role: 'field' }
const page: PNode = { nodeId: 'root', role: 'container', children: [field] }

describe('editableError — writability is a property of the cell', () => {
  it('accepts a page cell', () => {
    const ir = addCell(emptyPageInteractions(), makeCell('draft', 'string', ''))
    expect(editableError(ir, 'draft')).toBeNull()
  })

  it('rejects a formula as a category error, not a missing feature', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('n', 'number', 0))
    ir = addCell(ir, makeFormula('double', ex(ir, 'n * 2')))
    expect(editableError(ir, 'double')).toMatch(/formula/)
  })

  it('ACCEPTS a cell the app supplies — the designer decides what wires to what', () => {
    // What a write has to do to reach the real source is derived plumbing (see
    // cells.test.ts), never a reason to refuse the wiring.
    const ir = addCell(emptyPageInteractions(), {
      ...makeCell('customerName', 'string', ''),
      store: 'app',
      description: 'the signed-in customer',
    })
    expect(editableError(ir, 'customerName')).toBeNull()
  })

  it('rejects an unknown or empty target', () => {
    const ir = emptyPageInteractions()
    expect(editableError(ir, 'nope')).toMatch(/not a value/)
    expect(editableError(ir, '  ')).toMatch(/Pick a value/)
  })
})

describe('editedCell — what makes a reference two-way', () => {
  it('is the cell when `value` names a bare writable cell', () => {
    expect(editedCell(authorField(), 'field')?.id).toBe('draft')
  })

  it('is nothing for an expression over cells, or for a formula — those are one-way reads', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('draft', 'string', ''))
    ir = addCell(ir, makeFormula('upper', ex(ir, 'draft + "!"')))
    expect(editedCell(setRef(ir, 'a', VALUE_PROP, 'draft + "?"'), 'a')).toBeUndefined()
    expect(editedCell(setRef(ir, 'b', VALUE_PROP, 'upper'), 'b')).toBeUndefined()
  })
})

describe('normalize — two-way expands into three one-directional primitives', () => {
  const graph = () => normalize(authorField())

  it('produces exactly a sink, a source and a fold for the edited value', () => {
    const kinds = graph()
      .nodes.filter((n) => n.id.includes('edit') || n.kind === 'sink')
      .map((n) => n.kind)
      .sort()
    expect(kinds).toEqual(['fold', 'sink', 'source'])
  })

  it('reads through a sink fed by the cell', () => {
    const ir = authorField()
    const g = normalize(ir)
    const sink = g.nodes.find((n) => n.kind === 'sink')
    expect(sink).toMatchObject({ node: 'field', prop: 'value' })
    expect(sink && sink.kind === 'sink' ? txt(ir, sink.from) : '').toBe('draft')
    expect(g.edges).toContainEqual({ from: 'cell:draft', to: sink!.id })
  })

  it('writes through a fold driven by a discrete event — not a reverse edge', () => {
    const g = graph()
    const fold = g.nodes.find((n) => n.kind === 'fold')
    // not just any source — a cell is a source too; we want the change event
    const source = g.nodes.find((n) => n.kind === 'source' && n.id.includes('edit'))
    expect(fold).toMatchObject({ state: 'draft' })
    expect(source).toMatchObject({ produces: 'event' })
    expect(g.edges).toContainEqual({ from: source!.id, to: fold!.id })
  })

  it('leaves the graph acyclic — nothing points back into the cell', () => {
    // The write lands in a fold whose `state` names the cell; there is no edge
    // INTO `cell:draft`, which is what would make this a feedback loop.
    expect(graph().edges.filter((e) => e.to === 'cell:draft')).toEqual([])
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
    expect(code()).toContain('const [draft, setDraft] = useState<string>("")')
  })

  it('self-closes a void tag — an <input> with children is a React error', () => {
    const src = code()
    expect(src).not.toContain('</input>')
    expect(src.trimEnd()).toContain('/>')
  })
})

describe('editing is an ordinary property reference', () => {
  it('re-pointing `value` replaces rather than duplicates', () => {
    let ir = authorField()
    ir = setRef(ir, 'field', VALUE_PROP, 'other')
    expect(ir.refs).toHaveLength(1)
    expect(text(ir).refs[0].props).toEqual({ value: 'other' })
  })

  it('a blank expression clears it, dropping an otherwise empty reference block', () => {
    const ir = setRef(authorField(), 'field', VALUE_PROP, '')
    expect(ir.refs).toHaveLength(0)
  })

  it('clearRef removes only the matching (node, prop)', () => {
    let ir = authorField()
    ir = setRef(ir, 'other', VALUE_PROP, 'draft')
    ir = clearRef(ir, 'field', VALUE_PROP)
    expect(ir.refs.map((r) => r.node)).toEqual(['other'])
  })

  it('does not mutate the input IR', () => {
    const before = authorField()
    const after = setRef(before, 'field', VALUE_PROP, 'changed')
    expect(txt(before, before.refs[0].props.value)).toBe('draft')
    expect(after).not.toBe(before)
  })
})

describe('merge contract', () => {
  it('an editing node counts as referenced, and dangles when the node goes', () => {
    const ir = authorField()
    expect(referencedNodeIds(ir).has('field')).toBe(true)
    const report = reconcile(ir, new Set(['root']))
    expect(report.ok).toBe(false)
    expect(report.dangling).toContainEqual({ kind: 'refs', node: 'field' })
  })
})

describe('the control type derives from the cell being edited', () => {
  const emitFor = (type: 'string' | 'number' | 'boolean') => {
    let ir = addCell(emptyPageInteractions(), makeCell('cell', type, type === 'number' ? 0 : type === 'boolean' ? false : ''))
    ir = setRef(ir, 'f', VALUE_PROP, 'cell')
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
