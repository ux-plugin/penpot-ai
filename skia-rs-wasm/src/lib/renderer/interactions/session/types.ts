/**
 * ConversationSession — the backend-neutral port the Build-mode chat talks to.
 *
 * The UI knows only this interface; it never knows the transport. An ApiSession
 * (live `claude` bridge / Agent SDK) and a future TerminalSession (user-driven
 * PTY) both implement it. `caps` lets the UI show/hide affordances a given
 * backend can't do, so one panel serves both engines without branching on type.
 */

import type { PageInteractions } from '../ir'

export type Backend = 'api' | 'terminal'

/** What a given backend can do — the UI gates affordances on these. */
export interface SessionCaps {
  /** Replies arrive incrementally (vs. one final result). */
  streaming: boolean
  /** The session owns a readable conversation history. */
  history: boolean
  /** Conversations can be compacted. */
  compact: boolean
  /** The session can switch to another context/thread. */
  switchContext: boolean
  /** Replies can carry a structured `{ reply, ir }` payload. */
  structuredOutput: boolean
  /** The model can call tools (MCP). */
  toolUse: boolean
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/** A user message plus the grounding context an adapter may use. */
export interface SendInput {
  text: string
  nodes?: { id: string; name?: string; type?: string }[]
  selection?: { id: string; name?: string; type?: string }[]
  ir?: PageInteractions
}

export interface SendResult {
  reply: string
  /** Present only when the backend returned a usable full IR. */
  ir?: PageInteractions
  /** True when the reply came from an offline fallback, not the live backend. */
  offline?: boolean
}

export interface ConversationSession {
  readonly backend: Backend
  readonly caps: SessionCaps
  send(input: SendInput): Promise<SendResult>
  history(): Turn[]
}
