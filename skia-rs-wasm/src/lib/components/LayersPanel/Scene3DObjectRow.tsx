import { Box } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A 3D object nested under its scene in the Layers tree. 3D objects aren't
 * document nodes (they live in scene3dProxy), so this is a lightweight row — no
 * drag/reparent — that enters the scene's 3D-edit mode focused on the object.
 */
export function Scene3DObjectRow({
  name,
  depth,
  focused,
  onClick,
}: {
  name: string
  depth: number
  focused: boolean
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors',
        focused
          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
          : 'text-foreground hover:bg-muted/60',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <Box className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </div>
  )
}
