/**
 * Terminal-agent configuration (desktop only).
 *
 * Holds the user-editable list of AI CLIs the Build-mode chat can drive in Agent mode,
 * the selected one, and the working directory to run them in. Each agent is a display
 * name + a command string containing the `{prompt}` placeholder (where the user's
 * message is inserted). Persisted to localStorage — nothing here is a secret (the CLI
 * owns its own auth); it's just which commands to run.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * How an agent authenticates + runs. Both styles stream the same structured ACP
 * transcript (surface = AcpView); they differ only in credentials:
 * - `acp` — subscription auth via the user's own `claude` login (delegated CLI).
 * - `sdk` — a provider API key (BYOK), injected into the Agent SDK. The key itself
 *           lives in the OS keychain (main process); only its provider is named here.
 */
export type AgentStyle = 'acp' | 'sdk'

/** Model vendor. Non-Anthropic route through a gateway (later). */
export type AgentProvider = 'anthropic' | 'openai' | 'google'

/**
 * Models offered per vendor by default — the user never has to add them by hand. These are
 * best-effort ids that seed the in-chat model selector; editing/refreshing comes later.
 */
export const MODEL_CATALOG: Record<AgentProvider, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
}

export function modelsFor(provider: AgentProvider): string[] {
  return MODEL_CATALOG[provider] ?? []
}

/** A configured provider — an auth source (subscription or API key) for a model vendor. */
export interface AgentConfig {
  id: string
  name: string
  style: AgentStyle
  /** Vendor whose models + SDK this uses. Its models come from MODEL_CATALOG. */
  provider: AgentProvider
  /** `acp` only — which ACP adapter runs it (registry id); omit → bundled Claude adapter. */
  adapter?: string
  /** Exact model ids hidden from the in-chat picker (chosen from a menu, not typed). */
  disallow?: string[]
}

/** The models a provider offers in chat: its catalog minus the hidden (disallowed) ids. */
export function visibleModels(a: Pick<AgentConfig, 'provider' | 'disallow'>): string[] {
  const hidden = new Set(a.disallow ?? [])
  return modelsFor(a.provider).filter((m) => !hidden.has(m))
}

/** Legacy — kept only so the (parked) terminal-agent settings UI still compiles. */
export const PROMPT_TOKEN = '{prompt}'

/** Providers a fresh install offers: Claude by subscription, plus the API-key vendors. */
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'claude', name: 'Claude · subscription', style: 'acp', provider: 'anthropic' },
  { id: 'anthropic', name: 'Anthropic', style: 'sdk', provider: 'anthropic' },
  { id: 'openai', name: 'OpenAI', style: 'sdk', provider: 'openai' },
  { id: 'google', name: 'Google', style: 'sdk', provider: 'google' },
]

/**
 * Split a command string into argv, honoring single/double quotes so a flag value with
 * spaces stays one token. The `{prompt}` placeholder survives as its own element, which
 * the main process substitutes — no shell, so the message can't break argument bounds.
 */
export function parseCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = null
      else {
        cur += c
        has = true
      }
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

interface AgentSettingsState {
  agents: AgentConfig[]
  selectedId: string | null
  cwd: string | null
  setSelected: (id: string | null) => void
  setCwd: (cwd: string | null) => void
  updateAgent: (id: string, patch: Partial<Omit<AgentConfig, 'id'>>) => void
  addAgent: () => string
  removeAgent: (id: string) => void
  resetAgents: () => void
}

export const useAgentSettingsStore = create<AgentSettingsState>()(
  persist(
    (set) => ({
      agents: DEFAULT_AGENTS.map((a) => ({ ...a })),
      selectedId: DEFAULT_AGENTS[0]?.id ?? null,
      cwd: null,
      setSelected: (id) => set({ selectedId: id }),
      setCwd: (cwd) => set({ cwd }),
      updateAgent: (id, patch) =>
        set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
      addAgent: () => {
        const id = crypto.randomUUID()
        set((s) => ({
          agents: [...s.agents, { id, name: 'New agent', style: 'sdk', provider: 'anthropic' }],
          selectedId: id,
        }))
        return id
      },
      removeAgent: (id) =>
        set((s) => {
          const agents = s.agents.filter((a) => a.id !== id)
          const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId
          return { agents, selectedId }
        }),
      resetAgents: () =>
        set({ agents: DEFAULT_AGENTS.map((a) => ({ ...a })), selectedId: DEFAULT_AGENTS[0]?.id ?? null }),
    }),
    {
      name: 'zoetrope.agent-settings',
      version: 4,
      // Shape has churned (kind→style, agents→providers, then disallow patterns→exact ids).
      // Pre-production: rather than migrate stale local test data, reset to current defaults.
      migrate: (state: unknown) => {
        const s = (state as Partial<AgentSettingsState> | undefined) ?? {}
        s.agents = DEFAULT_AGENTS.map((a) => ({ ...a }))
        s.selectedId = DEFAULT_AGENTS[0]?.id ?? null
        return s as AgentSettingsState
      },
      // Self-heal: an empty agent list is useless (no chat can start), so fall back to the
      // defaults whenever persisted state has none.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AgentSettingsState>
        const agents = p.agents && p.agents.length > 0 ? p.agents : current.agents
        return { ...current, ...p, agents, selectedId: p.selectedId ?? agents[0]?.id ?? null }
      },
    },
  ),
)
