/**
 * Build-mode chat panel — author interactions in plain language.
 *
 * The panel talks only to a ConversationSession (the backend-neutral port); it no
 * longer knows the transport. Today that's an ApiSession (live `claude` bridge with
 * an offline interpreter fallback); a TerminalSession can slot in behind the same
 * port later. On each turn it sends grounded context (nodes, selection, current IR)
 * and commits any returned IR via the same commitInteractions path the inspector
 * uses — so a chat-authored interaction shows up in the inspector and the preview.
 */

import { useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import { Sparkles, ArrowUp, MessageSquare, MousePointerClick, X } from 'lucide-react'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { ApiSession } from '../../renderer/interactions/session/api-session'
import { commitInteractions, getInteractions, getNodes, getSelection } from '../../renderer/interactions/capabilities'

export function ChatPanel() {
  const doc = useSnapshot(docProxy)
  const [session] = useState(() => new ApiSession())
  const [, bump] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastOffline, setLastOffline] = useState<boolean | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const messages = session.history()

  // Reactive selection summary for the compose chip (snapshot reads, not the
  // imperative capability layer — the chip must re-render as selection changes).
  const selectedIds = Array.from(doc.selectedIds)
  const selectionKey = selectedIds.join(',')
  const selPage = pid ? doc.pageMap.get(pid) : undefined
  const firstSelName =
    selectedIds[0] && selPage ? (selPage.objects[selectedIds[0]] as { name?: string } | undefined)?.name : undefined
  const selectionLabel =
    selectedIds.length === 0
      ? null
      : selectedIds.length === 1
        ? firstSelName || '1 selected'
        : `${firstSelName || 'node'} +${selectedIds.length - 1}`
  // Dismissal is keyed to the exact selection, so changing selection re-attaches.
  const showSelectionChip = selectionLabel !== null && dismissedKey !== selectionKey

  const scrollToBottom = () =>
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })

  const submit = async () => {
    const text = input.trim()
    if (!text || !pid || busy) return
    setInput('')
    setBusy(true)

    const nodes = getNodes(pid)
    const selection = showSelectionChip ? getSelection(pid) : []
    const ir = getInteractions(pid)

    // send() records the user turn synchronously, so this bump shows it at once.
    const pending = session.send({ text, nodes, selection, ir })
    bump((v) => v + 1)
    scrollToBottom()
    try {
      const result = await pending
      setLastOffline(result.offline ?? false)
      if (result.ir) commitInteractions(pid, result.ir)
    } finally {
      setBusy(false)
      setDismissedKey(null)
      bump((v) => v + 1)
      scrollToBottom()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">Chat</span>
        <span
          className="ml-auto flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground"
          title={`backend: ${session.backend} · structured output: ${session.caps.structuredOutput ? 'yes' : 'no'} · streaming: ${session.caps.streaming ? 'yes' : 'no'} · history: ${session.caps.history ? 'yes' : 'no'}`}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              lastOffline === null ? 'bg-muted-foreground/40' : lastOffline ? 'bg-amber-500' : 'bg-emerald-500',
            )}
            aria-hidden
          />
          {session.backend}
          {lastOffline !== null && <span className="normal-case">{lastOffline ? '· offline' : '· live'}</span>}
        </span>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 pb-2">
        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Describe an interaction, e.g. <span className="text-foreground">“when Add button is clicked, add an item to the todo list.”</span>
          </p>
        )}
        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <div
              key={i}
              className="max-w-[85%] self-end rounded-md bg-muted px-2.5 py-1.5 text-xs leading-snug text-foreground"
            >
              {msg.text}
            </div>
          ) : (
            <div key={i} className="flex max-w-[92%] gap-1.5 self-start">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-xs leading-snug text-foreground">{msg.text}</span>
            </div>
          ),
        )}
        {busy && (
          <div className="flex max-w-[92%] gap-1.5 self-start">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 animate-pulse text-muted-foreground" aria-hidden />
            <span className="text-xs leading-snug text-muted-foreground">thinking…</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-border p-2">
        {showSelectionChip && (
          <div className="flex flex-wrap gap-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
              <MousePointerClick className="size-3 shrink-0" aria-hidden />
              <span className="truncate text-foreground" title={`${selectionLabel} — sent with this message`}>
                {selectionLabel}
              </span>
              <button
                type="button"
                aria-label="Don't send the selection with this message"
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setDismissedKey(selectionKey)}
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
            placeholder="Describe an interaction…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            aria-label="Chat message"
          />
          <button
            type="button"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40',
            )}
            aria-label="Send"
            disabled={!input.trim() || busy}
            onClick={() => void submit()}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
