/**
 * Build-mode chat panel — author interactions in plain language.
 *
 * On submit it calls the NL interpreter with grounded context (the page's nodes,
 * current IR, selection), then commits the resulting IR edit via the same
 * commitInteractions path the inspector uses — so a chat-authored interaction
 * shows up in the inspector and the preview reacts. The interpreter is a stub
 * today; swapping in Claude changes nothing here.
 */

import { useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import { Sparkles, ArrowUp, MessageSquare } from 'lucide-react'
import type { IndexedShape } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { emptyPageInteractions } from '../../renderer/interactions/ir'
import { interpret } from '../../renderer/interactions/nl/interpret'
import { aiChat } from '../../renderer/interactions/nl/ai-cli'
import { commitInteractions, currentInteractions } from '../../renderer/interactions/document/commit-interactions'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

interface Msg {
  role: 'user' | 'assistant'
  text: string
}

export function ChatPanel() {
  const doc = useSnapshot(docProxy)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = pid ? doc.pageMap.get(pid) : undefined

  const scrollToBottom = () =>
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })

  const submit = async () => {
    const text = input.trim()
    if (!text || !pid || busy) return
    setInput('')
    const history = messages
    setMessages((m) => [...m, { role: 'user', text }])
    setBusy(true)
    scrollToBottom()

    const nodes = page
      ? (Object.values(page.objects) as IndexedShape[])
          .filter((o) => o.id !== ROOT_UUID)
          .map((o) => ({ id: o.id, name: o.name, type: (o as { type?: string }).type }))
      : []
    const sel = Array.from(doc.selectedIds)
    const selectedId = sel.length === 1 ? sel[0] : null
    const ir = currentInteractions(pid) ?? emptyPageInteractions()

    try {
      // Real AI session via the local `claude` CLI (dev-server bridge).
      const result = await aiChat({ request: text, history, nodes, ir, selectedId })
      setMessages((m) => [...m, { role: 'assistant', text: result.reply }])
      if (result.ir) void commitInteractions(pid, result.ir)
    } catch {
      // Endpoint down / CLI missing — fall back to the rule-based interpreter.
      const r = interpret(text, { nodes: nodes.map((n) => ({ id: n.id, name: n.name })), ir, selectedId })
      setMessages((m) => [...m, { role: 'assistant', text: `${r.reply}  (offline — basic interpreter)` }])
      if (r.ok) void commitInteractions(pid, r.apply(currentInteractions(pid) ?? emptyPageInteractions()))
    } finally {
      setBusy(false)
      scrollToBottom()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">Chat</span>
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

      <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
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
  )
}
