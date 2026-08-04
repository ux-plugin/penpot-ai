/**
 * AI-provider configuration for Settings → AI (desktop only).
 *
 * Each provider is a named way to talk to a model vendor. Its STYLE decides auth:
 * - Subscription (`acp`) — the user's own `claude` login. Runs a chosen ACP adapter; the
 *   panel detects which adapters are present (Tier 1) and can verify one speaks ACP (Tier 2).
 * - API key (`sdk`) — a provider key (BYOK); the key lives in the OS keychain, only the
 *   provider is named here.
 *
 * Which of a vendor's models appear in chat is controlled by a "hidden models" list: every
 * catalog model shows by default, and the user bans specific ones by picking them from a
 * searchable menu (never by typing names).
 */

import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Plus,
  Trash2,
  Circle,
  CircleDot,
  Loader2,
  Check,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Lock,
  ShieldCheck,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  useAgentSettingsStore,
  modelsFor,
  type AgentConfig,
  type AgentProvider,
  type AgentStyle,
} from '../../renderer/store/agent-settings-store'
import {
  getAcp,
  getKeyStore,
  type AdapterTestResult,
  type DetectedAdapter,
  type StoredKeyInfo,
} from '../../renderer/desktop-bridge'

const INPUT_CLASS =
  'h-8 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

const STYLES: { value: AgentStyle; label: string }[] = [
  { value: 'acp', label: 'Subscription' },
  { value: 'sdk', label: 'API key' },
]

const PROVIDERS: { value: AgentProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
]

type TestState = { loading?: boolean; result?: AdapterTestResult }

/**
 * The "hidden models" editor for one provider. Every catalog model shows in chat by
 * default; the user bans specific ids by picking them from a searchable menu. Banned ids
 * appear as removable chips — nothing is ever typed, so a user never needs to know model
 * names ahead of time.
 */
function HiddenModels({ agent }: { agent: AgentConfig }) {
  const updateAgent = useAgentSettingsStore((s) => s.updateAgent)
  const catalog = modelsFor(agent.provider)
  const hidden = agent.disallow ?? []

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  // Close the picker on an outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setHidden = (next: string[]) => updateAgent(agent.id, { disallow: next.length ? next : undefined })
  const ban = (m: string) => {
    setHidden([...hidden, m])
    setQuery('')
    setOpen(false)
  }
  const unban = (m: string) => setHidden(hidden.filter((x) => x !== m))

  // Models still available to ban, filtered by the search query.
  const q = query.trim().toLowerCase()
  const candidates = catalog.filter((m) => !hidden.includes(m) && (!q || m.toLowerCase().includes(q)))
  const shownCount = catalog.length - hidden.length

  return (
    <div className="mt-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
          Models shown in chat
        </span>
        <span className="text-[0.65rem] text-muted-foreground">
          {shownCount} of {catalog.length}
        </span>
      </div>

      {hidden.length > 0 && (
        <div className="mb-1.5">
          <div className="mb-1 text-[0.65rem] text-muted-foreground">Hidden</div>
          <div className="flex flex-wrap gap-1.5">
            {hidden.map((m) => (
              <span
                key={m}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/50 py-0.5 pl-2 pr-1 font-mono text-[0.65rem] text-muted-foreground"
              >
                {m}
                <button
                  type="button"
                  aria-label={`Show ${m} in chat`}
                  className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
                  onClick={() => unban(m)}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div ref={boxRef} className="relative inline-block">
        <button
          type="button"
          disabled={candidates.length === 0 && !q}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[0.7rem] text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-3" />
          Hide a model
        </button>

        {open && (
          <div className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-border bg-white shadow-md">
            <div className="flex items-center gap-1.5 border-b border-border/70 px-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                autoFocus
                spellCheck={false}
                placeholder="Search models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 flex-1 bg-transparent text-[0.75rem] outline-none"
              />
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {catalog.length - hidden.length === 0 ? (
                <div className="px-2.5 py-2 text-[0.7rem] text-muted-foreground">Every model is already hidden.</div>
              ) : candidates.length === 0 ? (
                <div className="px-2.5 py-2 text-[0.7rem] text-muted-foreground">No match.</div>
              ) : (
                candidates.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => ban(m)}
                    className="flex w-full items-center px-2.5 py-1.5 text-left font-mono text-[0.7rem] text-foreground transition-colors hover:bg-muted"
                  >
                    {m}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Inline API-key entry for one `sdk` provider row. The key is scoped to this row's id, so
 * two rows of the same vendor (custom-named) hold independent keys. The secret is sent to
 * the keychain vault once on save and never read back — this renders from non-secret
 * status (last4). On the web there's no key store, so it shows a desktop-only hint.
 */
function ProviderKey({
  agent,
  info,
  onStatusChange,
}: {
  agent: AgentConfig
  info: StoredKeyInfo | undefined
  onStatusChange: (keys: Record<string, StoredKeyInfo>) => void
}) {
  const store = getKeyStore()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!store) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
        <Lock className="size-3.5" /> Add a key in the desktop app.
      </div>
    )
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const status = await store.set({ id: agent.id, provider: agent.provider, key: key.trim() })
      onStatusChange(status.keys)
      setKey('')
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not store the key.')
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    try {
      const status = await store.clear(agent.id)
      onStatusChange(status.keys)
    } catch {
      /* a failed clear is non-destructive — leave state as-is */
    }
  }

  // Stored, not editing → compact "•••• 1234 · Replace / Clear".
  if (info && !editing) {
    return (
      <div className="mt-2">
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
          <Lock className="size-3.5 text-emerald-600" />
          <span className="font-mono text-[0.75rem]">•••• {info.last4}</span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setKey('')
                setError('')
                setEditing(true)
              }}
            >
              <RotateCcw className="size-3" /> Replace
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-destructive"
              onClick={() => void clear()}
            >
              <Trash2 className="size-3" /> Clear
            </button>
          </span>
        </div>
      </div>
    )
  }

  // No key yet (or replacing) → password input + Save.
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-…"
          disabled={saving}
          className={`${INPUT_CLASS} flex-1 font-mono`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()}
        />
        <Button size="sm" onClick={() => void save()} disabled={saving || !key.trim()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {editing && info && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[0.7rem] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {error}
        </div>
      )}
      <p className="mt-1.5 text-[0.7rem] text-muted-foreground">Encrypted in your OS keychain. Never touches the browser.</p>
    </div>
  )
}

export function AiAgentsPanel() {
  const agents = useAgentSettingsStore((s) => s.agents)
  const updateAgent = useAgentSettingsStore((s) => s.updateAgent)
  const addAgent = useAgentSettingsStore((s) => s.addAgent)
  const removeAgent = useAgentSettingsStore((s) => s.removeAgent)
  const resetAgents = useAgentSettingsStore((s) => s.resetAgents)

  // Tier 1 presence, fetched once; Tier 2 test results keyed by adapter id.
  const [adapters, setAdapters] = useState<DetectedAdapter[]>([])
  const [tests, setTests] = useState<Record<string, TestState>>({})
  // Which providers have their "Advanced · connection" section expanded.
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({})
  // Stored keys by provider-row id (non-secret metadata), synced from the keychain vault.
  const [keys, setKeys] = useState<Record<string, StoredKeyInfo>>({})

  useEffect(() => {
    let cancelled = false
    getAcp()
      ?.listAdapters()
      .then((list) => !cancelled && setAdapters(list))
      .catch(() => {})
    getKeyStore()
      ?.getStatus()
      .then((s) => !cancelled && setKeys(s.keys))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const runTest = async (id: string) => {
    const acp = getAcp()
    if (!acp) return
    setTests((t) => ({ ...t, [id]: { loading: true } }))
    try {
      const result = await acp.testAdapter(id)
      setTests((t) => ({ ...t, [id]: { result } }))
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { result: { ok: false, error: e instanceof Error ? e.message : 'Test failed.' } } }))
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Bot className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Providers</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Set up who to talk to, then pick a provider and model in any chat. Subscription uses your Claude login; API key
        uses a provider key stored in your keychain.
      </p>

      <div className="space-y-3">
        {agents.map((a) => (
          <div key={a.id} className="rounded-md border border-border/60 bg-background/60 p-2.5">
            <div className="flex items-center gap-2">
              <input
                aria-label="Provider name"
                spellCheck={false}
                placeholder="Name"
                className={`${INPUT_CLASS} w-44`}
                value={a.name}
                onChange={(e) => updateAgent(a.id, { name: e.target.value })}
              />
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                onClick={() => removeAgent(a.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label="Auth style"
                className={INPUT_CLASS}
                value={a.style}
                onChange={(e) => updateAgent(a.id, { style: e.target.value as AgentStyle })}
              >
                {STYLES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              {a.style === 'sdk' && (
                <select
                  aria-label="Provider"
                  className={INPUT_CLASS}
                  value={a.provider ?? 'anthropic'}
                  onChange={(e) => updateAgent(a.id, { provider: e.target.value as AgentProvider })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
              {a.style === 'sdk' && a.provider && a.provider !== 'anthropic' && (
                <span className="text-[0.7rem] text-amber-600">routes via a gateway — coming soon</span>
              )}
            </div>

            {a.style === 'sdk' && (
              <ProviderKey
                agent={a}
                info={keys[a.id]}
                onStatusChange={(next) => setKeys(next)}
              />
            )}

            <HiddenModels agent={a} />

            {a.style === 'acp' && (
              <div className="mt-2.5 border-t border-border/50 pt-2">
                <button
                  type="button"
                  onClick={() => setAdvanced((s) => ({ ...s, [a.id]: !s[a.id] }))}
                  className="flex items-center gap-1 text-[0.7rem] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {advanced[a.id] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  Advanced · connection
                </button>

                {advanced[a.id] && (
                  <div className="mt-2">
                    <div className="mb-1.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                      ACP adapter
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {adapters.length === 0 && (
                        <div className="text-[0.7rem] text-muted-foreground">Detecting…</div>
                      )}
                      {adapters.map((ad) => {
                        const selected = (a.adapter ?? 'claude') === ad.id
                        const test = tests[ad.id]
                        return (
                          <div
                            key={ad.id}
                            className={cn(
                              'rounded-md border px-2.5 py-1.5',
                              selected ? 'border-ring bg-muted/50' : 'border-border/60',
                              !ad.available && 'opacity-70',
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={!ad.available}
                                onClick={() => updateAgent(a.id, { adapter: ad.id })}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                              >
                                {selected ? (
                                  <CircleDot className="size-4 shrink-0 text-foreground" />
                                ) : (
                                  <Circle className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                <span className="truncate text-[0.8rem] text-foreground">{ad.label}</span>
                              </button>
                              <span
                                className={cn(
                                  'shrink-0 rounded-full px-2 py-0.5 text-[0.65rem]',
                                  ad.available
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                    : 'border border-border text-muted-foreground',
                                )}
                              >
                                {ad.available ? 'available' : 'not found'}
                              </span>
                              {ad.available && (
                                <button
                                  type="button"
                                  onClick={() => void runTest(ad.id)}
                                  disabled={test?.loading}
                                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[0.7rem] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                                >
                                  Test
                                </button>
                              )}
                            </div>
                            {test?.loading && (
                              <div className="mt-1 flex items-center gap-1.5 pl-6 text-[0.7rem] text-muted-foreground">
                                <Loader2 className="size-3 animate-spin" /> testing…
                              </div>
                            )}
                            {test?.result?.ok && (
                              <div className="mt-1 flex items-center gap-1.5 pl-6 text-[0.7rem] text-emerald-600">
                                <Check className="size-3.5" /> speaks ACP · {Math.round(test.result.ms ?? 0)}ms
                              </div>
                            )}
                            {test?.result && !test.result.ok && (
                              <div className="mt-1 pl-6 text-[0.7rem] text-destructive">{test.result.error}</div>
                            )}
                            {!ad.available && ad.installHint && (
                              <div className="mt-1 pl-6 font-mono text-[0.7rem] text-muted-foreground">
                                {ad.installHint}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => addAgent()}>
          <Plus className="size-3.5" />
          Add provider
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={resetAgents}>
          Reset to defaults
        </Button>
      </div>
    </div>
  )
}
