import { beforeEach, describe, expect, it } from 'vitest'
import {
  recentEdits,
  lastExited,
  shouldRecord,
  pushMru,
  cycleEdit,
  beginEditSession,
  markEditDirty,
  endEditSession,
  clearLastExited,
  DWELL_MS,
  type EditContext,
} from '@/lib/renderer/three/edit-history'

const ctx = (id: string): EditContext => ({ kind: 'scene3d', targetId: id, name: id })

beforeEach(() => {
  recentEdits.value = []
  lastExited.value = null
})

describe('edit-history pure helpers', () => {
  it('shouldRecord: dwelled long enough OR did work', () => {
    expect(shouldRecord({ targetId: 'a', enteredAt: 0, dirty: false }, DWELL_MS)).toBe(true)
    expect(shouldRecord({ targetId: 'a', enteredAt: 0, dirty: false }, DWELL_MS - 1)).toBe(false)
    expect(shouldRecord({ targetId: 'a', enteredAt: 0, dirty: true }, 0)).toBe(true)
  })

  it('pushMru dedupes by targetId, most-recent first, bounded to 8', () => {
    let l: EditContext[] = []
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) l = pushMru(l, ctx(id))
    expect(l.length).toBe(8)
    expect(l[0].targetId).toBe('i')
    l = pushMru(l, ctx('c'))
    expect(l[0].targetId).toBe('c')
    expect(l.filter((x) => x.targetId === 'c').length).toBe(1)
  })

  it('cycleEdit wraps; an unknown current returns the head', () => {
    const l = [ctx('a'), ctx('b'), ctx('c')]
    expect(cycleEdit(l, null, 1)?.targetId).toBe('a')
    expect(cycleEdit(l, 'a', 1)?.targetId).toBe('b')
    expect(cycleEdit(l, 'c', 1)?.targetId).toBe('a')
    expect(cycleEdit(l, 'a', -1)?.targetId).toBe('c')
    expect(cycleEdit([], 'a', 1)).toBeNull()
  })
})

describe('edit-history sessions (substance gate)', () => {
  it('records a dirty session on exit, skips a trivial one, but always remembers last-exit', () => {
    beginEditSession('scene-a', 1000)
    markEditDirty()
    endEditSession(ctx('scene-a'), 1100)
    expect(recentEdits.value.map((c) => c.targetId)).toEqual(['scene-a'])
    expect(lastExited.value?.targetId).toBe('scene-a')

    beginEditSession('scene-b', 2000)
    endEditSession(ctx('scene-b'), 2100) // short + not dirty → not recorded
    expect(recentEdits.value.map((c) => c.targetId)).toEqual(['scene-a'])
    expect(lastExited.value?.targetId).toBe('scene-b')
  })

  it('records a long (dwelled) session even without work', () => {
    beginEditSession('scene-c', 0)
    endEditSession(ctx('scene-c'), DWELL_MS)
    expect(recentEdits.value.map((c) => c.targetId)).toEqual(['scene-c'])
  })

  it('clearLastExited clears the resume affordance', () => {
    lastExited.value = ctx('x')
    clearLastExited()
    expect(lastExited.value).toBeNull()
  })
})
