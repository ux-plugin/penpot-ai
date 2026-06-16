/**
 * Bottom pill tool strip for creation tools (reference editor UI).
 * Closed shapes (rect/ellipse/triangle/polygon/star) collapse into one menu
 * whose face shows the last-used shape; Line is kept as its own button.
 * Extend `DrawTool` in canvas-machine when adding new shape icons.
 */

import { useCallback, useState, type ComponentType, type ReactNode } from 'react'
import { useSelector } from '@xstate/react'
import {
  Check,
  ChevronUp,
  Circle,
  Hexagon,
  Image,
  MessageCircle,
  Minus,
  Pencil,
  Star,
  Triangle,
  Type,
} from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import type { DrawTool } from '../renderer/machine/canvas-machine'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { IconFrame, IconRect, IconSelect } from './shape-icons'

const placeholderTitle = 'Coming soon'

type IconComponent = ComponentType<{ className?: string }>

/** Closed shapes collapsed into the shape menu. `tool` is the matching DrawTool. */
const SHAPE_TOOLS: { tool: DrawTool; label: string; Icon: IconComponent }[] = [
  { tool: 'rect', label: 'Rectangle', Icon: IconRect },
  { tool: 'ellipse', label: 'Ellipse', Icon: Circle },
  { tool: 'triangle', label: 'Triangle', Icon: Triangle },
  { tool: 'polygon', label: 'Polygon', Icon: Hexagon },
  { tool: 'star', label: 'Star', Icon: Star },
]

export function ShapeToolbar() {
  const canvasActor = useCanvasActor()
  const drawTool = useSelector(canvasActor, (s) => s.context.drawTool)
  // The shape the menu face currently shows (the last shape the user picked).
  const [lastShapeTool, setLastShapeTool] = useState<DrawTool>('rect')
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)

  const syncCanvasCursor = useCallback((tool: DrawTool | null) => {
    const canvas = document.querySelector('.canvas-container canvas') as HTMLCanvasElement | null
    if (canvas) canvas.style.cursor = tool != null ? 'crosshair' : 'default'
  }, [])

  const onSelect = useCallback(() => {
    canvasActor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
    syncCanvasCursor(null)
  }, [canvasActor, syncCanvasCursor])

  const toggleDrawTool = useCallback(
    (tool: DrawTool) => {
      const active = canvasActor.getSnapshot().context.drawTool === tool
      if (active) {
        canvasActor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
        syncCanvasCursor(null)
      } else {
        canvasActor.send({ type: 'DRAW_TOOL_ACTIVATE', tool })
        syncCanvasCursor(tool)
      }
    },
    [canvasActor, syncCanvasCursor],
  )

  const onFrame = useCallback(() => toggleDrawTool('frame'), [toggleDrawTool])
  const onText = useCallback(() => toggleDrawTool('text'), [toggleDrawTool])
  const onLine = useCallback(() => toggleDrawTool('line'), [toggleDrawTool])

  // Pick a shape from the menu: always activate it (not toggle), remember it as
  // the menu face, and close the popover.
  const selectShape = useCallback(
    (tool: DrawTool) => {
      setLastShapeTool(tool)
      canvasActor.send({ type: 'DRAW_TOOL_ACTIVATE', tool })
      syncCanvasCursor(tool)
      setShapeMenuOpen(false)
    },
    [canvasActor, syncCanvasCursor],
  )

  const toolBtn = (
    pressed: boolean,
    onClick: () => void,
    label: string,
    children: ReactNode,
  ) => (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'h-10 w-10 rounded-full text-muted-foreground',
          pressed && 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-200',
        )}
        title={label}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </Button>
    </li>
  )

  const disabledTool = (label: string, Icon: IconComponent) => (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-10 w-10 rounded-full text-muted-foreground/50"
        disabled
        title={placeholderTitle}
        aria-label={label}
      >
        <Icon className="size-5 shrink-0 stroke-[1.5]" />
      </Button>
    </li>
  )

  const shapeActive = drawTool === lastShapeTool
  const faceEntry = SHAPE_TOOLS.find((s) => s.tool === lastShapeTool) ?? SHAPE_TOOLS[0]
  const FaceIcon = faceEntry.Icon
  const faceLabel = faceEntry.label.toLowerCase()

  return (
    <aside
      className="pointer-events-auto fixed bottom-6 left-1/2 z-60 -translate-x-1/2"
      aria-label="Shape tools"
    >
      <ul className="flex list-none flex-row items-center gap-0.5 rounded-full border border-border/80 bg-white px-2 py-1.5 shadow-md">
        {toolBtn(drawTool == null, onSelect, 'Select and move', <IconSelect className="shrink-0" />)}
        {toolBtn(drawTool === 'frame', onFrame, 'Draw frame (F)', <IconFrame className="shrink-0" />)}

        {/* Collapsible shape menu: the face activates the last-used shape; the
            chevron opens the list of all closed shapes. */}
        <li>
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'h-10 w-10 rounded-full text-muted-foreground',
                shapeActive &&
                  'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-200',
              )}
              title={`Draw ${faceLabel}`}
              aria-label={`Draw ${faceLabel}`}
              aria-pressed={shapeActive}
              onClick={() => toggleDrawTool(lastShapeTool)}
            >
              <FaceIcon className="size-5 shrink-0 stroke-[1.5]" />
            </Button>
            <PopoverPrimitive.Root open={shapeMenuOpen} onOpenChange={setShapeMenuOpen}>
              <PopoverPrimitive.Trigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-5 rounded-full px-0 text-muted-foreground"
                  title="More shapes"
                  aria-label="More shapes"
                >
                  <ChevronUp className="size-3 shrink-0" />
                </Button>
              </PopoverPrimitive.Trigger>
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Content
                  side="top"
                  sideOffset={10}
                  align="center"
                  className="z-[70] min-w-[176px] rounded-xl border border-border/80 bg-white p-1 shadow-md"
                >
                  {SHAPE_TOOLS.map(({ tool, label, Icon }) => (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => selectShape(tool)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted',
                        drawTool === tool && 'text-blue-700',
                      )}
                    >
                      <Icon className="size-4 shrink-0 stroke-[1.5]" />
                      <span className="flex-1 text-left">{label}</span>
                      {tool === lastShapeTool && <Check className="size-3.5 shrink-0" />}
                    </button>
                  ))}
                </PopoverPrimitive.Content>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          </div>
        </li>

        {toolBtn(
          drawTool === 'line',
          onLine,
          'Draw line (L)',
          <Minus className="size-5 shrink-0 stroke-[1.5]" />,
        )}
        {disabledTool('Draw', Pencil)}
        {toolBtn(
          drawTool === 'text',
          onText,
          'Draw text (T)',
          <Type className="size-5 shrink-0 stroke-[1.5]" />,
        )}
        {disabledTool('Image', Image)}
        {disabledTool('Comment', MessageCircle)}
      </ul>
    </aside>
  )
}
