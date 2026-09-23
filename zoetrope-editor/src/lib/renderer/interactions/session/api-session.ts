/**
 * ApiSession — the app-directed engine behind the ConversationSession port.
 *
 * Wraps the AI bridge (`aiChat`). It owns the conversation history; `send()`
 * records both turns and returns a structured `{ reply, behaviour }`. Committing
 * the behaviour stays with the caller (`replaceBehaviour`).
 *
 * This is the shipped path: same behavior the chat had inline, now reusable behind
 * the port. A TerminalSession can implement the same interface later without
 * touching the UI.
 */

import { EMPTY_BEHAVIOUR } from '../ir'
import { aiChat } from '../nl/ai-cli'
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
    const behaviour = input.behaviour ?? EMPTY_BEHAVIOUR
    const selectedId = selectionToId(input.selection)

    try {
      const result = await aiChat({ request: text, history: priorHistory, nodes, page: input.page ?? '', behaviour, selectedId })
      this.turns.push({ role: 'assistant', text: result.reply })
      return { reply: result.reply, behaviour: result.behaviour }
    } catch {
      const reply = 'The AI backend is not reachable.'
      this.turns.push({ role: 'assistant', text: reply })
      return { reply, offline: true }
    }
  }
}
