/**
 * Bottom pill tool strip for creation tools (reference editor UI).
 * Closed shapes (rect/ellipse/triangle/polygon/star) collapse into one menu
 * whose face shows the last-used shape; the pen tool collapses into its own menu
 * of pen sub-tools. Each collapsible tool shows a small caret ABOVE its icon that
 * opens a flyout growing upward. Extend `DrawTool` in canvas-machine when adding
 * new shape icons.
 */

import { useCallback, useState, type ComponentType, type ReactNode } from 'react'
import { useSelector } from '@xstate/react'
import {
  Box,
  Check,
  ChevronUp,
  Circle,
  Hexagon,
  Image,
  MessageCircle,
  MousePointer2,
  PenTool,
  Pencil,
  Star,
  Triangle,
  Type,
} from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import type { DrawTool } from '../renderer/machine/canvas-machine'
import { create3DScene } from '../renderer/three/create-3d-scene'
import { setFocusedObject } from '../renderer/three/scene3d-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { IconFrame, IconRect } from './shape-icons'
import { PenEditFlyout } from './PenEditFlyout'
import { Scene3DEditMenu } from './Scene3DEditMenu'

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

/**
 * A tool whose icon carries a small caret ABOVE it; the caret opens a flyout that
 * grows upward. The face button still activates the tool directly (one click); the
 * caret is a separate, smaller hit-target for the sub-tool menu.
 */
function CollapsibleTool({
  FaceIcon,
  facePressed,
  onFace,
  faceTitle,
  flyoutTitle,
  open,
  onOpenChange,
  children,
  dim = false,
  flyout,
}: {
  FaceIcon: IconComponent
  facePressed: boolean
  onFace: () => void
  faceTitle: string
  flyoutTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  /** Greyed + inert (used to recede the other tools while a path is being edited). */
  dim?: boolean
  /** When set, replaces the caret sub-menu with this node (e.g. the Pen's
   *  liquid-glass edit flyout). The face stays as the anchor it grows from. */
  flyout?: ReactNode
}) {
  return (
    <li>
      <div className="relative">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'h-10 w-10 rounded-full text-muted-foreground hover:bg-transparent',
            dim && 'pointer-events-none opacity-40 grayscale',
          )}
          title={faceTitle}
          aria-label={faceTitle}
          aria-pressed={facePressed}
          onClick={onFace}
        >
          {/* Highlight only the icon (a circle), not the whole button — so the
              caret above stays on the neutral pill and never looks selected. */}
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-full',
              facePressed
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200'
                : 'hover:bg-muted',
            )}
          >
            <FaceIcon className="size-5 shrink-0 stroke-[1.5]" />
          </span>
        </Button>
        {/* The caret sub-menu is suppressed whenever a flyout takes its place. */}
        {!flyout && (
          <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <PopoverPrimitive.Trigger asChild>
              <button
                type="button"
                title={flyoutTitle}
                aria-label={flyoutTitle}
                className={cn(
                  'absolute left-1/2 top-0 flex h-3.5 w-6 -translate-x-1/2 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground',
                  dim && 'pointer-events-none opacity-40',
                )}
              >
                <ChevronUp className="size-3 shrink-0" />
              </button>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                side="top"
                sideOffset={12}
                align="center"
                className="z-[70] min-w-[176px] rounded-xl border border-border/80 bg-white p-1 shadow-md"
              >
                {children}
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        )}
        {flyout}
      </div>
    </li>
  )
}

export function ShapeToolbar() {
  const canvasActor = useCanvasActor()
  const drawTool = useSelector(canvasActor, (s) => s.context.drawTool)
  // While a path node is being edited the strip collapses to a single context:
  // every tool but the Pen greys out, and the Pen grows its liquid-glass submenu.
  const editing = useSelector(canvasActor, (s) => s.matches('pathEditing'))
  // 3D-scene edit mode collapses the strip the same way: tools recede and the
  // contextual 3D menu sits above the pill (Scene3DEditMenu).
  const scene3dEditing = useSelector(canvasActor, (s) => s.matches('scene3dEditing'))
  // The shape the menu face currently shows (the last shape the user picked).
  const [lastShapeTool, setLastShapeTool] = useState<DrawTool>('rect')
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const [penMenuOpen, setPenMenuOpen] = useState(false)

  const onSelect = useCallback(() => {
    canvasActor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
  }, [canvasActor])

  const toggleDrawTool = useCallback(
    (tool: DrawTool) => {
      const active = canvasActor.getSnapshot().context.drawTool === tool
      if (active) {
        canvasActor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
      } else {
        canvasActor.send({ type: 'DRAW_TOOL_ACTIVATE', tool })
      }
    },
    [canvasActor],
  )

  const onFrame = useCallback(() => toggleDrawTool('frame'), [toggleDrawTool])
  const onText = useCallback(() => toggleDrawTool('text'), [toggleDrawTool])
  const onPen = useCallback(() => toggleDrawTool('pen'), [toggleDrawTool])
  const onAdd3D = useCallback(() => {
    void create3DScene().then((id) => {
      if (!id) return
      canvasActor.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: id })
      setFocusedObject(null)
    })
  }, [canvasActor])

  // Pick a shape from the menu: always activate it (not toggle), remember it as
  // the menu face, and close the popover.
  const selectShape = useCallback(
    (tool: DrawTool) => {
      setLastShapeTool(tool)
      canvasActor.send({ type: 'DRAW_TOOL_ACTIVATE', tool })
      setShapeMenuOpen(false)
    },
    [canvasActor],
  )

  const selectPen = useCallback(() => {
    canvasActor.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'pen' })
    setPenMenuOpen(false)
  }, [canvasActor])

  // While editing a path (or a 3D scene), every other tool recedes (greyed +
  // inert) so the single active context is unmistakable.
  const dimEdit = (editing || scene3dEditing) && 'pointer-events-none opacity-40 grayscale'

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
          dimEdit,
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
        className={cn('h-10 w-10 rounded-full text-muted-foreground/50', dimEdit)}
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
      className="pointer-events-auto fixed bottom-6 left-1/2 z-60 flex -translate-x-1/2 flex-col items-center gap-2"
      aria-label="Shape tools"
    >
      {/* Contextual 3D menu, above the strip — like the pen's edit flyout. */}
      <Scene3DEditMenu />
      <ul className="flex list-none flex-row items-center gap-0.5 rounded-full border border-border/80 bg-white px-2 py-1.5 shadow-md">
        {toolBtn(drawTool == null, onSelect, 'Select and move', <MousePointer2 className="size-5 shrink-0 stroke-[1.5]" />)}
        {toolBtn(drawTool === 'frame', onFrame, 'Draw frame (F)', <IconFrame className="shrink-0" />)}

        {/* Collapsible shape menu: the face activates the last-used shape; the
            caret above it opens the list of all closed shapes. */}
        <CollapsibleTool
          FaceIcon={FaceIcon}
          facePressed={shapeActive}
          onFace={() => toggleDrawTool(lastShapeTool)}
          faceTitle={`Draw ${faceLabel}`}
          flyoutTitle="More shapes"
          open={shapeMenuOpen && !editing}
          onOpenChange={setShapeMenuOpen}
          dim={editing}
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
        </CollapsibleTool>

        {/* Collapsible pen menu: the face activates the pen; the caret above it
            opens the pen sub-tools, growing upward. */}
        <CollapsibleTool
          FaceIcon={PenTool}
          facePressed={!editing && drawTool === 'pen'}
          onFace={editing ? () => {} : onPen}
          faceTitle="Pen — click for corners, drag for curves; Esc/Enter to finish (P)"
          flyoutTitle="Pen tools"
          open={penMenuOpen && !editing}
          onOpenChange={setPenMenuOpen}
          flyout={editing ? <PenEditFlyout /> : undefined}
        >
          <button
            type="button"
            onClick={selectPen}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted',
              drawTool === 'pen' && 'text-blue-700',
            )}
          >
            <PenTool className="size-4 shrink-0 stroke-[1.5]" />
            <span className="flex-1 text-left">Pen</span>
            {drawTool === 'pen' && <Check className="size-3.5 shrink-0" />}
          </button>
          <button
            type="button"
            disabled
            title={placeholderTitle}
            className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground/50"
          >
            <Pencil className="size-4 shrink-0 stroke-[1.5]" />
            <span className="flex-1 text-left">Pencil</span>
            <span className="text-[10px] uppercase tracking-wide">Soon</span>
          </button>
        </CollapsibleTool>

        {toolBtn(
          drawTool === 'text',
          onText,
          'Draw text (T)',
          <Type className="size-5 shrink-0 stroke-[1.5]" />,
        )}
        {toolBtn(false, onAdd3D, 'Add 3D scene', <Box className="size-5 shrink-0 stroke-[1.5]" />)}
        {disabledTool('Image', Image)}
        {disabledTool('Comment', MessageCircle)}
      </ul>
    </aside>
  )
}
