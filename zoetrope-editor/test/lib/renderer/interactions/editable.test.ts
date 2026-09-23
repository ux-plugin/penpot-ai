/**
 * Two-way editing — a `value` binding that references a bare writable cell.
 *
 * The claim being tested is that "two-way" adds NO record kind: it is an
 * ordinary binding whose expression happens to be a cell that can be written.
 * Keeping it a plain binding (rather than an expanded read + write pair) is what
 * lets a target with a native two-way primitive — SwiftUI `$x`, Vue `v-model` —
 * emit it directly, and what the React emitter lowers to the controlled-component
 * pattern.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import {
  behaviourNodes,
  EMPTY_BEHAVIOUR,
  editableError,
  editedCell,
  VALUE_PROP,
  type Behaviour,
} from '../../../../src/lib/renderer/interactions/ir'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { setRef, clearRef } from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { beh, commit, formulaCell, live, load, pageCell, seedPage, text, txt } from './behaviour-fixtures'

beforeAll(() => initDefaultCatalog())

/** A page with one text field editing a `draft` string. */
function authorField(): Behaviour {
  return beh({
    cells: [pageCell('draft', 'string', '')],
    bindings: [{ node: 'field', prop: VALUE_PROP, expr: 'draft' }],
  })
}

const field: PNode = { nodeId: 'field', role: 'field' }
const page: PNode = { nodeId: 'root', role: 'container', children: [field] }

describe('editableError — writability is a property of the cell', () => {
  it('accepts a page cell', () => {
    expect(editableError(beh({ cells: [pageCell('draft', 'string', '')] }), 'draft')).toBeNull()
  })

  it('rejects a formula as a category error, not a missing feature', () => {
    const b = beh({ cells: [pageCell('n', 'number', 0), formulaCell('double', 'n * 2')] })
    expect(editableError(b, 'double')).toMatch(/formula/)
  })

  it('ACCEPTS a cell the app supplies — the designer decides what wires to what', () => {
    const b = beh({ cells: [pageCell('customerName', 'string', '', { store: 'app', description: 'the signed-in customer' })] })
    expect(editableError(b, 'customerName')).toBeNull()
  })

  it('rejects an unknown or empty target', () => {
    expect(editableError(EMPTY_BEHAVIOUR, 'nope')).toMatch(/not a value/)
    expect(editableError(EMPTY_BEHAVIOUR, '  ')).toMatch(/Pick a value/)
  })
})

describe('editedCell — what makes a reference two-way', () => {
  it('is the cell when `value` names a bare writable cell', () => {
    expect(editedCell(authorField(), 'field')?.name).toBe('draft')
  })

  it('is nothing for an expression over cells, or for a formula — those are one-way reads', () => {
    const b = beh({
      cells: [pageCell('draft', 'string', ''), formulaCell('upper', 'draft + "!"')],
      bindings: [
        { node: 'a', prop: VALUE_PROP, expr: 'draft + "?"' },
        { node: 'b', prop: VALUE_PROP, expr: 'upper' },
      ],
    })
    expect(editedCell(b, 'a')).toBeUndefined()
    expect(editedCell(b, 'b')).toBeUndefined()
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

describe('editing is an ordinary binding', () => {
  beforeEach(async () => {
    seedPage(['field', 'other'])
    await load(authorField())
  })

  it('re-pointing `value` replaces rather than duplicates', async () => {
    await commit(setRef(live(), 'field', VALUE_PROP, 'other'))
    expect(live().bindings).toHaveLength(1)
    expect(text(live()).bindings[0]).toMatchObject({ node: 'field', prop: VALUE_PROP, expr: 'other' })
  })

  it('a blank expression clears the binding', async () => {
    await commit(setRef(live(), 'field', VALUE_PROP, ''))
    expect(live().bindings).toHaveLength(0)
  })

  it('clearRef removes only the matching (node, prop)', async () => {
    await commit(setRef(live(), 'other', VALUE_PROP, 'draft'))
    await commit(clearRef(live(), 'field', VALUE_PROP))
    expect(live().bindings.map((x) => x.node)).toEqual(['other'])
  })

  it('an edit is only changes — the document is untouched until they are committed', async () => {
    const changes = setRef(live(), 'field', VALUE_PROP, 'changed')
    expect(txt(live(), live().bindings[0].expr)).toBe('draft')
    await commit(changes)
    expect(txt(live(), live().bindings[0].expr)).toBe('changed')
  })

  it('an editing node counts as carrying behaviour', () => {
    expect(behaviourNodes(live()).has('field')).toBe(true)
  })
})

describe('the control type derives from the cell being edited', () => {
  const emitFor = (type: 'string' | 'number' | 'boolean') => {
    const b = beh({
      cells: [pageCell('cell', type, type === 'number' ? 0 : type === 'boolean' ? false : '')],
      bindings: [{ node: 'f', prop: VALUE_PROP, expr: 'cell' }],
    })
    return emitReactComponent(b, { nodeId: 'f', role: 'field' })
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
