import { describe, expect, it } from 'vitest'
import { roundedRectPath } from '../../../../src/lib/components/Overlay/useImperativeSlotHover'

describe('roundedRectPath', () => {
  it('draws square corners as straight lines, centred on the origin', () => {
    expect(roundedRectPath(100, 40, [0, 0, 0, 0])).toBe(
      'M-50,-20 L50,-20 L50,-20 L50,20 L50,20 L-50,20 L-50,20 L-50,-20 L-50,-20 Z',
    )
  })

  it('gives each corner its own radius, in top-left → bottom-left order', () => {
    const d = roundedRectPath(100, 40, [4, 8, 0, 2])
    expect(d.startsWith('M-46,-20')).toBe(true) // top-left radius 4
    expect(d).toContain('A8,8 0 0 1 50,-12') // top-right radius 8
    expect(d).toContain('L50,20 L50,20') // bottom-right square
    expect(d).toContain('A2,2 0 0 1 -50,18') // bottom-left radius 2
  })

  it('clamps an oversized radius to half the shorter side', () => {
    const d = roundedRectPath(100, 40, [999, 999, 999, 999])
    expect(d).toContain('A20,20')
    expect(d).not.toContain('999')
  })
})
