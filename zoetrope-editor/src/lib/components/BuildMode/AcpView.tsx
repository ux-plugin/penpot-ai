/**
 * ACP transcript view (one chat).
 *
 * A thin renderer over the chat-sessions store: it shows the chat's transcript, takes
 * input, and hosts the login terminal when the chat is blocked on auth. All prompt
 * orchestration (streaming, status, auth, retry) lives in the store, so a chat keeps
 * running even after this view unmounts (the user switches to another chat). Desktop only.
 */

import { useEffect, useRef, useState } from 'react'
import { Sparkles, ArrowUp, Terminal, FileDiff, ListChecks, CircleDot, LogIn, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatSessionsStore } from '../../renderer/store/chat-sessions-store'
import { useAgentSettingsStore, visibleModels } from '../../renderer/store/agent-settings-store'
import type { TranscriptItem } from '../../renderer/interactions/session/acp-transcript'
import { TerminalView } from './TerminalView'

function ToolIcon({ toolKind }: { toolKind?: string }) {
  if (toolKind === 'edit') return <FileDiff className="size-3.5 shrink-0" aria-hidden />
  if (toolKind === 'execute') return <Terminal className="size-3.5 shrink-0" aria-hidden />
  return <CircleDot className="size-3.5 shrink-0" aria-hidden />
}

function statusClass(status: string): string {
  if (status === 'completed') return 'text-emerald-600'
  if (status === 'failed') return 'text-destructive'
  if (status === 'in_progress') return 'text-amber-600'
  return 'text-muted-foreground'
}

/** A compact native <select> for the model bar. */
function BarSelect({
  value,
  onChange,
  disabled,
  ariaLabel,
  children,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full min-w-0 appearance-none truncate rounded-md border border-border bg-background pl-2 pr-6 text-[0.7rem] text-foreground outline-none transition-colors hover:bg-muted focus:border-ring disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

/**
 * Provider + model selectors for the open chat. Switching the provider re-points the chat
 * at another configured provider row (and its first visible model); switching the model
 * stays within the provider. Either change restarts the adapter and replays history, so the
 * conversation continues seamlessly.
 */
function ModelBar({ chatId }: { chatId: string }) {
  const agents = useAgentSettingsStore((s) => s.agents)
  const chat = useChatSessionsStore((s) => s.chats.find((c) => c.id === chatId))
  const setChatProvider = useChatSessionsStore((s) => s.setChatProvider)
  const setChatModel = useChatSessionsStore((s) => s.setChatModel)
  if (!chat) return null

  const current = agents.find((a) => a.id === chat.agentId)
  const models = current ? visibleModels(current) : []
  const modelValue = chat.model && models.includes(chat.model) ? chat.model : models[0] ?? ''

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <BarSelect
        ariaLabel="Provider"
        value={chat.agentId}
        onChange={(id) => {
          const next = agents.find((a) => a.id === id)
          if (next) setChatProvider(chatId, next)
        }}
      >
        {agents.length === 0 && <option value={chat.agentId}>No provider</option>}
        {!current && <option value={chat.agentId}>{chat.agentId}</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </BarSelect>
      <BarSelect
        ariaLabel="Model"
        value={modelValue}
        disabled={models.length === 0}
        onChange={(m) => setChatModel(chatId, m)}
      >
        {models.length === 0 ? (
          <option value="">No models</option>
        ) : (
          models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))
        )}
      </BarSelect>
    </div>
  )
}

export function AcpView({ chatId, cwd }: { chatId: string; cwd: string | null }) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const items = useChatSessionsStore((s) => s.transcripts[chatId]) ?? EMPTY
  const busy = useChatSessionsStore((s) => s.chats.find((c) => c.id === chatId)?.status === 'streaming')
  const login = useChatSessionsStore((s) => s.login[chatId] ?? null)
  const sendAcpPrompt = useChatSessionsStore((s) => s.sendAcpPrompt)
  const retryAfterLogin = useChatSessionsStore((s) => s.retryAfterLogin)

  const scrollToBottom = () =>
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })

  useEffect(() => {
    scrollToBottom()
  }, [items, busy])

  const submit = () => {
    const text = input.trim()
    if (!text || busy || !cwd || login) return
    setInput('')
    void sendAcpPrompt(chatId, text)
  }

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Choose a working folder to run the agent in.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 py-2">
        {items.length === 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Structured agent (ACP). Ask it to change code in the folder — you&apos;ll see its steps stream in.
          </p>
        )}
        {items.map((it: TranscriptItem, i: number) => {
          if (it.kind === 'user')
            return (
              <div key={i} className="max-w-[85%] self-end rounded-md bg-muted px-2.5 py-1.5 text-xs leading-snug">
                {it.text}
              </div>
            )
          if (it.kind === 'assistant')
            return (
              <div key={i} className="flex max-w-[92%] gap-1.5 self-start">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="whitespace-pre-wrap text-xs leading-snug">{it.text}</span>
              </div>
            )
          if (it.kind === 'thought')
            return (
              <div key={i} className="max-w-[92%] self-start pl-5 text-[0.7rem] italic leading-snug text-muted-foreground">
                {it.text}
              </div>
            )
          if (it.kind === 'plan')
            return (
              <div key={i} className="self-start rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs">
                <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-medium text-muted-foreground">
                  <ListChecks className="size-3.5" aria-hidden /> Plan
                </div>
                <ul className="space-y-0.5">
                  {it.entries.map((e, j) => (
                    <li key={j} className={cn('flex items-center gap-1.5', statusClass(e.status))}>
                      <CircleDot className="size-3 shrink-0" aria-hidden />
                      <span className="text-foreground">{e.content}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          // tool
          return (
            <div
              key={i}
              className="flex max-w-[92%] items-center gap-1.5 self-start rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-[0.7rem]"
            >
              <ToolIcon toolKind={it.toolKind} />
              <span className="truncate font-mono text-foreground">{it.title}</span>
              <span className={cn('ml-auto shrink-0', statusClass(it.status))}>{it.status}</span>
            </div>
          )
        })}
        {busy && (
          <div className="flex max-w-[92%] gap-1.5 self-start">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 animate-pulse text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">working…</span>
          </div>
        )}
      </div>

      {login && (
        <div className="shrink-0 border-t border-border">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.7rem] font-medium text-muted-foreground">
            <LogIn className="size-3.5" aria-hidden />
            {login.label ?? 'Sign in to Claude'} — complete the login here, then it continues automatically
          </div>
          <div className="h-52 p-2 pt-0">
            <TerminalView cwd={cwd} command={login.command} args={login.args} onExit={() => retryAfterLogin(chatId)} />
          </div>
        </div>
      )}

      <ModelBar chatId={chatId} />

      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <input
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring disabled:opacity-50"
          placeholder={login ? 'Signing in…' : 'Ask the agent…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          disabled={!!login}
          aria-label="Agent message"
        />
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          aria-label="Send"
          disabled={!input.trim() || busy || !!login}
          onClick={() => submit()}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}

// Stable empty reference so the selector doesn't return a fresh array each render.
const EMPTY: TranscriptItem[] = []
