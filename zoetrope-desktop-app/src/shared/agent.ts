/**
 * Shared contract for the desktop AI-agent bridge.
 *
 * A terminal-based AI CLI (Claude Code, aider, opencode, …) is run HEADLESS in the
 * Electron main process and its output is surfaced in the Build-mode chat as a
 * `TerminalSession` (same `ConversationSession` port as the platform chat). We host
 * the process; the CLI owns its own auth/keys/models — nothing is routed through us.
 *
 * An agent is defined by an argv template containing the `{prompt}` placeholder, so
 * the user's message is passed as a single argv element (no shell string-interpolation,
 * hence no quoting/injection pitfalls). Presets are best-effort; the user can edit them.
 */

/** A runnable agent: a display name + argv where exactly one element is `{prompt}`. */
export interface AgentPreset {
  id: string
  name: string
  /** argv template, e.g. ['claude', '-p', '{prompt}']. */
  argv: string[]
}

export const PROMPT_TOKEN = '{prompt}'

/**
 * Best-effort presets for common headless AI CLIs. Flags aim at non-interactive,
 * print-the-result behavior. The user can override any argv in settings.
 */
export const AGENT_PRESETS: readonly AgentPreset[] = [
  { id: 'claude', name: 'Claude Code', argv: ['claude', '-p', PROMPT_TOKEN] },
  { id: 'aider', name: 'aider', argv: ['aider', '--yes', '--message', PROMPT_TOKEN] },
  { id: 'opencode', name: 'opencode', argv: ['opencode', 'run', PROMPT_TOKEN] },
  { id: 'codex', name: 'Codex CLI', argv: ['codex', 'exec', PROMPT_TOKEN] },
  { id: 'gemini', name: 'Gemini CLI', argv: ['gemini', '-p', PROMPT_TOKEN] },
]

/** Whether a preset's binary is on PATH — drives the launcher's enabled state. */
export interface DetectedAgent {
  id: string
  name: string
  argv: string[]
  /** Resolved absolute path of argv[0], or null when not found on PATH. */
  path: string | null
}

export interface AgentRunRequest {
  /** argv template with a single `{prompt}` element. */
  argv: string[]
  /** The user's message, substituted for `{prompt}`. */
  prompt: string
  /** Working directory to run in. */
  cwd: string
}

export interface AgentRunResponse {
  /** Combined assistant text (stdout, trimmed). */
  text: string
  exitCode: number
  /** Present when the process wrote to stderr or failed, for surfacing errors. */
  stderr?: string
}

/** IPC channel names for the agent bridge. */
export const AGENT_CHANNELS = {
  run: 'zoetrope:agent:run',
  detect: 'zoetrope:agent:detect',
  pickFolder: 'zoetrope:agent:pick-folder',
} as const

/** The `agent` API exposed on `window.zoetrope`. */
export interface AgentBridge {
  /** Which presets are installed on PATH (for the launcher). */
  detect(): Promise<DetectedAgent[]>
  /** Run one headless completion. Rejects on spawn failure. */
  run(req: AgentRunRequest): Promise<AgentRunResponse>
  /** Open a native folder picker; returns the chosen path, or null if cancelled. */
  pickFolder(): Promise<string | null>
}
