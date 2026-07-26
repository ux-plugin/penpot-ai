/**
 * Codec tests — Phase 1 slice 1 of `docs/history-redesign-plan.md`.
 *
 * The oracle is the REAL applier (`worker/process-changes.ts`), not a model
 * written for the test. That matters: the codec's job is to produce changes the
 * production apply layer treats identically to the originals, and only the
 * production apply layer can settle that.
 *
 * Two properties carry the slice:
 *
 * 1. **Forward fidelity** — routing a commit through `toOps` then `toChanges`
 *    lands the page in the same state as applying it directly.
 * 2. **Inverse agreement** — the inverse *derived* from ops agrees with the
 *    hand-built `undoChanges` the codebase already trusts. This is the bridge
 *    between the old model and the new one: if it holds, swapping the storage
 *    underneath `recordHistoryFrame` cannot change what Cmd+Z does.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Change } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { processChanges } from '../../../../src/lib/worker/process-changes'
import { toChanges, toOps, docMetaField } from '../../../../src/lib/history/journal/codec'
import { invertAll, DOC_ENTITY } from '../../../../src/lib/history/journal/op'
import {
  appendModObjPair,
  emptyChangesBuilder,
  type ChangesBuilder,
} from '../../../../src/lib/changes/changes-builder'

const PAGE = 'page-1'
const ROOT = 'root-frame'

function shape(id: string, extra: Partial<IndexedShape> = {}): IndexedShape {
  return { id, name: id, type: 'rect', x: 0, y: 0, width: 10, height: 10, ...extra } as IndexedShape
}

function basePage(): IndexedPage {
  return {
    id: PAGE,
    objects: {
      [ROOT]: shape(ROOT, { type: 'frame', shapes: ['s1', 's2'] }),
      s1: shape('s1', { fill: 'red', opacity: 1 }),
      s2: shape('s2', { fill: 'blue', opacity: 1 }),
    },
  }
}

/** Route a commit through the journal and back. */
function viaJournal(bundle: { redoChanges: Change[]; undoChanges: Change[] }): Change[] {
  return toChanges(toOps(bundle)).changes
}

describe('codec — forward fidelity against the real applier', () => {
  it('a mod-obj bundle survives the round trip', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.constantFrom('s1', 's2'),
            fill: fc.constantFrom('red', 'green', 'blue'),
            opacity: fc.integer({ min: 0, max: 10 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (edits) => {
          const page = basePage()
          let builder: ChangesBuilder = emptyChangesBuilder({ pageId: PAGE })
          for (const e of edits) {
            const before = page.objects[e.id] as unknown as Record<string, unknown>
            builder = appendModObjPair(builder, PAGE, e.id, {
              redoAssign: { fill: e.fill, opacity: e.opacity },
              undoAssign: { fill: before.fill, opacity: before.opacity },
            })
          }
          const bundle = { redoChanges: builder.redoChanges, undoChanges: builder.undoChanges }
          expect(processChanges(page, viaJournal(bundle))).toEqual(
            processChanges(page, bundle.redoChanges),
          )
        },
      ),
    )
  })

  it('add-obj and del-obj survive the round trip', () => {
    const page = basePage()
    const add: Change = {
      type: 'add-obj',
      id: 's3',
      pageId: PAGE,
      obj: shape('s3') as never,
      frameId: ROOT,
      parentId: ROOT,
      index: 1,
    }
    const del: Change = { type: 'del-obj', id: 's1', pageId: PAGE }
    const undoOfDel: Change = {
      type: 'add-obj',
      id: 's1',
      pageId: PAGE,
      obj: page.objects.s1 as never,
      frameId: ROOT,
      parentId: ROOT,
      index: 0,
    }
    const bundle = { redoChanges: [add, del], undoChanges: [undoOfDel, { type: 'del-obj', id: 's3', pageId: PAGE } as Change] }
    expect(processChanges(page, viaJournal(bundle))).toEqual(
      processChanges(page, bundle.redoChanges),
    )
  })

  it('reorder-children survives the round trip', () => {
    const page = basePage()
    const redo: Change = { type: 'reorder-children', pageId: PAGE, parentId: ROOT, shapes: ['s2', 's1'] }
    const undo: Change = { type: 'reorder-children', pageId: PAGE, parentId: ROOT, shapes: ['s1', 's2'] }
    const bundle = { redoChanges: [redo], undoChanges: [undo] }
    expect(processChanges(page, viaJournal(bundle))).toEqual(processChanges(page, [redo]))
  })
})

describe('codec — the derived inverse agrees with the hand-built one', () => {
  it('undoing via derived ops lands where undoChanges lands', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.constantFrom('s1', 's2'),
            fill: fc.constantFrom('red', 'green', 'blue'),
            opacity: fc.integer({ min: 0, max: 10 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (edits) => {
          const page = basePage()
          let builder: ChangesBuilder = emptyChangesBuilder({ pageId: PAGE })
          let scratch = page
          for (const e of edits) {
            const before = scratch.objects[e.id] as unknown as Record<string, unknown>
            builder = appendModObjPair(builder, PAGE, e.id, {
              redoAssign: { fill: e.fill, opacity: e.opacity },
              undoAssign: { fill: before.fill, opacity: before.opacity },
            })
            scratch = processChanges(scratch, [builder.redoChanges[builder.redoChanges.length - 1]])
          }
          const bundle = { redoChanges: builder.redoChanges, undoChanges: builder.undoChanges }

          const after = processChanges(page, bundle.redoChanges)
          const byHand = processChanges(after, bundle.undoChanges)
          const derived = processChanges(after, toChanges(invertAll(toOps(bundle))).changes)

          expect(derived).toEqual(byHand)
          // And both actually get home.
          expect(derived).toEqual(page)
        },
      ),
    )
  })
})

describe('codec — doc-meta records', () => {
  const token = { id: 't1', name: 'brand', value: '#fff' }
  const redo = { type: 'mod-token', setId: 'set1', token: { ...token, value: '#000' } } as never
  const undo = { type: 'mod-token', setId: 'set1', token } as never

  it('boxes onto the reserved doc entity, keyed by record identity', () => {
    const ops = toOps({ redoChanges: [], docMetaRedoChanges: [redo], docMetaUndoChanges: [undo] })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ t: 'set', entity: DOC_ENTITY, field: 'token:set1/t1' })
  })

  it('two edits to the same token share a key, so rebase can see the collision', () => {
    expect(docMetaField(redo)).toBe(docMetaField(undo))
  })

  it('inverting emits the counterpart record', () => {
    const ops = toOps({ redoChanges: [], docMetaRedoChanges: [redo], docMetaUndoChanges: [undo] })
    expect(toChanges(ops).docMetaChanges).toEqual([redo])
    expect(toChanges(invertAll(ops)).docMetaChanges).toEqual([undo])
  })
})
