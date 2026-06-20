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
import { interpret, type InterpretContext } from '../../renderer/interactions/nl/interpret'
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = pid ? doc.pageMap.get(pid) : undefined

  const submit = () => {
    const text = input.trim()
    if (!text || !pid) return
    setInput('')

    const nodes = page
      ? (Object.values(page.objects) as IndexedShape[])
          .filter((o) => o.id !== ROOT_UUID)
          .map((o) => ({ id: o.id, name: o.name }))
      : []
    const sel = Array.from(doc.selectedIds)
    const ctx: InterpretContext = {
      nodes,
      ir: currentInteractions(pid) ?? emptyPageInteractions(),
      selectedId: sel.length === 1 ? sel[0] : null,
    }

    const result = interpret(text, ctx)
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: result.reply }])
    if (result.ok) {
      void commitInteractions(pid, result.apply(currentInteractions(pid) ?? emptyPageInteractions()))
    }
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
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
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
        <input
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
          placeholder="Describe an interaction…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          aria-label="Chat message"
        />
        <button
          type="button"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40',
          )}
          aria-label="Send"
          disabled={!input.trim()}
          onClick={submit}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}
