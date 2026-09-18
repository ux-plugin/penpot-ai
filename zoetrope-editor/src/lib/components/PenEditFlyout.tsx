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

import { useEffect, useRef, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import { Check, ChevronDown, MousePointer2, Plus, Spline, UnfoldVertical } from 'lucide-react'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import { modAlt } from '../renderer/signals/pointer'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { docProxy } from '../renderer/store/doc-proxy'
import { getCommittedNodeOnActivePage } from '../renderer/properties/commit-node-properties'
import type { StrokeWithSettings } from '../renderer/stroke-settings'
import { effectiveSubTool } from './Overlay/path-interaction'
import {
  WIDTH_MODES,
  WIDTH_MODE_COLOR,
  WIDTH_MODE_HINT,
  WIDTH_MODE_LABEL,
  widthEditActions,
  widthEditState,
  type WidthMode,
} from './Overlay/width-edit-bridge'
import { cn } from '@/lib/utils'

/** The mode's colour dot (mirrors the on-canvas width dots). */
function ModeIcon({ mode, className }: { mode: WidthMode; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: WIDTH_MODE_COLOR[mode] }}
    />
  )
}

export function PenEditFlyout() {
  const actor = useCanvasActor()
  const subTool = useSelector(actor, (s) => s.context.pathSubTool)
  // Variable width is a stroke property any stroke can hold — enable Width whenever
  // there's a stroke.
  const shapeId = useSelector(actor, (s) => s.context.pathEditingShapeId)
  useSnapshot(docProxy)
  const stroke0 = shapeId
    ? (getCommittedNodeOnActivePage(shapeId) as { strokes?: StrokeWithSettings[] } | null)?.strokes?.[0]
    : undefined
  const widthCapable = !!stroke0
  // Alt is the bend shortcut: while held in Move it bends, so the lit tool follows
  // it (and snaps back to Move on release). The resolver owns that rule.
  const altDown = useSignalCoalesced(modAlt)
  const eff = effectiveSubTool(subTool, !!altDown)
  const inPen = eff === 'add'
  const inBend = eff === 'bend'
  const inMove = eff === 'move'
  const inWidth = eff === 'width'

  const onMove = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'move' })
  const onAdd = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
  const onBend = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'bend' })
  const onWidth = () => actor.send({ type: 'PATH_SET_SUBTOOL', subTool: 'width' })
  const onDone = () => actor.send({ type: 'STOP_PATH_EDIT' })

  // Per-point interpolation mode for the selected width point. The overlay owns
  // the geometry and publishes the selection here; this is a thin control.
  const wes = useSnapshot(widthEditState)
  const showModePicker = inWidth && wes.active && wes.selectedIdx >= 0 && !!wes.mode
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)
  // Derive the open state so it closes for free when the selection goes away
  // (tool switch, deselect) — no reset effect needed.
  const menuOpen = modeMenuOpen && showModePicker
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!modeRef.current?.contains(e.target as Node)) setModeMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [menuOpen])

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
        <button
          type="button"
          onClick={onWidth}
          disabled={!widthCapable}
          aria-pressed={inWidth}
          title={
            widthCapable
              ? 'Width — drag the stroke to sculpt it (Alt-drag for one side · double-click or Delete to remove a point)'
              : 'Width needs a stroke'
          }
          className={cn(seg(inWidth), !widthCapable && 'cursor-not-allowed opacity-40 hover:bg-transparent')}
        >
          <UnfoldVertical className="size-4 shrink-0 stroke-[1.5]" />
          <span>Width</span>
        </button>
        {showModePicker && wes.mode && (
          <>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border/70" />
            <div ref={modeRef} className="relative">
              <button
                type="button"
                onClick={() => setModeMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Interpolation of the segment leaving this point"
                className="flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-muted/40 px-2.5 text-xs text-foreground hover:bg-muted"
              >
                <span className="text-[11px] text-muted-foreground">Point</span>
                <ModeIcon mode={wes.mode} />
                <span>{WIDTH_MODE_LABEL[wes.mode]}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 mb-1.5 min-w-[168px] rounded-lg border border-border/80 bg-white p-1 shadow-md"
                >
                  {WIDTH_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        widthEditActions.setMode?.(m)
                        setModeMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-foreground hover:bg-muted"
                    >
                      <ModeIcon mode={m} />
                      <span>{WIDTH_MODE_LABEL[m]}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{WIDTH_MODE_HINT[m]}</span>
                      {m === wes.mode && <Check className="size-3.5 shrink-0 text-blue-600" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
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
