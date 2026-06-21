import { describe, expect, it } from 'vitest'
import { formatKeyCode, commandInfo, shortcutRows } from '@/lib/components/Settings/shortcut-display'
import { DEFAULT_SHORTCUTS } from '@/lib/renderer/store/shortcuts-store'

describe('formatKeyCode', () => {
  it('shortens letter/digit/arrow codes', () => {
    expect(formatKeyCode('KeyV')).toBe('V')
    expect(formatKeyCode('Digit0')).toBe('0')
    expect(formatKeyCode('ArrowLeft')).toBe('←')
    expect(formatKeyCode('Equal')).toBe('=')
    expect(formatKeyCode('Escape')).toBe('Esc')
  })
})

describe('commandInfo', () => {
  it('labels + categorizes commands', () => {
    expect(commandInfo({ type: 'TOOL_TOGGLE', tool: 'pen' })).toEqual({ label: 'Pen tool', category: 'Tools' })
    expect(commandInfo({ type: 'PATH_SUBTOOL', sub: 'bend' })).toEqual({ label: 'Bend points', category: 'Path editing' })
    expect(commandInfo({ type: 'PAN', dx: 1, dy: 0 }).label).toBe('Pan left')
    expect(commandInfo({ type: 'ZOOM_RESET' })).toEqual({ label: 'Reset zoom', category: 'View' })
  })
})

describe('shortcutRows', () => {
  it('derives rows from the live binding table', () => {
    const rows = shortcutRows(DEFAULT_SHORTCUTS)
    expect(rows.some((r) => r.label === 'Pen tool' && r.keys.includes('P'))).toBe(true)
    expect(rows.some((r) => r.label === 'Add points' && r.keys.includes('A'))).toBe(true)
    expect(rows.some((r) => r.category === 'View' && r.keys.includes('←'))).toBe(true)
  })
})
