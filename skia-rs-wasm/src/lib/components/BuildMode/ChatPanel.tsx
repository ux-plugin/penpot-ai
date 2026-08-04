/**
 * AI chat — one unified, structured chat product (desktop).
 *
 * A single chat interface, not a set of modes: every conversation runs a coding agent
 * over ACP and renders the same structured transcript. Navigation is two-level to fit the
 * narrow rail — a History page (all your chats) opens into a Conversation, with a back
 * step. Prompt streaming, status and persistence live in the chat-sessions store, so chats
 * keep running in the background and survive reloads.
 *
 * This file is the interface shell. What the AI can *do* inside a conversation (author
 * interactions, edit files, run tools) surfaces as transcript content and is built later.
 * ACP is desktop-only (it spawns local processes), so on the web this shows a notice.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Sparkles, Plus, ChevronLeft, Search, Trash2, Folder, Bot } from 'lucide-react'
import { AcpView } from './AcpView'
import { getAcp, getAgent } from '../../renderer/desktop-bridge'
import { useAgentSettingsStore, type AgentConfig } from '../../renderer/store/agent-settings-store'
import { useChatSessionsStore, ensureAcpRouter, type ChatSession } from '../../renderer/store/chat-sessions-store'

function folderName(path: string): string {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/** Icon for an agent. All agents run over ACP; only the glyph differs. */
function AgentGlyph({ className }: { className?: string }) {
  return <Sparkles className={className} aria-hidden />
}

function StatusDot({ status }: { status: ChatSession['status'] }) {
  const cls =
    status === 'streaming'
      ? 'bg-emerald-500 animate-pulse'
      : status === 'auth'
        ? 'bg-amber-500'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-transparent'
  if (status === 'idle') return null
  return <span className={cn('size-1.5 shrink-0 rounded-full', cls)} aria-hidden />
}

/** The chat's short status line under its title. */
function statusLabel(chat: ChatSession, agentName: string): string {
  const where = chat.cwd ? folderName(chat.cwd) : 'no folder'
  if (chat.status === 'streaming') return `${agentName} · working…`
  if (chat.status === 'auth') return `${agentName} · sign-in needed`
  if (chat.status === 'error') return `${agentName} · error`
  return `${agentName} · ${where}`
}

export function ChatPanel() {
  const [acp] = useState(() => getAcp())
  const agents = useAgentSettingsStore((s) => s.agents)
  const chats = useChatSessionsStore((s) => s.chats)
  const activeId = useChatSessionsStore((s) => s.activeId)
  const newChat = useChatSessionsStore((s) => s.newChat)
  const selectChat = useChatSessionsStore((s) => s.selectChat)
  const deleteChat = useChatSessionsStore((s) => s.deleteChat)
  const setChatCwd = useChatSessionsStore((s) => s.setChatCwd)

  // History page first; opening a chat drops into its conversation.
  const [screen, setScreen] = useState<'history' | 'chat'>(activeId ? 'chat' : 'history')

  // Install the one app-wide ACP router so background chats keep streaming.
  useEffect(() => {
    if (acp) ensureAcpRouter()
  }, [acp])

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? 'Agent'
  // Only ACP-capable agents can start a chat; today that's Claude.
  const acpAgents = agents.filter((a) => a.kind === 'acp')
  const primary = acpAgents[0] ?? null

  // Search filters the History list (⌘K focuses it).
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats
    return chats.filter(
      (c) => c.title.toLowerCase().includes(q) || agentName(c.agentId).toLowerCase().includes(q),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, query, agents])

  const openChat = (id: string) => {
    selectChat(id)
    setScreen('chat')
  }

  const startChat = async (agent: AgentConfig) => {
    const id = newChat(agent)
    setScreen('chat')
    // First chat with no remembered folder: prompt for one right away.
    if (!useChatSessionsStore.getState().chats.find((c) => c.id === id)?.cwd) {
      const p = await getAgent()?.pickFolder()
      if (p) setChatCwd(id, p)
    }
  }

  // Keyboard shortcuts, scoped to while the chat panel is mounted. Dynamic values are read
  // through refs so the listener registers once and never goes stale; the store/setState
  // functions it calls are stable. ⌘-combos fire even from inputs (they can't be typed);
  // bare Escape is ignored while typing so it doesn't yank you out of the composer.
  const screenRef = useRef(screen)
  screenRef.current = screen
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const primaryRef = useRef(primary)
  primaryRef.current = primary
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const target = e.target as HTMLElement | null
      const typing = !!target?.closest('input, textarea, [contenteditable="true"]')
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setScreen('history')
        requestAnimationFrame(() => searchRef.current?.focus())
      } else if (mod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        if (primaryRef.current) void startChat(primaryRef.current)
      } else if (mod && e.key >= '1' && e.key <= '9') {
        const c = filteredRef.current[Number(e.key) - 1]
        if (c) {
          e.preventDefault()
          openChat(c.id)
        }
      } else if (e.key === 'Escape' && !typing && screenRef.current === 'chat') {
        setScreen('history')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Web (no desktop bridge): the ACP chat can't run here.
  if (!acp) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Bot className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-xs text-muted-foreground">
          AI chat runs in the desktop app, where it can work in your project folder.
        </p>
      </div>
    )
  }

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  if (screen === 'chat' && activeChat) {
    return (
      <ConversationScreen
        chat={activeChat}
        agentName={agentName(activeChat.agentId)}
        onBack={() => setScreen('history')}
        onPickFolder={async () => {
          const p = await getAgent()?.pickFolder()
          if (p) setChatCwd(activeChat.id, p)
        }}
        onDelete={() => {
          deleteChat(activeChat.id)
          setScreen('history')
        }}
      />
    )
  }

  return (
    <HistoryScreen
      chats={filtered}
      agents={acpAgents}
      agentName={agentName}
      query={query}
      onQueryChange={setQuery}
      searchRef={searchRef}
      onOpen={openChat}
      onDelete={deleteChat}
      onNew={startChat}
    />
  )
}

function HistoryScreen({
  chats,
  agents,
  agentName,
  query,
  onQueryChange,
  searchRef,
  onOpen,
  onDelete,
  onNew,
}: {
  chats: ChatSession[]
  agents: AgentConfig[]
  agentName: (id: string) => string
  query: string
  onQueryChange: (q: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onNew: (agent: AgentConfig) => void
}) {
  const primary = agents[0] ?? null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className="text-sm font-medium text-foreground">Chats</span>
        <button
          type="button"
          onClick={() => primary && onNew(primary)}
          disabled={!primary}
          className="ml-auto flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          aria-label="New chat"
          title={primary ? `New chat with ${primary.name} (⌘N)` : 'No agent configured'}
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1.5 focus-within:border-ring">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border bg-background px-1 text-[0.6rem] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5">
        {chats.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Sparkles className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-xs text-muted-foreground">
              {query.trim() ? 'No chats match your search.' : 'No chats yet. Start one below.'}
            </p>
          </div>
        ) : (
          chats.map((c) => (
            <div key={c.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/60">
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <AgentGlyph className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{c.title}</span>
                    <StatusDot status={c.status} />
                  </span>
                  <span className="block truncate text-[0.7rem] text-muted-foreground">
                    {statusLabel(c, agentName(c.agentId))}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label={`Delete ${c.title}`}
                title="Delete chat"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2.5">
        <span className="px-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">New chat with</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {agents.length === 0 && <span className="px-1 text-xs text-muted-foreground">No agent configured</span>}
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onNew(a)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[0.7rem] text-foreground transition-colors hover:bg-muted"
            >
              <AgentGlyph className="size-3.5 shrink-0 text-muted-foreground" />
              {a.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ConversationScreen({
  chat,
  agentName,
  onBack,
  onPickFolder,
  onDelete,
}: {
  chat: ChatSession
  agentName: string
  onBack: () => void
  onPickFolder: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back to chats"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{chat.title}</div>
          <div className="truncate text-[0.7rem] text-muted-foreground">{statusLabel(chat, agentName)}</div>
        </div>
        <button
          type="button"
          onClick={onPickFolder}
          title={chat.cwd ?? 'Choose a working folder'}
          className="inline-flex h-7 max-w-[40%] shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Folder className="size-3 shrink-0" aria-hidden />
          <span className="truncate text-foreground">{chat.cwd ? folderName(chat.cwd) : 'Folder…'}</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
          aria-label="Delete chat"
          title="Delete chat"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <AcpView chatId={chat.id} cwd={chat.cwd} />
      </div>
    </div>
  )
}
