/**
 * FocusStage — the reusable chrome for a center-region takeover.
 *
 * Rendered in `CanvasWrapper`'s `centerOverlay` slot (the canvas-hole between
 * the rails) whenever a `FocusStageSession` is active. It provides only the
 * shared frame: a thin header bar (title + exit) and Esc-to-exit. The content
 * region is intentionally transparent and pointer-transparent, so a session
 * that leaves gaps lets the live canvas underneath show through (the shader
 * stage relies on this — the real shape *is* the live preview). A session that
 * wants an opaque takeover just fills the region with its own surface.
 *
 * Feature-agnostic: it knows nothing about shaders. See `focus-stage.ts`.
 */

import { useEffect } from 'react'
import { Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { closeFocusStage, type FocusStageSession } from '@/lib/renderer/signals/focus-stage'

export function FocusStage({ session }: { session: FocusStageSession }) {
  // Esc exits — but not while typing in a field (a code textarea / numeric
  // input owns Esc for its own revert), matching the app's global-key policy.
  // The header exit button is always available as the unambiguous way out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      closeFocusStage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">
      {/* Header bar: opaque, spans the center region's top edge. */}
      <div className="pointer-events-auto flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <div className="min-w-0 flex-1 truncate text-xs font-medium">{session.title}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          onClick={closeFocusStage}
          aria-label="Exit focus mode"
          title="Exit focus mode (Esc)"
        >
          <Minimize2 className="size-4" />
        </Button>
      </div>

      {/* Content region: transparent + pointer-transparent by default. The
          session's content opts back into pointer events where it draws. */}
      <div className="relative min-h-0 flex-1">{session.center}</div>
    </div>
  )
}
