import { describe, expect, it } from 'vitest'
import { applyToPage } from '@/lib/worker/page-store'
import { ROOT, type Node, type PageObjects } from '@/lib/doc'
import { rootFrame } from '@/lib/doc/export'

const node = (id: string, order: string, parentId?: string): Node =>
  ({ id, type: 'rect', page: 'p', order, parentId, frameId: parentId }) as unknown as Node

describe('worker page store', () => {
  it('keeps child lists ordered and untouched nodes by identity', () => {
    const objects: PageObjects = { [ROOT]: rootFrame({ id: 'p', order: 'a0' }) }
    const page = { id: 'p', objects }
    const a = node('a', 'a1')
    const b = node('b', 'a2')
    const next = applyToPage(page, [
      { op: 'add', kind: 'node', record: b },
      { op: 'add', kind: 'node', record: a },
    ])
    expect(next[ROOT].shapes).toEqual(['a', 'b'])
    expect(next['a'].parentId).toBe(ROOT)

    const later = applyToPage({ id: 'p', objects: next }, [{ op: 'mod', kind: 'node', id: 'a', set: { order: 'a3' } }])
    expect(later[ROOT].shapes).toEqual(['b', 'a'])
    expect(later['b']).toBe(next['b'])

    const gone = applyToPage({ id: 'p', objects: later }, [{ op: 'del', kind: 'node', id: 'a' }])
    expect(gone['a']).toBeUndefined()
    expect(gone[ROOT].shapes).toEqual(['b'])
  })
})
