/**
 * Settings modal (opened from the top-bar gear). A fixed backdrop + card with a
 * left tab rail (General / AI / Shortcuts). Each tab carries its OWN "reset"
 * scoped to that page's settings — there is no global reset, so it's clear what
 * a reset affects. The AI tab's bring-your-own-key fields are gated on
 * `hasSecureKeyStore()` (desktop/terminal only); a browser can't hold a key
 * safely, so on the web they render disabled with a hint.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { X, RotateCcw, SlidersHorizontal, Bot, Keyboard, Lock, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useViewportShortcutsStore, DEFAULT_SHORTCUTS } from '../../renderer/store/shortcuts-store'
import { useAiSettingsStore } from '../../renderer/store/ai-settings-store'
import { hasSecureKeyStore } from '../../renderer/platform'
import type { ShortcutsConfig, ViewportPanModifier } from '../../renderer/types'
import { TOOL_BINDINGS, type ToolKeyField } from '../../renderer/input/key-bindings'
import { formatKeyCode, shortcutRows, toolKeyConflict } from './shortcut-display'

const SELECT_CLASS =
  'h-8 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  )
}

/** Per-tab reset — scoped to the active page so it never reads as "reset everything". */
function PaneReset({ label, onReset }: { label: string; onReset: () => void }) {
  return (
    <div className="mt-4 flex justify-end">
      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onReset}>
        <RotateCcw className="mr-1.5 size-3.5" />
        {label}
      </Button>
    </div>
  )
}

/** One rebindable key: shows the current key; click → "Press a key…", captures the
 *  next non-modifier code; Esc cancels. Reports conflicts back to the parent. */
function RebindRow({
  field,
  label,
  value,
  onRebind,
}: {
  field: ToolKeyField
  label: string
  value: string
  onRebind: (field: ToolKeyField, code: string) => string | null
}) {
  const [capturing, setCapturing] = useState(false)
  const [warn, setWarn] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      if (MODIFIER_KEYS.has(e.key)) return // wait for the real key
      setWarn(onRebind(field, e.code))
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, field, onRebind])

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
      <span className="flex flex-col">
        {label}
        {warn && <span className="text-xs text-destructive">Already used by {warn}</span>}
      </span>
      <button
        type="button"
        onClick={() => {
          setWarn(null)
          setCapturing(true)
        }}
        className={`min-w-[4.5rem] rounded-md border px-2 py-1 text-center text-xs transition-colors ${
          capturing ? 'border-ring text-muted-foreground ring-2 ring-ring/40' : 'border-border hover:bg-muted'
        }`}
        aria-label={`Rebind ${label}`}
      >
        {capturing ? 'Press a key…' : <kbd className="font-mono">{formatKeyCode(value)}</kbd>}
      </button>
    </li>
  )
}

const TAB_TRIGGER_CLASS =
  'justify-start gap-2 px-3 data-[state=active]:bg-muted data-[state=active]:shadow-none'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cfg = useViewportShortcutsStore((s) => s.viewportShortcuts)
  const setCfg = useViewportShortcutsStore((s) => s.setViewportShortcuts)
  const ai = useAiSettingsStore((s) => s.ai)
  const setAi = useAiSettingsStore((s) => s.setAi)
  const resetAi = useAiSettingsStore((s) => s.resetAi)
  const canBYOK = hasSecureKeyStore()
  // Close only when the press STARTED on the backdrop — a drag/click that began
  // inside the dialog (e.g. selecting input text) must not close it on release.
  const backdropDown = useRef(false)

  // Esc closes the dialog (capture so it beats canvas/path-edit Esc handlers — but
  // a rebind row that's capturing handles Esc first via its own capture listener).
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

  // Apply a rebind unless the code collides with another binding; returns the
  // conflicting label (for the row to show) without applying when it does.
  const rebind = useCallback(
    (field: ToolKeyField, code: string): string | null => {
      const conflict = toolKeyConflict(cfg, field, code)
      if (conflict) return conflict
      setCfg({ [field]: code } as Partial<ShortcutsConfig>)
      return null
    },
    [cfg, setCfg]
  )

  // Per-tab resets — each touches only its own page's settings.
  const resetGeneral = useCallback(
    () =>
      setCfg({
        panWithModifier: DEFAULT_SHORTCUTS.panWithModifier,
        panMouseButton: DEFAULT_SHORTCUTS.panMouseButton,
        panStep: DEFAULT_SHORTCUTS.panStep,
      }),
    [setCfg]
  )
  const resetShortcutKeys = useCallback(
    () =>
      setCfg(
        Object.fromEntries(TOOL_BINDINGS.map((t) => [t.field, DEFAULT_SHORTCUTS[t.field]])) as Partial<ShortcutsConfig>
      ),
    [setCfg]
  )

  if (!open) return null
  const viewRows = shortcutRows(cfg).filter((r) => r.category === 'View')
  const toolDescs = TOOL_BINDINGS.filter((t) => t.category === 'Tools')
  const pathDescs = TOOL_BINDINGS.filter((t) => t.category === 'Path editing')

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => {
        backdropDown.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (backdropDown.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="flex h-[34rem] max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">Settings</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close settings" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 px-5 py-4">
          <Tabs defaultValue="general" orientation="vertical" className="flex h-full min-h-0 w-full flex-row gap-5">
            <TabsList className="flex h-auto w-40 shrink-0 flex-col items-stretch gap-1 bg-transparent p-0">
              <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                <SlidersHorizontal className="size-4" />
                General
              </TabsTrigger>
              <TabsTrigger value="ai" className={TAB_TRIGGER_CLASS}>
                <Bot className="size-4" />
                AI
              </TabsTrigger>
              <TabsTrigger value="shortcuts" className={TAB_TRIGGER_CLASS}>
                <Keyboard className="size-4" />
                Shortcuts
              </TabsTrigger>
            </TabsList>

            <div className="min-w-0 flex-1 overflow-y-auto pr-1">
              <TabsContent value="general" className="mt-0">
                <h3 className="mb-3 text-sm font-medium text-muted-foreground">Pan &amp; zoom</h3>
                <div className="space-y-3">
                  <Field label="Pan modifier">
                    <select
                      className={SELECT_CLASS}
                      value={cfg.panWithModifier ?? 'none'}
                      onChange={(e) =>
                        setCfg({
                          panWithModifier: e.target.value === 'none' ? null : (e.target.value as ViewportPanModifier),
                        })
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
                <PaneReset label="Reset pan &amp; zoom" onReset={resetGeneral} />
              </TabsContent>

              <TabsContent value="ai" className="mt-0">
                <h3 className="mb-3 text-sm font-medium text-muted-foreground">Model</h3>
                <Field label="Provider">
                  <Badge variant="secondary" className="font-normal">
                    Built-in · managed
                  </Badge>
                </Field>
                <p className="mt-2 text-xs text-muted-foreground">
                  Conversations use the built-in model. The provider key is kept on the server — never in this browser.
                </p>

                <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
                  <div className="mb-3 flex items-center gap-2">
                    <Lock className="size-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">Bring your own key</span>
                    {!canBYOK && (
                      <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground/70">
                        <Monitor className="size-3.5" />
                        desktop app only
                      </span>
                    )}
                  </div>
                  <div className="space-y-3">
                    <Field label="API key">
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="sk-…"
                        disabled={!canBYOK}
                        className={`${SELECT_CLASS} w-56 disabled:cursor-not-allowed disabled:opacity-50`}
                        value={ai.apiKey}
                        onChange={(e) => setAi({ apiKey: e.target.value })}
                      />
                    </Field>
                    <Field label="Model">
                      <input
                        type="text"
                        spellCheck={false}
                        placeholder="provider/model"
                        disabled={!canBYOK}
                        className={`${SELECT_CLASS} w-56 disabled:cursor-not-allowed disabled:opacity-50`}
                        value={ai.model}
                        onChange={(e) => setAi({ model: e.target.value })}
                      />
                    </Field>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {canBYOK
                      ? 'Stored in your device keychain and used to call the provider directly.'
                      : "A browser can't store a key securely. In the desktop app your key is held in the OS keychain and used to call the provider directly."}
                  </p>
                  {canBYOK && <PaneReset label="Clear key" onReset={resetAi} />}
                </div>
              </TabsContent>

              <TabsContent value="shortcuts" className="mt-0">
                <h3 className="mb-3 text-sm font-medium text-muted-foreground">Keyboard shortcuts</h3>

                <div className="mb-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Tools</div>
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {toolDescs.map((t) => (
                      <RebindRow key={t.field} field={t.field} label={t.label} value={cfg[t.field]} onRebind={rebind} />
                    ))}
                  </ul>
                </div>

                <div className="mb-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                    Path editing
                  </div>
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {pathDescs.map((t) => (
                      <RebindRow key={t.field} field={t.field} label={t.label} value={cfg[t.field]} onRebind={rebind} />
                    ))}
                  </ul>
                </div>

                <div className="mb-1">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">View</div>
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {viewRows.map((r, i) => (
                      <li
                        key={`${r.label}-${i}`}
                        className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                      >
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
                <p className="mt-2 text-xs text-muted-foreground">
                  Click a key to rebind it. Pan/zoom keys are fixed; configure pan in General.
                </p>
                <PaneReset label="Reset shortcuts" onReset={resetShortcutKeys} />
              </TabsContent>
            </div>
          </Tabs>
        </div>

        <footer className="flex items-center justify-end border-t border-border px-5 py-3">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  )
}
