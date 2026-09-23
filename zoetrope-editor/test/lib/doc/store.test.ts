import { beforeEach, describe, expect, it } from 'vitest'
import { effect } from '@preact/signals-core'
import type { PenpotNode } from 'penpot-exporter/types'
import { makeBaseDocument, PAGE_ID, RECT_ID, resetWorkspace, seedDocument, TEXT_ID } from '../fixtures'
import {
  add,
  children,
  commitChanges,
  del,
  descendants,
  field,
  getNode,
  mod,
  moveNodes,
  addNode,
  addSubtree,
  redo,
  undo,
  canUndo,
  canRedo,
  beginGroup,
  endGroup,
  fork,
  merge,
  discard,
  exportDocument,
  pageObjects,
  ROOT,
  treeOf,
  count,
} from '../../../src/lib/doc'
import { resetSubscribers, resetEffects } from '../../../src/lib/doc/commit'

const frame = (id: string, kids: PenpotNode[] = []): PenpotNode =>
  ({ id, type: 'frame', name: id, x: 0, y: 0, width: 10, height: 10, children: kids }) as unknown as PenpotNode
const rect = (id: string): PenpotNode =>
  ({ id, type: 'rect', name: id, x: 0, y: 0, width: 1, height: 1 }) as unknown as PenpotNode

beforeEach(() => {
  resetWorkspace()
  resetSubscribers()
  resetEffects()
  seedDocument(makeBaseDocument())
})

describe('records', () => {
  it('imports the page as top-level records in order, root not a record', () => {
    expect(children(PAGE_ID)).toEqual([RECT_ID, TEXT_ID])
    expect(getNode(ROOT)).toBeUndefined()
    expect(getNode(RECT_ID)?.parentId).toBeUndefined()
    expect(getNode(RECT_ID)?.page).toBe(PAGE_ID)
  })

  it('a field computed wakes only for its field', async () => {
    let nameRuns = 0
    const dispose = effect(() => {
      field('node', RECT_ID, 'name').value
      nameRuns++
    })
    await commitChanges({ changes: [mod('node', RECT_ID, { fills: [] })] })
    expect(nameRuns).toBe(1)
    await commitChanges({ changes: [mod('node', RECT_ID, { name: 'R' })] })
    expect(nameRuns).toBe(2)
    dispose()
  })

  it('records are frozen', () => {
    expect(Object.isFrozen(getNode(RECT_ID))).toBe(true)
  })
})

describe('commit and undo', () => {
  it('mod → undo → redo round trips', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { name: 'A' })] })
    expect(getNode(RECT_ID)?.name).toBe('A')
    expect(canUndo.value).toBe(true)
    await undo()
    expect(getNode(RECT_ID)?.name).toBe('Rect')
    expect(canRedo.value).toBe(true)
    await redo()
    expect(getNode(RECT_ID)?.name).toBe('A')
  })

  it('mod with undefined removes the field and undo restores it', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { name: undefined })] })
    expect('name' in getNode(RECT_ID)!).toBe(false)
    await undo()
    expect(getNode(RECT_ID)?.name).toBe('Rect')
  })

  it('delete cascades to descendants and undo restores the subtree in order', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a'), frame('g', [rect('b')])]), { page: PAGE_ID }) })
    expect(descendants('f')).toEqual(['a', 'g', 'b'])
    expect(getNode('b')?.frameId).toBe('g')
    expect(getNode('a')?.frameId).toBe('f')

    await commitChanges({ changes: [del('node', 'f')] })
    expect(count('node')).toBe(2)
    expect(children(PAGE_ID)).toEqual([RECT_ID, TEXT_ID])

    await undo()
    expect(children(PAGE_ID)).toEqual([RECT_ID, TEXT_ID, 'f'])
    expect(children('f')).toEqual(['a', 'g'])
    expect(children('g')).toEqual(['b'])
  })

  it('a no-op change records no frame', async () => {
    await commitChanges({ changes: [mod('node', RECT_ID, { name: 'Rect' })] })
    expect(canUndo.value).toBe(false)
  })

  it('a group folds commits into one frame', async () => {
    beginGroup('drag')
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 1 })] })
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 2 })] })
    endGroup('drag')
    await undo()
    expect(getNode(RECT_ID)?.x).toBe(0)
    expect(canUndo.value).toBe(false)
  })

  it('fork/merge squashes a scratch branch into one parent frame', async () => {
    fork()
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 1 })] })
    await commitChanges({ changes: [mod('node', RECT_ID, { y: 1 })] })
    await undo()
    expect(getNode(RECT_ID)?.y).toBe(0)
    merge('focus')
    expect(getNode(RECT_ID)?.x).toBe(1)
    await undo()
    expect(getNode(RECT_ID)?.x).toBe(0)
  })

  it('fork/discard takes the branch back', async () => {
    fork()
    await commitChanges({ changes: [mod('node', RECT_ID, { x: 5 })] })
    await discard()
    expect(getNode(RECT_ID)?.x).toBe(0)
    expect(canUndo.value).toBe(false)
  })
})

describe('tree', () => {
  it('addNode places by index and computes order and frame', async () => {
    await commitChanges({ changes: [addNode(rect('n'), { page: PAGE_ID, index: 1 })] })
    expect(children(PAGE_ID)).toEqual([RECT_ID, 'n', TEXT_ID])
    await commitChanges({ changes: [addNode(frame('f'), { page: PAGE_ID }), ] })
    await commitChanges({ changes: [addNode(rect('m'), { page: PAGE_ID, parentId: 'f' })] })
    expect(getNode('m')?.parentId).toBe('f')
    expect(getNode('m')?.frameId).toBe('f')
  })

  it('moveNodes reparents, reorders, and reframes descendants', async () => {
    await commitChanges({
      changes: [
        ...addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }),
        ...addSubtree(frame('g', [frame('h', [rect('b')])]), { page: PAGE_ID }),
      ],
    })
    await commitChanges({ changes: moveNodes(['h'], { page: PAGE_ID, parentId: 'f', index: 0 }) })
    expect(children('f')).toEqual(['h', 'a'])
    expect(children('g')).toEqual([])
    expect(getNode('h')?.frameId).toBe('f')
    expect(getNode('b')?.frameId).toBe('h')

    await commitChanges({ changes: moveNodes(['a'], { page: PAGE_ID, index: 0 }) })
    expect(children(PAGE_ID)[0]).toBe('a')
    expect(getNode('a')?.parentId).toBeUndefined()
    expect(getNode('a')?.frameId).toBeUndefined()

    await undo()
    expect(children('f')).toEqual(['h', 'a'])
  })

  it('treeOf lists depth first with depth', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    expect(treeOf(PAGE_ID).map((d) => `${d.node.id}:${d.depth}`)).toEqual([`${RECT_ID}:0`, `${TEXT_ID}:0`, 'f:0', 'a:1'])
  })

  it('pageObjects carries the synthetic root and child lists for WASM', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    const objects = pageObjects(PAGE_ID)
    expect(objects[ROOT].shapes).toEqual([RECT_ID, TEXT_ID, 'f'])
    expect(objects['f'].shapes).toEqual(['a'])
    expect(objects[RECT_ID].parentId).toBe(ROOT)
    expect(objects['a'].frameId).toBe('f')
  })
})

describe('export', () => {
  it('round trips through the exporter shape', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    const doc = exportDocument()!
    const page = doc.children![0]
    expect(page.children![0].id).toBe(ROOT)
    expect(page.children!.slice(1).map((n) => n.id)).toEqual([RECT_ID, TEXT_ID, 'f'])
    expect((page.children![3] as { children?: PenpotNode[] }).children?.[0].id).toBe('a')
    seedDocument(doc)
    expect(children(PAGE_ID)).toEqual([RECT_ID, TEXT_ID, 'f'])
    expect(children('f')).toEqual(['a'])
  })

  it('add over an existing id replaces and undo restores the previous record', async () => {
    const prev = getNode(RECT_ID)!
    await commitChanges({ changes: [add('node', { ...prev, name: 'Replaced' })] })
    expect(getNode(RECT_ID)?.name).toBe('Replaced')
    await undo()
    expect(getNode(RECT_ID)?.name).toBe('Rect')
  })
})

describe('cascade at apply time', () => {
  it('a batch that moves a child out and deletes its old parent keeps the child', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    await commitChanges({ changes: [...moveNodes(['a'], { page: PAGE_ID, index: 0 }), del('node', 'f')] })
    expect(getNode('a')).toBeDefined()
    expect(getNode('f')).toBeUndefined()
    expect(children(PAGE_ID)).toEqual(['a', RECT_ID, TEXT_ID])
    await undo()
    expect(children('f')).toEqual(['a'])
  })
})
