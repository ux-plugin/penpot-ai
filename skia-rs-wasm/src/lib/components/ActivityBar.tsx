/**
 * VS Code-style activity bar — the far-left strip that switches the workspace
 * between Design (geometry/style) and Build (behavior) modes.
 */

import { File, Monitor } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { editorMode, setEditorMode, type EditorMode } from '../renderer/signals/editor-mode'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'

interface ModeItem {
  mode: EditorMode
  label: string
  Icon: LucideIcon
}

const ITEMS: ModeItem[] = [
  { mode: 'design', label: 'Design', Icon: File },
  { mode: 'build', label: 'Build', Icon: Monitor },
]

export function ActivityBar() {
  const mode = useSignalCoalesced(editorMode)
  return (
    <nav
      className="pointer-events-auto fixed inset-y-0 left-0 z-60 flex w-(--activity-bar-width,3rem) flex-col items-center gap-1 border-r border-border/80 bg-white py-2"
      role="tablist"
      aria-label="Editor mode"
    >
      {ITEMS.map(({ mode: m, label, Icon }) => {
        const active = mode === m
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => setEditorMode(m)}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              active && 'bg-muted text-foreground',
            )}
          >
            <Icon className="size-5 stroke-[1.5]" />
          </button>
        )
      })}
    </nav>
  )
}
