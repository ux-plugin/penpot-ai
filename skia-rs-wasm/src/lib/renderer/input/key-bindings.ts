/**
 * The keyboard binding table — the single registry of "key → command" for the
 * canvas. Built entirely from the (rebindable) ShortcutsConfig — tool/sub-tool
 * letters (TOOL_BINDINGS) and pan/zoom keys — with only Esc/Enter fixed. The whole
 * keyboard surface is data, not an if/else ladder; the dispatcher does the matching.
 *
 * Order matters: the first binding whose `codes` include the event and whose
 * `when` guard passes wins. Esc-cancels-draw-tool is listed before
 * Esc-finishes-path to preserve the existing precedence.
 */

import type { Command, CommandCtx } from './commands'
import { runCommand } from './commands'
import type { CanvasActorRef } from '../machine/canvas-actor-types'
import type { ShortcutsConfig } from '../types'

type Snapshot = ReturnType<CanvasActorRef['getSnapshot']>

export interface KeyBinding {
  /** Physical `KeyboardEvent.code`s this binding matches (layout-independent). */
  codes: string[]
  /** Require no Ctrl/Meta/Alt held (Shift allowed) — for bare tool letters. */
  bareOnly?: boolean
  /** Skip while typing in an input / textarea / contentEditable. */
  notInInput?: boolean
  /** State guard; binding only fires when this returns true. */
  when?: (snap: Snapshot) => boolean
  command: Command
  /** Call preventDefault when matched (default true). */
  preventDefault?: boolean
}

const hasDrawTool = (s: Snapshot) => s.context.drawTool != null
const inPathEditing = (s: Snapshot) => s.matches('pathEditing')

export type ToolKeyField =
  | 'selectKey'
  | 'penKey'
  | 'rectKey'
  | 'frameKey'
  | 'textKey'
  | 'pathMoveKey'
  | 'pathAddKey'
  | 'pathBendKey'

export interface ToolBindingDesc {
  /** ShortcutsConfig field holding this binding's key code. */
  field: ToolKeyField
  command: Command
  label: string
  category: 'Tools' | 'Path editing'
  /** Only active while editing a path. */
  pathOnly?: boolean
}

/** The rebindable tool / sub-tool keys — the single source for both the binding
 *  table (above) and the Settings rebind UI (label/category live here). */
export const TOOL_BINDINGS: ToolBindingDesc[] = [
  { field: 'selectKey', command: { type: 'TOOL_SELECT' }, label: 'Select tool', category: 'Tools' },
  { field: 'penKey', command: { type: 'TOOL_TOGGLE', tool: 'pen' }, label: 'Pen tool', category: 'Tools' },
  { field: 'rectKey', command: { type: 'TOOL_TOGGLE', tool: 'rect' }, label: 'Rectangle tool', category: 'Tools' },
  { field: 'frameKey', command: { type: 'TOOL_TOGGLE', tool: 'frame' }, label: 'Frame tool', category: 'Tools' },
  { field: 'textKey', command: { type: 'TOOL_TOGGLE', tool: 'text' }, label: 'Text tool', category: 'Tools' },
  { field: 'pathMoveKey', command: { type: 'PATH_SUBTOOL', sub: 'move' }, label: 'Move points', category: 'Path editing', pathOnly: true },
  { field: 'pathAddKey', command: { type: 'PATH_SUBTOOL', sub: 'add' }, label: 'Add points', category: 'Path editing', pathOnly: true },
  { field: 'pathBendKey', command: { type: 'PATH_SUBTOOL', sub: 'bend' }, label: 'Bend points', category: 'Path editing', pathOnly: true },
]

/** Build the binding list for the active shortcut config. The tool / sub-tool
 *  letters come from TOOL_BINDINGS (rebindable via ShortcutsConfig); pan/zoom keys
 *  from the config directly; Esc/Enter stay fixed. */
export function buildKeyBindings(s: ShortcutsConfig): KeyBinding[] {
  return [
    // Esc cancels an armed draw tool first (matches prior handler order), then
    // Esc/Enter finishes a path edit.
    { codes: ['Escape'], when: hasDrawTool, command: { type: 'DRAW_CANCEL' } },
    { codes: ['Escape', 'Enter', 'NumpadEnter'], when: inPathEditing, command: { type: 'PATH_FINISH' } },

    // Tool + path sub-tool letters, from the rebindable config (see TOOL_BINDINGS).
    ...TOOL_BINDINGS.map((tb): KeyBinding => ({
      codes: [s[tb.field]],
      bareOnly: true,
      notInInput: true,
      ...(tb.pathOnly ? { when: inPathEditing } : {}),
      command: tb.command,
    })),

    // Viewport pan / zoom / reset (rebindable via ShortcutsConfig).
    { codes: [s.panLeft], command: { type: 'PAN', dx: 1, dy: 0 } },
    { codes: [s.panRight], command: { type: 'PAN', dx: -1, dy: 0 } },
    { codes: [s.panUp], command: { type: 'PAN', dx: 0, dy: 1 } },
    { codes: [s.panDown], command: { type: 'PAN', dx: 0, dy: -1 } },
    { codes: s.zoomInKeys, command: { type: 'ZOOM_IN' } },
    { codes: s.zoomOutKeys, command: { type: 'ZOOM_OUT' } },
    { codes: s.resetKeys, command: { type: 'ZOOM_RESET' } },
  ]
}

function inInputField(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return el?.closest('input, textarea, select, [contenteditable="true"]') != null
}

/** Find and run the first matching binding. Returns true if one handled the event. */
export function dispatchKey(e: KeyboardEvent, bindings: KeyBinding[], ctx: CommandCtx): boolean {
  const snap = ctx.actor.getSnapshot()
  const typing = inInputField(e)
  for (const b of bindings) {
    if (!b.codes.includes(e.code)) continue
    if (b.bareOnly && (e.ctrlKey || e.metaKey || e.altKey)) continue
    if (b.notInInput && typing) continue
    if (b.when && !b.when(snap)) continue
    if (b.preventDefault !== false) e.preventDefault()
    runCommand(b.command, ctx)
    return true
  }
  return false
}
