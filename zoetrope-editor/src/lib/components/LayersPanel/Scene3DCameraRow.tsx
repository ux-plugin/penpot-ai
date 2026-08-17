import { Video, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A camera nested under its 3D scene's "Cameras" group in the Layers tree. Like
 * Scene3DObjectRow, a lightweight non-document row.
 *
 * Layout mirrors a layer's visibility toggle: a camera icon on the LEFT, the name, and
 * the look-through EYE on the RIGHT. The eye is the active indicator, but it only reads
 * as ACTIVE (solid indigo) on the scene currently being edited (`sceneEditing`) — so at
 * most one camera in the whole tree shows the active state, never one per scene. On any
 * other scene the eye is faint (still clickable to look through).
 *
 * The row background is the SELECTED (being-edited) camera, styled like a focused
 * object so "the selected thing in this scene" reads consistently whether it's a mesh
 * or a camera. Selecting a camera and focusing an object are mutually exclusive.
 */
export function Scene3DCameraRow({
  name,
  depth,
  active,
  sceneEditing,
  selected,
  onSelect,
  onLookThrough,
}: {
  name: string
  depth: number
  active: boolean
  sceneEditing: boolean
  selected: boolean
  onSelect: () => void
  onLookThrough: () => void
}) {
  const activeHere = active && sceneEditing
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      className={cn(
        'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors',
        selected
          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
          : 'text-foreground hover:bg-muted/60',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <Video className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <button
        type="button"
        title={active ? 'Looking through this camera' : 'Look through'}
        aria-label={active ? 'Active camera' : 'Look through camera'}
        onClick={(e) => {
          e.stopPropagation()
          onLookThrough()
        }}
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded',
          activeHere
            ? 'text-indigo-600 dark:text-indigo-300'
            : 'text-muted-foreground/30 hover:text-foreground',
        )}
      >
        <Eye className="size-3.5" />
      </button>
    </div>
  )
}
