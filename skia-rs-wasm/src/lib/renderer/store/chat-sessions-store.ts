/**
 * Multi-session chat manager (desktop Agent mode).
 *
 * Each chat is bound to an agent and runs independently: the store owns every chat's
 * metadata, its transcript, and — crucially — its prompt lifecycle. Prompt orchestration
 * lives HERE, not in the view, so a chat keeps streaming and its status stays correct
 * even after the user switches away and its AcpView unmounts. A single app-wide ACP
 * update listener (installed by `ensureAcpRouter`) routes every streamed event to the
 * right chat's transcript by `chatId`.
 *
 * Transcripts and chat metadata persist to localStorage (the user asked for chats to
 * survive a reload); runtime-only fields (status, pending login) are reset on rehydrate.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getAcp, type AcpLoginCommand, type AcpUpdateBody } from '../desktop-bridge'
import { reduceTranscript, type TranscriptItem } from '../interactions/session/acp-transcript'
import { visibleModels, type AgentConfig, type AgentProvider, type AgentStyle } from './agent-settings-store'

/** A chat's live state: idle, streaming a turn, blocked on auth, or errored. */
export type ChatStatus = 'idle' | 'streaming' | 'auth' | 'error'

export interface ChatSession {
  id: string
  title: string
  /** The agent this chat runs (id into the agent-settings store). */
  agentId: string
  style: AgentStyle
  /** `acp` style only — which ACP adapter to run. */
  adapter?: string
  /** `sdk` style only — which provider's key to use. */
  provider?: AgentProvider
  /** Model chosen in-chat (from the provider's visible catalog). */
  model?: string
  cwd: string | null
  createdAt: number
  status: ChatStatus
}

interface ChatSessionsState {
  chats: ChatSession[]
  activeId: string | null
  /** Per-chat transcript (persisted). Terminal chats keep their scrollback in xterm. */
  transcripts: Record<string, TranscriptItem[]>
  /** Folder seeded into the next new chat (last folder the user picked). */
  lastCwd: string | null
  /** Runtime only: a chat awaiting sign-in, and the prompt to replay once signed in. */
  login: Record<string, AcpLoginCommand | null>
  pending: Record<string, string | null>
  /** Runtime only: chats whose provider/model changed, so the next prompt replays history. */
  replay: Record<string, boolean>

  newChat: (agent: AgentConfig, cwd?: string | null) => string
  selectChat: (id: string) => void
  deleteChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  setChatCwd: (id: string, cwd: string | null) => void
  /** Switch a chat to another configured provider (resets model, replays history). */
  setChatProvider: (id: string, agent: AgentConfig) => void
  /** Switch a chat's model within its provider (replays history so the agent continues). */
  setChatModel: (id: string, model: string) => void

  /** Send a prompt to an ACP chat and drive its full lifecycle (status, auth, errors). */
  sendAcpPrompt: (chatId: string, text: string) => Promise<void>
  /** Called when a chat's hosted login terminal exits: replay the pending prompt. */
  retryAfterLogin: (chatId: string) => void

  /** Router hook: fold a streamed update into a chat's transcript. */
  appendUpdate: (chatId: string, update: AcpUpdateBody) => void
}

function pushItem(state: ChatSessionsState, chatId: string, item: TranscriptItem): Record<string, TranscriptItem[]> {
  const cur = state.transcripts[chatId] ?? []
  return { ...state.transcripts, [chatId]: [...cur, item] }
}

/**
 * Prefix a prompt with the recent conversation so a freshly-spawned adapter (after a
 * provider/model switch, which restarts its subprocess) can continue in context. Only the
 * spoken turns are replayed, capped to the last several so the preamble stays bounded.
 */
function withReplay(items: TranscriptItem[], text: string): string {
  const turns = items
    .filter((i): i is Extract<TranscriptItem, { kind: 'user' | 'assistant' }> => i.kind === 'user' || i.kind === 'assistant')
    .slice(-12)
  if (turns.length === 0) return text
  const history = turns.map((i) => `${i.kind === 'user' ? 'User' : 'Assistant'}: ${i.text}`).join('\n')
  return `Continuing our earlier conversation. Here's what we said so far:\n\n${history}\n\n---\nUser: ${text}`
}

/** A short default title from the agent name, disambiguated by count. */
function defaultTitle(agent: AgentConfig, existing: ChatSession[]): string {
  const n = existing.filter((c) => c.agentId === agent.id).length
  return n === 0 ? agent.name : `${agent.name} ${n + 1}`
}

export const useChatSessionsStore = create<ChatSessionsState>()(
  persist(
    (set, get) => ({
      chats: [],
      activeId: null,
      transcripts: {},
      lastCwd: null,
      login: {},
      pending: {},
      replay: {},

      newChat: (agent, cwd) => {
        const id = crypto.randomUUID()
        const chat: ChatSession = {
          id,
          title: defaultTitle(agent, get().chats),
          agentId: agent.id,
          style: agent.style,
          adapter: agent.adapter,
          provider: agent.provider,
          model: visibleModels(agent)[0],
          cwd: cwd ?? get().lastCwd,
          createdAt: Date.now(),
          status: 'idle',
        }
        set((s) => ({
          chats: [chat, ...s.chats],
          activeId: id,
          transcripts: { ...s.transcripts, [id]: [] },
          lastCwd: chat.cwd ?? s.lastCwd,
        }))
        return id
      },

      selectChat: (id) => set({ activeId: id }),

      deleteChat: (id) =>
        set((s) => {
          getAcp()?.close(id)
          const chats = s.chats.filter((c) => c.id !== id)
          const transcripts = { ...s.transcripts }
          delete transcripts[id]
          const login = { ...s.login }
          delete login[id]
          const pending = { ...s.pending }
          delete pending[id]
          const replay = { ...s.replay }
          delete replay[id]
          const activeId = s.activeId === id ? (chats[0]?.id ?? null) : s.activeId
          return { chats, transcripts, login, pending, replay, activeId }
        }),

      renameChat: (id, title) =>
        set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)) })),

      setChatCwd: (id, cwd) =>
        set((s) => ({
          chats: s.chats.map((c) => (c.id === id ? { ...c, cwd } : c)),
          lastCwd: cwd ?? s.lastCwd,
        })),

      setChatProvider: (id, agent) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id === id
              ? {
                  ...c,
                  agentId: agent.id,
                  style: agent.style,
                  adapter: agent.adapter,
                  provider: agent.provider,
                  model: visibleModels(agent)[0],
                }
              : c,
          ),
          // A live conversation should carry over — the fresh adapter replays it (its
          // subprocess restarts on any provider/model change).
          replay: (s.transcripts[id]?.length ?? 0) > 0 ? { ...s.replay, [id]: true } : s.replay,
        })),

      setChatModel: (id, model) =>
        set((s) => ({
          chats: s.chats.map((c) => (c.id === id ? { ...c, model } : c)),
          replay: (s.transcripts[id]?.length ?? 0) > 0 ? { ...s.replay, [id]: true } : s.replay,
        })),

      sendAcpPrompt: async (chatId, text) => {
        const acp = getAcp()
        const chat = get().chats.find((c) => c.id === chatId)
        if (!acp || !chat || !chat.cwd) return
        // If the provider/model just changed, the adapter subprocess restarts with no memory
        // of this chat — prefix the prior transcript so it continues seamlessly ("replay").
        const replaying = !!get().replay[chatId]
        const toSend = replaying ? withReplay(get().transcripts[chatId] ?? [], text) : text
        set((s) => ({
          transcripts: pushItem(s, chatId, { kind: 'user', text }),
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, status: 'streaming' } : c)),
          replay: replaying ? { ...s.replay, [chatId]: false } : s.replay,
        }))
        try {
          const res = await acp.prompt({
            chatId,
            text: toSend,
            cwd: chat.cwd,
            adapter: chat.adapter,
            model: chat.model,
            // Chats persisted before `style` existed default to subscription. The key,
            // for `sdk` chats, is stored under the provider-row id (== agentId).
            auth: { style: chat.style ?? 'acp', provider: chat.provider, keyId: chat.agentId },
          })
          if (res.authRequired && res.login?.command) {
            // Park the prompt; the view hosts the login terminal and calls retryAfterLogin.
            set((s) => ({
              login: { ...s.login, [chatId]: res.login ?? null },
              pending: { ...s.pending, [chatId]: text },
              chats: s.chats.map((c) => (c.id === chatId ? { ...c, status: 'auth' } : c)),
              transcripts: pushItem(s, chatId, {
                kind: 'assistant',
                text: "Sign in to Claude below — I'll continue once you're logged in.",
              }),
            }))
            return
          }
          set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, status: 'idle' } : c)) }))
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'The agent failed.'
          set((s) => ({
            chats: s.chats.map((c) => (c.id === chatId ? { ...c, status: 'error' } : c)),
            transcripts: pushItem(s, chatId, { kind: 'assistant', text: `⚠ ${msg}` }),
          }))
        }
      },

      retryAfterLogin: (chatId) => {
        const text = get().pending[chatId]
        set((s) => ({
          login: { ...s.login, [chatId]: null },
          pending: { ...s.pending, [chatId]: null },
        }))
        if (text) {
          set((s) => ({
            transcripts: pushItem(s, chatId, { kind: 'assistant', text: 'Signed in — retrying…' }),
          }))
          void get().sendAcpPrompt(chatId, text)
        }
      },

      appendUpdate: (chatId, update) =>
        set((s) => {
          if (!s.transcripts[chatId] && !s.chats.some((c) => c.id === chatId)) return s
          const cur = s.transcripts[chatId] ?? []
          return { transcripts: { ...s.transcripts, [chatId]: reduceTranscript(cur, update) } }
        }),
    }),
    {
      name: 'zoetrope.chat-sessions',
      // Persist chats (status forced idle — the subprocess is gone after reload) and
      // transcripts; drop runtime-only login/pending.
      partialize: (s) => ({
        chats: s.chats.map((c) => ({ ...c, status: 'idle' as const })),
        activeId: s.activeId,
        transcripts: s.transcripts,
        lastCwd: s.lastCwd,
      }),
    },
  ),
)

// One app-wide ACP listener, installed lazily and idempotently. It routes every streamed
// update to its chat's transcript so BACKGROUND chats keep filling in. Desktop only.
let routerInstalled = false
export function ensureAcpRouter(): void {
  if (routerInstalled) return
  const acp = getAcp()
  if (!acp) return
  routerInstalled = true
  acp.onUpdate((env) => useChatSessionsStore.getState().appendUpdate(env.chatId, env.update))
}
