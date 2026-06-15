import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryStore, markHistoryInteraction } from '../../../src/lib/history/history-store'

function frame(id: string) {
  return {
    redoChanges: [{ type: 'mod-obj' as const, id, operations: [] }],
    undoChanges: [{ type: 'mod-obj' as const, id, operations: [] }],
  }
}

function resetStore() {
  useHistoryStore.getState().discardTransactions()
  useHistoryStore.setState({
    undoStack: [],
    redoStack: [],
    transaction: null,
    transactionHolders: new Set<string>(),
  })
}

describe('useHistoryStore', () => {
  beforeEach(resetStore)

  it('pushCommitFrame clears redo stack', () => {
    const f = frame('x')
    useHistoryStore.setState({ redoStack: [f] })
    useHistoryStore.getState().pushCommitFrame(f)
    expect(useHistoryStore.getState().redoStack).toHaveLength(0)
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)
  })

  it('popUndoFrame / pushRedoFrame round-trip', () => {
    const f = frame('a')
    useHistoryStore.getState().pushCommitFrame(f)
    const popped = useHistoryStore.getState().popUndoFrame()
    expect(popped).toEqual(f)
    useHistoryStore.getState().pushRedoFrame(f)
    expect(useHistoryStore.getState().redoStack).toHaveLength(1)
  })
})

describe('undo transactions', () => {
  beforeEach(resetStore)

  it('merges commits during a transaction into one frame, redo appended / undo prepended', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    s.pushCommitFrame(frame('a'))
    s.pushCommitFrame(frame('b'))
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
    useHistoryStore.getState().commitTransaction('t')
    const { undoStack } = useHistoryStore.getState()
    expect(undoStack).toHaveLength(1)
    expect(undoStack[0].redoChanges.map((c) => (c as { id: string }).id)).toEqual(['a', 'b'])
    expect(undoStack[0].undoChanges.map((c) => (c as { id: string }).id)).toEqual(['b', 'a'])
  })

  it('commits during a transaction still clear the redo stack', () => {
    useHistoryStore.setState({ redoStack: [frame('old')] })
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    s.pushCommitFrame(frame('a'))
    expect(useHistoryStore.getState().redoStack).toHaveLength(0)
  })

  it('is refcounted: frame pushes only when the last holder commits', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('h1', 0)
    s.beginTransaction('h2', 0)
    s.pushCommitFrame(frame('a'))
    useHistoryStore.getState().commitTransaction('h1')
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
    useHistoryStore.getState().commitTransaction('h2')
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)
  })

  it('empty transaction commits without pushing a frame', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    useHistoryStore.getState().commitTransaction('t')
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
    expect(useHistoryStore.getState().transaction).toBeNull()
  })

  it('commitTransaction with unknown id is a no-op', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    s.pushCommitFrame(frame('a'))
    useHistoryStore.getState().commitTransaction('other')
    expect(useHistoryStore.getState().transaction).not.toBeNull()
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
  })

  it('flushTransactions force-pushes the buffer regardless of holders', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    s.pushCommitFrame(frame('a'))
    useHistoryStore.getState().flushTransactions()
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    expect(useHistoryStore.getState().transaction).toBeNull()
    expect(useHistoryStore.getState().transactionHolders.size).toBe(0)
  })

  it('discardTransactions drops the buffer without recording history', () => {
    const s = useHistoryStore.getState()
    s.beginTransaction('t', 0)
    s.pushCommitFrame(frame('a'))
    useHistoryStore.getState().discardTransactions()
    expect(useHistoryStore.getState().undoStack).toHaveLength(0)
    expect(useHistoryStore.getState().transaction).toBeNull()
  })

  it('watchdog force-commits a leaked transaction', () => {
    vi.useFakeTimers()
    try {
      const s = useHistoryStore.getState()
      s.beginTransaction('t', 1000)
      s.pushCommitFrame(frame('a'))
      expect(useHistoryStore.getState().undoStack).toHaveLength(0)
      vi.advanceTimersByTime(1001)
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
      expect(useHistoryStore.getState().transaction).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('markHistoryInteraction coalesces a burst into one frame after the idle window', () => {
    vi.useFakeTimers()
    try {
      const s = useHistoryStore.getState()
      // A drag of three moves, each within the idle window.
      markHistoryInteraction('color-edit', 350)
      s.pushCommitFrame(frame('a'))
      vi.advanceTimersByTime(100)
      markHistoryInteraction('color-edit', 350)
      s.pushCommitFrame(frame('b'))
      vi.advanceTimersByTime(100)
      markHistoryInteraction('color-edit', 350)
      s.pushCommitFrame(frame('c'))
      // Still accumulating — no frame pushed yet.
      expect(useHistoryStore.getState().undoStack).toHaveLength(0)
      // Idle elapses → exactly one frame with all three edits.
      vi.advanceTimersByTime(351)
      const { undoStack } = useHistoryStore.getState()
      expect(undoStack).toHaveLength(1)
      expect(undoStack[0].redoChanges.map((c) => (c as { id: string }).id)).toEqual(['a', 'b', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-begin with the same id resets the watchdog instead of stacking holders', () => {
    vi.useFakeTimers()
    try {
      const s = useHistoryStore.getState()
      s.beginTransaction('t', 1000)
      vi.advanceTimersByTime(600)
      useHistoryStore.getState().beginTransaction('t', 1000)
      useHistoryStore.getState().pushCommitFrame(frame('a'))
      vi.advanceTimersByTime(600)
      // Old timer would have fired at 1000ms total; reset pushed it to 1600ms.
      expect(useHistoryStore.getState().transaction).not.toBeNull()
      useHistoryStore.getState().commitTransaction('t')
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
