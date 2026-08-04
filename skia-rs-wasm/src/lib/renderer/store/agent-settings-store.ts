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
 * How a chat with this agent runs:
 * - `acp`     — structured Agent Client Protocol (Claude Code adapter). Streams a
 *               transcript of message/tool/plan events; the surface is AcpView.
 * - `terminal`— a raw CLI in a pty (aider, opencode, …); the surface is TerminalView.
 */
export type AgentKind = 'acp' | 'terminal'

export interface AgentConfig {
  id: string
  name: string
  kind: AgentKind
  /** Command line with a `{prompt}` placeholder, e.g. `claude -p {prompt}`. */
  command: string
}

/** The token replaced by the user's message when the command runs. */
export const PROMPT_TOKEN = '{prompt}'

/** Best-effort headless commands for common AI CLIs; all user-editable. */
export const DEFAULT_AGENTS: AgentConfig[] = [
  // Claude runs over ACP (bundled adapter, subscription auth) — no shell command used.
  { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude -p {prompt}' },
  { id: 'aider', name: 'aider', kind: 'terminal', command: 'aider --yes --message {prompt}' },
  { id: 'opencode', name: 'opencode', kind: 'terminal', command: 'opencode run {prompt}' },
  { id: 'codex', name: 'Codex CLI', kind: 'terminal', command: 'codex exec {prompt}' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'terminal', command: 'gemini -p {prompt}' },
]

/** Backfill `kind` for agents persisted before it existed (heuristic on id/command). */
function inferKind(a: { id?: string; command?: string; kind?: AgentKind }): AgentKind {
  if (a.kind) return a.kind
  if (a.id === 'claude' || (a.command ?? '').trimStart().startsWith('claude')) return 'acp'
  return 'terminal'
}

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
        set((s) => ({ agents: [...s.agents, { id, name: 'New agent', kind: 'terminal', command: '' }], selectedId: id }))
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
      version: 1,
      // v0 → v1 added `kind`; backfill it on rehydrate so older stored agents still work.
      migrate: (state: unknown) => {
        const s = state as { agents?: AgentConfig[] } | undefined
        if (s?.agents) s.agents = s.agents.map((a) => ({ ...a, kind: inferKind(a) }))
        return s as AgentSettingsState
      },
    },
  ),
)
