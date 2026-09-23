import { describe, expect, it } from 'vitest'
import { refFields, refsOf, cascadeFields } from '../../../src/lib/doc/registry'

describe('reference registry', () => {
  it('reads the node references from the schema', () => {
    expect(refFields('node')).toEqual([
      { field: 'page', kind: 'page', onDelete: 'cascade' },
      { field: 'parentId', kind: 'node', onDelete: 'cascade' },
      { field: 'frameId', kind: 'node', onDelete: 'keep' },
    ])
    expect(cascadeFields('node').map((f) => f.field)).toEqual(['page', 'parentId'])
    expect(refFields('page')).toEqual([])
  })

  it('lists the references a record holds', () => {
    const refs = refsOf('node', { id: 'a', page: 'p', parentId: 'f', order: 'a0', type: 'rect' } as never)
    expect(refs).toEqual([
      { field: 'page', kind: 'page', id: 'p' },
      { field: 'parentId', kind: 'node', id: 'f' },
    ])
  })
})
