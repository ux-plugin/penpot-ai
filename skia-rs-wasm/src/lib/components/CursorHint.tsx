import type { ComponentType } from 'react'
import { useSelector } from '@xstate/react'
import { Circle, Hexagon, Plus, Star, Triangle, Type } from 'lucide-react'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import type { DrawTool } from '../renderer/machine/canvas-machine'
import { pointerOverChrome, pointerPos } from '../renderer/signals/pointer'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { IconFrame, IconRect } from './shape-icons'

export type HintIcon = ComponentType<{ className?: string }>

/**
 * Shared presentation for the cursor hint: a small icon badge that trails the
 * pointer showing the current intention as an icon only (no text). `x`/`y` are
 * canvas-relative px (the same space as `pointerPos`), so it must render inside
 * the canvas overlay container.
 */
export function CursorHintChip({ x, y, icon: Icon }: { x: number; y: number; icon: HintIcon }) {
  // The chip is canvas-only; pointerPos updates globally, so hide it whenever the
  // pointer is over the side panels / toolbars (it was painting on top of them).
  const overChrome = useSignalCoalesced(pointerOverChrome)
  if (overChrome) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[55]" aria-hidden>
      <span
        className="absolute left-0 top-0 inline-flex items-center justify-center rounded-md border border-border/80 bg-white p-1 text-neutral-700 shadow-md"
        style={{ transform: `translate(${x + 14}px, ${y + 18}px)` }}
      >
        <Icon className="size-4 shrink-0 stroke-[1.5]" />
      </span>
    </div>
  )
}

/**
 * Icon for each armed draw tool. The pen gets its own canvas cursor (a pen
 * nib), so its hint shows the action it performs (add a point) rather than a
 * second pen glyph; every other tool keeps the OS arrow and is identified by
 * its toolbar icon here.
 */
const TOOL_ICONS: Record<DrawTool, HintIcon> = {
  rect: IconRect,
  ellipse: Circle,
  triangle: Triangle,
  polygon: Hexagon,
  star: Star,
  frame: IconFrame,
  text: Type,
  pen: Plus,
}

/**
 * Hint shown while a draw tool is armed (shapes, frame, text, pen). The canvas
 * cursor itself is set to match the tool by the viewport-interaction layer
 * (which owns the pointer-sink surface). Vector-edit intentions (add / move
 * vertex, …) are handled separately by the path editor.
 */
export function CursorHint() {
  const canvasActor = useCanvasActor()
  const drawTool = useSelector(canvasActor, (s) => s.context.drawTool)
  const isPathEditing = useSelector(canvasActor, (s) => s.matches('pathEditing'))
  if (isPathEditing || !drawTool) return null
  return <DrawToolHint tool={drawTool} />
}

function DrawToolHint({ tool }: { tool: DrawTool }) {
  // pointerPos is canvas-relative (clientX/Y minus the canvas rect). The chip
  // overlay shares that origin, so the value maps straight to a position.
  const pos = useSignalCoalesced(pointerPos)
  const icon = TOOL_ICONS[tool]
  if (!pos || !icon) return null
  return <CursorHintChip x={pos.x} y={pos.y} icon={icon} />
}
