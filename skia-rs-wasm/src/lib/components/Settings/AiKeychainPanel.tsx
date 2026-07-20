/**
 * Bring-your-own-key panel for the Settings → AI tab.
 *
 * Desktop/terminal only: drives the OS-keychain-backed key store over the Electron
 * bridge (`window.zoetrope.keyStore`). The key travels renderer→main once on save and
 * is never read back — the panel renders from non-secret status (provider/model/last4).
 * On the web (`canBYOK` false) there is no key store, so it renders a disabled hint.
 */

import { useEffect, useRef, useState } from 'react'
import { Lock, Monitor, Loader2, AlertTriangle, RotateCcw, Trash2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getKeyStore,
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  type KeyStoreStatus,
  type LlmProvider,
} from '../../renderer/desktop-bridge'

const INPUT_CLASS =
  'h-8 w-full rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

// Sensible starting model per provider; the user can edit before saving.
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
}

type Phase = 'idle' | 'saving' | 'error'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function AiKeychainPanel({ canBYOK }: { canBYOK: boolean }) {
  const [status, setStatus] = useState<KeyStoreStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [provider, setProvider] = useState<LlmProvider>('anthropic')
  const [model, setModel] = useState<string>(DEFAULT_MODELS.anthropic)
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  // Keep the model in sync with the provider only until the user edits it themselves.
  const modelDirty = useRef(false)

  // Sync from the OS keychain (external system) when the panel opens on a BYOK surface.
  // setStatus runs in the promise callback, not synchronously in the effect body.
  useEffect(() => {
    const store = canBYOK ? getKeyStore() : null
    if (!store) return
    let cancelled = false
    store
      .getStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus({ available: false, hasKey: false }))
    return () => {
      cancelled = true
    }
  }, [canBYOK])

  const onProvider = (p: LlmProvider) => {
    setProvider(p)
    if (!modelDirty.current) setModel(DEFAULT_MODELS[p])
  }

  const save = async () => {
    const store = getKeyStore()
    if (!store) return
    setPhase('saving')
    setError('')
    try {
      const next = await store.set({ provider, model: model.trim(), key: key.trim() })
      setStatus(next)
      setKey('')
      setEditing(false)
      setPhase('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not store the key.')
      setPhase('error')
    }
  }

  const clear = async () => {
    const store = getKeyStore()
    if (!store) return
    try {
      setStatus(await store.clear())
    } catch {
      /* leave current status; a failed clear is non-destructive */
    }
  }

  const startReplace = () => {
    if (status?.provider) onProvider(status.provider)
    setKey('')
    setEditing(true)
    setPhase('idle')
    setError('')
  }

  // --- Web: no key store. ------------------------------------------------------
  if (!canBYOK) {
    return (
      <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
        <div className="mb-2 flex items-center gap-2">
          <Lock className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Bring your own key</span>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground/70">
            <Monitor className="size-3.5" />
            desktop app only
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          A browser can&apos;t store a key securely. In the desktop app your key is held in the OS keychain and used to
          call the provider directly.
        </p>
      </div>
    )
  }

  // --- Desktop: keychain unavailable (e.g. Linux without libsecret). -----------
  if (status && !status.available) {
    return (
      <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
        <div className="mb-2 flex items-center gap-2">
          <Lock className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Bring your own key</span>
        </div>
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>The OS keychain is unavailable on this system, so a key can&apos;t be stored securely.</span>
        </div>
      </div>
    )
  }

  const stored = status?.hasKey && !editing

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <Lock className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Bring your own key</span>
        {stored && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-600">
            <ShieldCheck className="size-3.5" />
            active · {PROVIDER_LABELS[status!.provider ?? 'anthropic']}
          </span>
        )}
      </div>

      {stored ? (
        <>
          <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2.5">
            <Lock className="size-4 text-emerald-600" />
            <div className="min-w-0">
              <div className="font-mono text-sm">•••• {status!.last4}</div>
              <div className="text-xs text-muted-foreground">
                Stored in your OS keychain · {status!.model}
              </div>
            </div>
          </div>
          <div className="mt-2.5 flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={startReplace}>
              <RotateCcw className="size-3.5" />
              Replace
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-destructive hover:text-destructive"
              onClick={clear}
            >
              <Trash2 className="size-3.5" />
              Clear key
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Chat runs in the app&apos;s main process with this key. The renderer only sends prompts and receives the
            reply.
          </p>
        </>
      ) : (
        <>
          <div className="space-y-3">
            <Field label="Provider">
              <select
                className={INPUT_CLASS}
                value={provider}
                disabled={phase === 'saving'}
                onChange={(e) => onProvider(e.target.value as LlmProvider)}
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="API key">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                disabled={phase === 'saving'}
                className={`${INPUT_CLASS} font-mono`}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Field label="Model">
              <input
                type="text"
                spellCheck={false}
                placeholder="provider/model"
                disabled={phase === 'saving'}
                className={`${INPUT_CLASS} font-mono`}
                value={model}
                onChange={(e) => {
                  modelDirty.current = true
                  setModel(e.target.value)
                }}
              />
            </Field>
          </div>

          {phase === 'error' && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={phase === 'saving' || !key.trim() || !model.trim()}>
              {phase === 'saving' ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
              {phase === 'saving' ? 'Encrypting…' : 'Save to keychain'}
            </Button>
            {editing && status?.hasKey && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setEditing(false)
                  setPhase('idle')
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Encrypted with your OS keychain and used to call the provider directly. It never touches the browser layer.
          </p>
        </>
      )}
    </div>
  )
}
