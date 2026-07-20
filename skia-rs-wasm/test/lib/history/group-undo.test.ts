import { beforeEach, describe, expect, it } from 'vitest'
import { useHistoryStore } from '@/lib/history/history-store'
import type { CommitFrame } from '@/lib/changes/commit-types'
import type { Change } from 'penpot-exporter/types'

// A minimal non-empty frame carrying a tag we can assert on (via the change id).
const frame = (tag: string, groupId?: string): CommitFrame => {
  const ch = { type: 'mod-obj', id: tag, operations: [{ type: 'assign', value: {} }] } as unknown as Change
  return { redoChanges: [ch], undoChanges: [ch], groupId }
}
const ids = (run: CommitFrame[]) => run.map((f) => f.redoChanges[0].id)

describe('history run (group-undo) semantics', () => {
  beforeEach(() => useHistoryStore.getState().clearHistory())

  it('collapses a run of consecutive same-groupId frames', () => {
    const s = useHistoryStore.getState()
    ;['a', 'b', 'c'].forEach((t) => s.pushCommitFrame(frame(t, 'gA')))
    // popUndoRun uses the freshest state each call (zustand getState is live).
    const run = useHistoryStore.getState().popUndoRun()
    expect(ids(run)).toEqual(['a', 'b', 'c']) // oldest→newest
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
  })

  it('takes only the TOP consecutive run, leaving earlier frames', () => {
    const s = useHistoryStore.getState()
    s.pushCommitFrame(frame('x')) // ungrouped
    s.pushCommitFrame(frame('a', 'gA'))
    s.pushCommitFrame(frame('b', 'gA'))
    const run = useHistoryStore.getState().popUndoRun()
    expect(ids(run)).toEqual(['a', 'b'])
    expect(ids(useHistoryStore.getState().undoStack)).toEqual(['x'])
  })

  it('treats an ungrouped frame as a run of one (ordinary edits never merge)', () => {
    const s = useHistoryStore.getState()
    s.pushCommitFrame(frame('x'))
    s.pushCommitFrame(frame('y'))
    expect(ids(useHistoryStore.getState().popUndoRun())).toEqual(['y'])
    expect(ids(useHistoryStore.getState().popUndoRun())).toEqual(['x'])
  })

  it('does not merge two DIFFERENT groups', () => {
    const s = useHistoryStore.getState()
    s.pushCommitFrame(frame('a', 'gA'))
    s.pushCommitFrame(frame('b', 'gB'))
    expect(ids(useHistoryStore.getState().popUndoRun())).toEqual(['b'])
    expect(ids(useHistoryStore.getState().popUndoRun())).toEqual(['a'])
  })

  it('round-trips through redo preserving commit order', () => {
    const s = useHistoryStore.getState()
    ;['a', 'b', 'c'].forEach((t) => s.pushCommitFrame(frame(t, 'gA')))
    const run = useHistoryStore.getState().popUndoRun()
    useHistoryStore.getState().pushRedoRun(run)
    const redo = useHistoryStore.getState().popRedoRun()
    expect(ids(redo)).toEqual(['a', 'b', 'c']) // still oldest→newest
    useHistoryStore.getState().pushUndoRun(redo)
    expect(ids(useHistoryStore.getState().undoStack)).toEqual(['a', 'b', 'c'])
  })
})
