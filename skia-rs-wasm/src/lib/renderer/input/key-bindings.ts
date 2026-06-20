/**
 * The keyboard binding table — the single registry of "key → command" for the
 * canvas. Built from the (rebindable) ShortcutsConfig plus the fixed tool letters,
 * so the whole keyboard surface is data, not a hand-written if/else ladder. A new
 * shortcut is one row here; the dispatcher (`dispatchKey`) does the matching.
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

/** Build the binding list for the active shortcut config. Tool letters (V/P/R/F/T
 *  and the M/A/B path sub-tools) are defaults here until a settings page lets the
 *  user rebind them — at which point they move into ShortcutsConfig too. */
export function buildKeyBindings(s: ShortcutsConfig): KeyBinding[] {
  return [
    // Esc cancels an armed draw tool first (matches prior handler order), then
    // Esc/Enter finishes a path edit.
    { codes: ['Escape'], when: hasDrawTool, command: { type: 'DRAW_CANCEL' } },
    { codes: ['Escape', 'Enter', 'NumpadEnter'], when: inPathEditing, command: { type: 'PATH_FINISH' } },

    // Tool letters (bare, not while typing).
    { codes: ['KeyV'], bareOnly: true, notInInput: true, command: { type: 'TOOL_SELECT' } },
    { codes: ['KeyP'], bareOnly: true, notInInput: true, command: { type: 'TOOL_TOGGLE', tool: 'pen' } },
    { codes: ['KeyR'], bareOnly: true, notInInput: true, command: { type: 'TOOL_TOGGLE', tool: 'rect' } },
    { codes: ['KeyF'], bareOnly: true, notInInput: true, command: { type: 'TOOL_TOGGLE', tool: 'frame' } },
    { codes: ['KeyT'], bareOnly: true, notInInput: true, command: { type: 'TOOL_TOGGLE', tool: 'text' } },

    // Path sub-tools — only while editing a path.
    { codes: ['KeyM'], bareOnly: true, notInInput: true, when: inPathEditing, command: { type: 'PATH_SUBTOOL', sub: 'move' } },
    { codes: ['KeyA'], bareOnly: true, notInInput: true, when: inPathEditing, command: { type: 'PATH_SUBTOOL', sub: 'add' } },
    { codes: ['KeyB'], bareOnly: true, notInInput: true, when: inPathEditing, command: { type: 'PATH_SUBTOOL', sub: 'bend' } },

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
