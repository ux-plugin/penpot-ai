/**
 * Human-readable view of the keyboard bindings for the Settings dialog. Derives
 * from the SAME `buildKeyBindings` table the dispatcher uses, so the reference
 * shown to the user can never drift from what actually fires.
 */

import type { Command } from '../../renderer/input/commands'
import { buildKeyBindings, TOOL_BINDINGS, type ToolKeyField } from '../../renderer/input/key-bindings'
import type { ShortcutsConfig } from '../../renderer/types'

const KEY_LABEL: Record<string, string> = {
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadEnter: 'Numpad ↵',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Equal: '=',
  Minus: '−',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad −',
  Digit0: '0',
  Numpad0: 'Numpad 0',
}

/** Turn a KeyboardEvent.code into a short glyph/label (KeyV → V, Equal → =). */
export function formatKeyCode(code: string): string {
  if (KEY_LABEL[code]) return KEY_LABEL[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

export type ShortcutCategory = 'Tools' | 'Path editing' | 'View'

const TOOL_NAMES: Record<string, string> = {
  pen: 'Pen', rect: 'Rectangle', frame: 'Frame', text: 'Text',
  ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', star: 'Star',
}

/** Label + grouping for one command. */
export function commandInfo(cmd: Command): { label: string; category: ShortcutCategory } {
  switch (cmd.type) {
    case 'TOOL_SELECT': return { label: 'Select tool', category: 'Tools' }
    case 'TOOL_TOGGLE': return { label: `${TOOL_NAMES[cmd.tool] ?? cmd.tool} tool`, category: 'Tools' }
    case 'DRAW_CANCEL': return { label: 'Cancel tool', category: 'Tools' }
    case 'PATH_SUBTOOL': {
      const n: Record<string, string> = { move: 'Move', add: 'Add', bend: 'Bend' }
      return { label: `${n[cmd.sub] ?? cmd.sub} points`, category: 'Path editing' }
    }
    case 'PATH_FINISH': return { label: 'Finish editing', category: 'Path editing' }
    case 'PAN': {
      const dir = cmd.dx > 0 ? 'left' : cmd.dx < 0 ? 'right' : cmd.dy > 0 ? 'up' : 'down'
      return { label: `Pan ${dir}`, category: 'View' }
    }
    case 'ZOOM_IN': return { label: 'Zoom in', category: 'View' }
    case 'ZOOM_OUT': return { label: 'Zoom out', category: 'View' }
    case 'ZOOM_RESET': return { label: 'Reset zoom', category: 'View' }
  }
}

export interface ShortcutRow {
  label: string
  keys: string[]
  category: ShortcutCategory
}

/** All bindings as display rows, in the table's order. */
export function shortcutRows(cfg: ShortcutsConfig): ShortcutRow[] {
  return buildKeyBindings(cfg).map((b) => {
    const info = commandInfo(b.command)
    return { label: info.label, keys: b.codes.map(formatKeyCode), category: info.category }
  })
}


/** If `code` is already bound to something other than `field`, return that
 *  binding's human label (so the rebind UI can warn); else null. Checks the other
 *  tool keys plus the reserved pan/zoom/finish codes. */
export function toolKeyConflict(cfg: ShortcutsConfig, field: ToolKeyField, code: string): string | null {
  for (const tb of TOOL_BINDINGS) {
    if (tb.field !== field && cfg[tb.field] === code) return tb.label
  }
  const reserved: Record<string, string> = {
    [cfg.panLeft]: 'Pan left',
    [cfg.panRight]: 'Pan right',
    [cfg.panUp]: 'Pan up',
    [cfg.panDown]: 'Pan down',
    Escape: 'Cancel / Finish',
    Enter: 'Finish editing',
    NumpadEnter: 'Finish editing',
  }
  for (const c of [...cfg.zoomInKeys, ...cfg.zoomOutKeys, ...cfg.resetKeys]) reserved[c] = 'View (zoom)'
  return reserved[code] ?? null
}
