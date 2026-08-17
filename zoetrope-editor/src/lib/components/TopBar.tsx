/**
 * Full-width application top bar — three zones:
 *
 *   left   — document / breadcrumb area (reserved; minimal for now)
 *   center — workspace mode switcher, a centered segmented control
 *            (data-driven: extend MODE_TABS to grow it, e.g. Monitor / Study UX,
 *            alongside a new EditorMode + view)
 *   right  — document actions (New, Undo, Redo, Settings)
 *
 * Its height is the `--top-bar-height` var set on the app root, which the canvas
 * and floating rails reserve space for. Tools live in the bottom toolbar, not
 * here; this bar is the document/global surface.
 */

import { Undo2, Redo2, FilePlus2, Settings, Frame, Blocks, Minus, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { undo, redo } from '../page-crud'
import { resetToNewDocument } from '../persistence'
import { editorMode, setEditorMode, type EditorMode } from '../renderer/signals/editor-mode'
import { viewport } from '../renderer/signals/pointer'
import { zoomInAtCenter, zoomOutAtCenter, setZoomLevel } from '../renderer/viewport-zoom'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'

interface ModeTab {
  mode: EditorMode
  label: string
  Icon: LucideIcon
}

/** Single source for the workspace tabs — add an entry (plus a matching
 *  `EditorMode` and view) to grow the switcher. */
const MODE_TABS: ModeTab[] = [
  { mode: 'design', label: 'Design', Icon: Frame },
  { mode: 'build', label: 'Build', Icon: Blocks },
]

/** Compact zoom widget: − / current % / +. The percentage reads the live viewport
 *  zoom and, when clicked, resets to 100%. Zooms about the canvas centre. */
function ZoomControl() {
  const vp = useSignalCoalesced(viewport)
  const pct = Math.round((vp?.zoom ?? 1) * 100)
  return (
    <div className="flex items-center" role="group" aria-label="Zoom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={zoomOutAtCenter}
      >
        <Minus className="size-4" />
      </Button>
      <button
        type="button"
        onClick={() => setZoomLevel(1)}
        title="Reset zoom to 100%"
        aria-label={`Zoom ${pct} percent — click to reset to 100%`}
        className="min-w-[3.25rem] rounded-md px-1 py-1 text-center text-sm font-medium tabular-nums text-foreground hover:bg-muted"
      >
        {pct}%
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={zoomInAtCenter}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  )
}

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mode = useSignalCoalesced(editorMode)
  return (
    <header
      className="pointer-events-auto fixed inset-x-0 top-0 z-80 flex h-(--top-bar-height,2.75rem) items-center justify-between gap-3 border-b border-border/80 bg-white px-2"
      role="banner"
    >
      {/* Left zone — reserved for document name / breadcrumb. */}
      <div className="flex flex-1 items-center gap-2 overflow-hidden" />

      {/* Center zone — workspace mode switcher (segmented control). */}
      <nav
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
        role="tablist"
        aria-label="Workspace mode"
      >
        {MODE_TABS.map(({ mode: m, label, Icon }) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              title={label}
              onClick={() => setEditorMode(m)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors',
                active
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4 stroke-[1.5]" />
              {label}
            </button>
          )
        })}
      </nav>

      {/* Right zone — zoom + document actions. */}
      <div className="flex flex-1 items-center justify-end gap-1">
        <ZoomControl />
        <div className="mx-0.5 h-5 w-px self-center bg-border/70" aria-hidden />
        <div className="flex items-center gap-0.5" role="toolbar" aria-label="Document actions">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="New document"
          title="New document"
          onClick={() => {
            if (window.confirm('Start a new document? The current one will be discarded.')) {
              // Also clears any persisted document — the escape hatch from a
              // stale/corrupt saved state.
              void resetToNewDocument()
            }
          }}
        >
          <FilePlus2 className="size-4" />
        </Button>
        <div className="mx-0.5 h-5 w-px self-center bg-border/70" aria-hidden />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Undo"
          title="Undo"
          onClick={() => void undo()}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Redo"
          title="Redo"
          onClick={() => void redo()}
        >
          <Redo2 className="size-4" />
        </Button>
        <div className="mx-0.5 h-5 w-px self-center bg-border/70" aria-hidden />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Settings className="size-4" />
        </Button>
        </div>
      </div>
    </header>
  )
}
