/**
 * Single source of truth for the vector-edit interaction (Phase A of the
 * path-editing redesign). Given the active sub-tool, the live modifiers, and what
 * the overlay's hit-test found under the cursor, it resolves ONE `mode` and the
 * cursor / hint / capture / ghost that follow from it — so the toolbar highlight,
 * the canvas cursor, the hint chip, and the pen's event capture can never disagree
 * (the bug class we kept hitting, e.g. the add-dot leaking through a Shift-pan).
 *
 * Precedence — top wins:
 *   1. pan      (pan modifier / space held) — preempts the tool entirely
 *   2. drag     (a gesture already in flight) — suppress hover affordances
 *   3. modifier (Alt, from ANY sub-tool incl. Add) — transient bend
 *   4. hover    (node / edge / empty)
 *   5. sub-tool (move / add / bend)
 *
 * Pure and unit-tested — no React, no signals. Consumers pass plain inputs.
 */

import { Link2, Move, Plus, Spline } from 'lucide-react'
import type { HintIcon } from '../CursorHint'
import { PEN_CURSOR, SELECT_CURSOR } from '../cursors'
import type { PathSubTool } from '../../renderer/machine/canvas-machine'

// The sub-tool enum is owned by the machine (it's a context value); re-exported
// here so the resolver and its consumers have one import site.
export type { PathSubTool }

/** What the overlay's hit-test found under the cursor. */
export type PathHover = 'node' | 'node-target' | 'edge' | 'empty'

export type PathMode = 'pan' | 'move' | 'bend' | 'add-edge' | 'add-free' | 'connect' | 'idle'

export interface PathInteractionInput {
  subTool: PathSubTool
  panHeld: boolean
  altHeld: boolean
  hover: PathHover
  /** A gesture is already in flight — suppress hover affordances (hint + ghost). */
  dragging?: boolean
}

export interface PathResolved {
  mode: PathMode
  cursor: string
  /** Hint-chip icon, or null when no hint should show. */
  hint: HintIcon | null
  /** Whether the Add tool's full-canvas / edge capture should be live. */
  capture: boolean
  /** Whether to draw the add-point ghost dot. */
  ghost: boolean
}

/** The sub-tool the user effectively has, with Alt as a transient bend override
 *  from ANY base tool (Move/Add/Bend + Alt ⇒ Bend). Used for the toolbar
 *  highlight, so the lit sub-tool follows Alt the moment it's held. */
export function effectiveSubTool(subTool: PathSubTool, altHeld: boolean): PathSubTool {
  return altHeld ? 'bend' : subTool
}

function resolveMode(i: PathInteractionInput): PathMode {
  if (i.panHeld) return 'pan'
  // Alt is a transient Bend override from any sub-tool (incl. Add): over a node
  // it bends; over empty/edge there's nothing to bend, so it idles — which also
  // suppresses the Add ghost, so Add + Alt clearly reads as "bend", not "add".
  if (i.altHeld) {
    return i.hover === 'node' || i.hover === 'node-target' ? 'bend' : 'idle'
  }
  if (i.subTool === 'add') {
    if (i.hover === 'node-target') return 'connect'
    if (i.hover === 'edge') return 'add-edge'
    return 'add-free'
  }
  if (i.subTool === 'bend' && i.hover === 'node') return 'bend'
  if (i.hover === 'node') return 'move'
  return 'idle'
}

const CURSOR: Record<PathMode, string> = {
  pan: 'grab',
  move: SELECT_CURSOR,
  bend: SELECT_CURSOR,
  idle: SELECT_CURSOR,
  'add-edge': PEN_CURSOR,
  'add-free': PEN_CURSOR,
  connect: PEN_CURSOR,
}

const HINT: Record<PathMode, HintIcon | null> = {
  pan: null,
  idle: null,
  move: Move,
  bend: Spline,
  'add-edge': Plus,
  'add-free': Plus,
  connect: Link2,
}

export function resolvePathInteraction(i: PathInteractionInput): PathResolved {
  const mode = resolveMode(i)
  const isAdd = mode === 'add-edge' || mode === 'add-free' || mode === 'connect'
  return {
    mode,
    cursor: CURSOR[mode],
    hint: i.dragging ? null : HINT[mode],
    capture: isAdd,
    ghost: !i.dragging && (mode === 'add-edge' || mode === 'add-free'),
  }
}
