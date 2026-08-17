import { describe, expect, it } from 'vitest'
import { supportsLayout } from '../../../../../src/lib/components/RightSidePanel/Sections/layout-mode'

describe('supportsLayout', () => {
  it('allows layout only on frames (boards)', () => {
    expect(supportsLayout({ type: 'frame' })).toBe(true)
  })

  it('rejects shape types that cannot hold a layout', () => {
    for (const type of ['rect', 'text', 'group', 'bool', 'component', 'path', 'circle', 'image']) {
      expect(supportsLayout({ type })).toBe(false)
    }
  })

  it('rejects nullish / typeless nodes', () => {
    expect(supportsLayout(null)).toBe(false)
    expect(supportsLayout(undefined)).toBe(false)
    expect(supportsLayout({})).toBe(false)
  })
})
