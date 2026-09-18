/**
 * ApiSession — the app-directed engine behind the ConversationSession port.
 *
 * Wraps the existing AI bridge (`aiChat` → dev-server `/__ai-chat` → `claude`),
 * falling back to the rule-based `interpret` stub when the bridge is down. It owns
 * the conversation history; `send()` records both turns and returns a structured
 * `{ reply, ir }`. Committing the IR stays with the caller, which knows the page id.
 *
 * This is the shipped path: same behavior the chat had inline, now reusable behind
 * the port. A TerminalSession can implement the same interface later without
 * touching the UI.
 */

import { emptyPageInteractions } from '../ir'
import { aiChat } from '../nl/ai-cli'
import { interpret } from '../nl/interpret'
import { hasSecureKeyStore } from '../../platform'
import type { Backend, ConversationSession, SendInput, SendResult, SessionCaps, Turn } from './types'

const API_CAPS: SessionCaps = {
  streaming: false,
  history: true,
  compact: false,
  switchContext: false,
  structuredOutput: true,
  toolUse: false,
  canBYOK: hasSecureKeyStore(),
}

function selectionToId(selection?: { id: string }[]): string | null {
  return selection && selection.length === 1 ? selection[0].id : null
}

export class ApiSession implements ConversationSession {
  readonly backend: Backend = 'api'
  readonly caps = API_CAPS
  private turns: Turn[] = []

  history(): Turn[] {
    // Fresh array each call so consumers (and the React Compiler) see new content.
    return this.turns.slice()
  }

  async send(input: SendInput): Promise<SendResult> {
    const text = input.text.trim()
    if (!text) return { reply: '' }

    const priorHistory = this.turns.map((t) => ({ role: t.role, text: t.text }))
    this.turns.push({ role: 'user', text })

    const nodes = input.nodes ?? []
    const ir = input.ir ?? emptyPageInteractions()
    const selectedId = selectionToId(input.selection)

    try {
      // Live AI session via the local `claude` CLI (dev-server bridge).
      const result = await aiChat({ request: text, history: priorHistory, nodes, ir, selectedId })
      this.turns.push({ role: 'assistant', text: result.reply })
      return { reply: result.reply, ir: result.ir }
    } catch {
      // Bridge down / CLI missing — fall back to the rule-based interpreter.
      const r = interpret(text, { nodes: nodes.map((n) => ({ id: n.id, name: n.name })), ir, selectedId })
      const reply = `${r.reply}  (offline — basic interpreter)`
      this.turns.push({ role: 'assistant', text: reply })
      return { reply, ir: r.ok ? r.apply(ir) : undefined, offline: true }
    }
  }
}
