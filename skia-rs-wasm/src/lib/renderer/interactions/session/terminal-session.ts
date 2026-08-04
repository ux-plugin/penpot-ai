/**
 * TerminalSession — the terminal-agent engine behind the ConversationSession port.
 *
 * Runs a user-chosen terminal-based AI CLI (Claude Code, aider, …) HEADLESS in the
 * Electron main process (via the desktop `agent` bridge) and surfaces its output as
 * chat. Same port as ApiSession, so the Build-mode ChatPanel renders it with no
 * UI changes — only the session behind the panel differs.
 *
 * Desktop-only: `getAgent()` is null in a plain browser. The selected agent + working
 * directory are owned by the UI and supplied through the `config` callback, so the
 * session always reads the latest selection.
 */

import { getAgent } from '../../desktop-bridge'
import type { Backend, ConversationSession, SendInput, SendResult, SessionCaps, Turn } from './types'

const TERMINAL_CAPS: SessionCaps = {
  streaming: false,
  history: true,
  compact: false,
  switchContext: false,
  // The CLI edits files / prints prose — it does not return our `{ reply, ir }` IR.
  structuredOutput: false,
  toolUse: true,
  canBYOK: true,
}

export interface TerminalAgentConfig {
  /** argv template with exactly one `{prompt}` element. */
  argv: string[]
  /** Working directory to run the agent in. */
  cwd: string
}

export class TerminalSession implements ConversationSession {
  readonly backend: Backend = 'terminal'
  readonly caps = TERMINAL_CAPS
  private turns: Turn[] = []

  /** `config` returns the currently-selected agent + cwd, or null when unset. */
  constructor(private readonly config: () => TerminalAgentConfig | null) {}

  history(): Turn[] {
    return this.turns.slice()
  }

  async send(input: SendInput): Promise<SendResult> {
    const text = input.text.trim()
    if (!text) return { reply: '' }
    this.turns.push({ role: 'user', text })

    const agent = getAgent()
    const cfg = this.config()
    if (!agent || !cfg) {
      const reply = 'Choose an agent and a working folder to run it in.'
      this.turns.push({ role: 'assistant', text: reply })
      return { reply, offline: true }
    }

    try {
      const res = await agent.run({ argv: cfg.argv, prompt: text, cwd: cfg.cwd })
      const base = res.text || (res.exitCode !== 0 ? `The agent exited with code ${res.exitCode}.` : '(no output)')
      // Surface stderr only when there's no usable stdout, so real errors aren't hidden.
      const reply = res.stderr && !res.text ? `${base}\n${res.stderr}` : base
      this.turns.push({ role: 'assistant', text: reply })
      return { reply }
    } catch (e) {
      const reply = e instanceof Error ? `Couldn't run the agent: ${e.message}` : "Couldn't run the agent."
      this.turns.push({ role: 'assistant', text: reply })
      return { reply, offline: true }
    }
  }
}
