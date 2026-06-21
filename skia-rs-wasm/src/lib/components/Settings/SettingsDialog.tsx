/**
 * Settings modal (opened from the top-bar gear). Lightweight — there's no Dialog
 * primitive in the kit, so it's a fixed backdrop + card. First sections: editable
 * pan/zoom config (the rebindable `ShortcutsConfig` values) and a read-only
 * keyboard-shortcut reference derived from the live binding table.
 */

import { useEffect } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useViewportShortcutsStore } from '../../renderer/store/shortcuts-store'
import type { ViewportPanModifier } from '../../renderer/types'
import { shortcutRows, type ShortcutCategory } from './shortcut-display'

const CATEGORIES: ShortcutCategory[] = ['Tools', 'Path editing', 'View']
const SELECT_CLASS =
  'h-8 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  )
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cfg = useViewportShortcutsStore((s) => s.viewportShortcuts)
  const setCfg = useViewportShortcutsStore((s) => s.setViewportShortcuts)
  const resetCfg = useViewportShortcutsStore((s) => s.resetViewportShortcuts)

  // Esc closes the dialog (capture so it beats canvas/path-edit Esc handlers).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  const rows = shortcutRows(cfg)

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">Settings</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close settings" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          <section className="mb-5">
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">Pan &amp; zoom</h3>
            <div className="space-y-3">
              <Field label="Pan modifier">
                <select
                  className={SELECT_CLASS}
                  value={cfg.panWithModifier ?? 'none'}
                  onChange={(e) =>
                    setCfg({ panWithModifier: e.target.value === 'none' ? null : (e.target.value as ViewportPanModifier) })
                  }
                >
                  <option value="shift">Shift</option>
                  <option value="alt">Alt</option>
                  <option value="ctrl">Ctrl</option>
                  <option value="meta">Meta</option>
                  <option value="none">None</option>
                </select>
              </Field>
              <Field label="Pan mouse button">
                <select
                  className={SELECT_CLASS}
                  value={cfg.panMouseButton}
                  onChange={(e) => setCfg({ panMouseButton: Number(e.target.value) })}
                >
                  <option value={0}>Left</option>
                  <option value={1}>Middle</option>
                  <option value={2}>Right</option>
                </select>
              </Field>
              <Field label="Arrow-key pan step (px)">
                <input
                  type="number"
                  min={1}
                  className={`${SELECT_CLASS} w-20 text-right`}
                  value={cfg.panStep}
                  onChange={(e) => setCfg({ panStep: Math.max(1, Number(e.target.value) || 1) })}
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">Keyboard shortcuts</h3>
            {CATEGORIES.map((cat) => {
              const catRows = rows.filter((r) => r.category === cat)
              if (catRows.length === 0) return null
              return (
                <div key={cat} className="mb-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{cat}</div>
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {catRows.map((r, i) => (
                      <li key={`${r.label}-${i}`} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                        <span>{r.label}</span>
                        <span className="flex flex-wrap justify-end gap-1">
                          {r.keys.map((k, j) => (
                            <kbd
                              key={j}
                              className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
            <p className="mt-2 text-xs text-muted-foreground">Tool/edit keys are fixed for now; pan &amp; zoom are configurable above.</p>
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={resetCfg}>
            <RotateCcw className="mr-1.5 size-3.5" />
            Reset defaults
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  )
}
