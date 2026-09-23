/**
 * Behaviour edits share the document's undo stack: each commit is one frame,
 * undo restores the records as they were, redo reapplies them.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { canUndo, redo, undo } from '../../../../src/lib/doc'
import { EMPTY_BEHAVIOUR, findCell } from '../../../../src/lib/renderer/interactions/ir'
import { currentStores, replaceBehaviour } from '../../../../src/lib/renderer/interactions/document/behaviour'
import {
  addCell,
  addStore,
  DOCUMENT,
  makeCell,
  removeStore,
  setCellFormula,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { beh, commit, formulaCell, live, PAGE, seedPage, txt } from './behaviour-fixtures'

const behA = () => beh({ cells: [formulaCell('d1', '1 + 1')] })
const behB = () => beh({ cells: [formulaCell('d1', '2 + 2'), formulaCell('d2', '3')] })

describe('behaviour edits are undoable through the document history', () => {
  beforeEach(() => seedPage([]))

  it('commit records a frame; undo restores prev; redo reapplies', async () => {
    expect(live()).toEqual(EMPTY_BEHAVIOUR)

    const next = behA()
    await replaceBehaviour(PAGE, next)
    expect(live()).toEqual(next)
    expect(canUndo.value).toBe(true)

    await undo()
    expect(live()).toEqual(EMPTY_BEHAVIOUR)

    await redo()
    expect(live()).toEqual(next)
  })

  it('walks back through multiple edits in order', async () => {
    const a = behA()
    const b = behB()
    await replaceBehaviour(PAGE, a)
    await replaceBehaviour(PAGE, b)
    expect(live()).toEqual(b)

    await undo()
    expect(live()).toEqual(a)

    await undo()
    expect(live()).toEqual(EMPTY_BEHAVIOUR)
  })

  it('an inspector edit is one frame of its own', async () => {
    await replaceBehaviour(PAGE, behA())
    await commit(setCellFormula(live(), 'd1', '5 * 5'))
    expect(txt(live(), findCell(live(), 'd1')?.formula)).toBe('5 * 5')

    await undo()
    expect(txt(live(), findCell(live(), 'd1')?.formula)).toBe('1 + 1')

    await redo()
    expect(txt(live(), findCell(live(), 'd1')?.formula)).toBe('5 * 5')
  })

  it('deleting a store and detaching its cells undo as one step', async () => {
    await commit(addStore(currentStores(), 'api'))
    await commit(addCell(live(), { ...makeCell('user', 'string', '', DOCUMENT, 'user'), store: 'api' }, currentStores()))

    await commit(removeStore('api'))
    expect(currentStores()).toEqual([])
    expect(findCell(live(), 'user')?.store).toBeUndefined()

    await undo()
    expect(currentStores().map((s) => s.id)).toEqual(['api'])
    expect(findCell(live(), 'user')?.store).toBe('api')
  })
})
