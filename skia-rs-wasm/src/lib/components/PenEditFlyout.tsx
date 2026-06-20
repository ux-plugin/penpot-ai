/**
 * Path-editing submenu. A normal popover-style menu that sits above the Pen tool
 * in ShapeToolbar (the tool it belongs to), shown only while the canvas machine is
 * in `pathEditing`. One sub-tool is active at a time; it's a context value, set via
 * one event:
 *   Move/Add/Bend → PATH_SET_SUBTOOL   Done → STOP_PATH_EDIT
 *
 * The icons mirror what the user sees on the canvas: Move uses the select-arrow
 * (the move cursor), Add uses the plus (the pen add-anchor hint), Bend uses the
 * spline (the bend hint) — see cursors.ts and CursorHint.tsx. Bend is also the
 * Alt-drag shortcut, surfaced here as a sticky tool.
 */

import { useSelector } from '@xstate/react'
import { Check, MousePointer2, Plus, Spline } from 'lucide-react'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import { modAlt } from '../renderer/signals/pointer'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { effectiveSubTool } from './Overlay/path-interaction'
import { cn } from '@/lib/utils'

export function PenEditFlyout() {
  const actor = useCanvasActor()
  const subTool = useSelector(actor, (s) => s.context.pathSubTool)
  // Alt is the bend shortcut: while held in Move it bends, so the lit tool follows
  // it (and snaps back to Move on release). The resolver owns that rule.
  const altDown = useSignalCoalesced(modAlt)
  const eff = effectiveSubTool(subTool, !!altDown)
  const inPen = eff === 'add'
  const inBend = eff === 'bend'
  const inMove = eff === 'move'

  const onMove = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'move' })
  const onAdd = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
  const onBend = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'bend' })
  const onDone = () => actor.send({ type: 'STOP_PATH_EDIT' })

  const seg = (active: boolean) =>
    cn(
      'flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs',
      active
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200'
        : 'text-muted-foreground hover:bg-muted',
    )

  return (
    <div className="absolute bottom-full left-1/2 z-[5] mb-5 -translate-x-1/2">
      <div className="relative flex items-center gap-0.5 whitespace-nowrap rounded-full border border-border/80 bg-white p-1 shadow-md">
        <button type="button" onClick={onMove} aria-pressed={inMove} title="Move points" className={seg(inMove)}>
          <MousePointer2 className="size-4 shrink-0 stroke-[1.5]" />
          <span>Move</span>
        </button>
        <button type="button" onClick={onAdd} aria-pressed={inPen} title="Add points" className={seg(inPen)}>
          <Plus className="size-4 shrink-0 stroke-[1.5]" />
          <span>Add</span>
        </button>
        <button type="button" onClick={onBend} aria-pressed={inBend} title="Bend (or Alt-drag a point)" className={seg(inBend)}>
          <Spline className="size-4 shrink-0 stroke-[1.5]" />
          <span>Bend</span>
        </button>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border/70" />
        <button
          type="button"
          onClick={onDone}
          title="Done editing (Esc)"
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted"
        >
          <Check className="size-4 shrink-0 stroke-[1.5]" />
          <span>Done</span>
        </button>
        {/* Caret pointing down at the Pen, so the menu reads as the Pen's. */}
        <span
          aria-hidden
          className="absolute left-1/2 top-full -mt-1 size-2.5 -translate-x-1/2 rotate-45 border-b border-r border-border/80 bg-white"
        />
      </div>
    </div>
  )
}
