/**
 * Shared contract for the ACP (Agent Client Protocol) bridge.
 *
 * The Build-mode chat's ACP view drives a structured coding agent. The Electron main
 * process spawns the `@zed-industries/claude-code-acp` adapter (which wraps the Claude
 * Agent SDK — bundled binary, subscription auth via the user's own `claude` login) and
 * speaks ACP JSON-RPC over its stdio. Structured `session/update` notifications are
 * forwarded to the renderer, which renders them as a transcript (message chunks, tool
 * calls, plans). The prompt string goes renderer→main; the agent owns tool execution.
 *
 * Every message is keyed by `chatId`: main holds one ACP session (subprocess) PER chat,
 * so several chats run in parallel and each streams into its own transcript. A `chatId`
 * is an opaque renderer-chosen string (one per chat in the history).
 */

/**
 * The agent adapter a chat runs. When omitted, main spawns the bundled
 * `claude-code-acp` adapter with Electron's Node. A `command` overrides it with an
 * arbitrary ACP adapter executable (future: other ACP-speaking agents).
 */
export interface AcpAgentSpec {
  command?: string
  args?: string[]
  /** Human label, surfaced in errors/logs. */
  label?: string
}

/**
 * How this chat's agent authenticates. `acp` = the user's subscription (own `claude`
 * login); `sdk` = a BYOK provider key, which main injects into the adapter env from the
 * keychain vault — the key never travels over IPC, only the provider is named here.
 */
export interface AcpAuth {
  style: 'acp' | 'sdk'
  provider?: string
  /** `sdk` only — the provider-row id whose stored key main should inject. */
  keyId?: string
}

export interface AcpPromptRequest {
  /** Which chat this prompt belongs to — selects/creates its own agent session. */
  chatId: string
  text: string
  cwd: string
  /** A custom adapter executable for this chat; omitted → a registry adapter. */
  agent?: AcpAgentSpec
  /** Registry adapter id to run (subscription/`acp` style); omitted → Claude Code. */
  adapter?: string
  /** How the chat authenticates; omitted → subscription. */
  auth?: AcpAuth
  /** Model id to run (Anthropic → injected as `ANTHROPIC_MODEL`); omitted → adapter default. */
  model?: string
}

/** A terminal-auth login command the client hosts in a terminal (from the agent). */
export interface AcpLoginCommand {
  command: string
  args: string[]
  label?: string
}

export interface AcpPromptResponse {
  /** ACP stop reason for the turn (e.g. "end_turn", "max_tokens"). */
  stopReason: string
  /** Set when the agent needs authentication before it can run. */
  authRequired?: boolean
  /** The login command to run in a hosted terminal (present with authRequired). */
  login?: AcpLoginCommand
}

/** main → renderer: a streamed ACP notification, tagged with its owning chat. */
export interface AcpUpdateEnvelope {
  chatId: string
  /** The raw ACP SessionNotification (loosely typed; see the renderer's AcpView). */
  update: unknown
}

/** A known ACP adapter and whether it's present. The renderer never sees how it launches. */
export interface DetectedAdapter {
  id: string
  label: string
  /** Tier 1 — present on this machine (bundled, or found on PATH). */
  available: boolean
  /** Shown for unavailable adapters. */
  installHint?: string
}

/** Result of the Tier-2 handshake: did the adapter actually speak ACP? */
export interface AdapterTestResult {
  ok: boolean
  /** Round-trip of a successful `initialize`, ms. */
  ms?: number
  error?: string
}

export const ACP_CHANNELS = {
  prompt: 'zoetrope:acp:prompt',
  cancel: 'zoetrope:acp:cancel',
  /** renderer → main: tear down a chat's session (subprocess) when it's closed. */
  close: 'zoetrope:acp:close',
  /** main → renderer: AcpUpdateEnvelope (chatId + raw SessionNotification). */
  update: 'zoetrope:acp:update',
  /** renderer → main: list known adapters + presence (Tier 1). */
  listAdapters: 'zoetrope:acp:list-adapters',
  /** renderer → main: verify an adapter speaks ACP via `initialize` (Tier 2). */
  testAdapter: 'zoetrope:acp:test-adapter',
} as const

/** The `acp` API exposed on `window.zoetrope`. */
export interface AcpBridge {
  /** Send a prompt to a chat's agent (starts/reuses its session in `cwd`). */
  prompt(req: AcpPromptRequest): Promise<AcpPromptResponse>
  /** Interrupt a chat's current turn. */
  cancel(chatId: string): void
  /** Kill a chat's agent session (subprocess). Call when the chat is deleted. */
  close(chatId: string): void
  /** Subscribe to streamed updates for all chats; filter by `chatId`. Returns unsubscribe. */
  onUpdate(cb: (envelope: AcpUpdateEnvelope) => void): () => void
  /** List known ACP adapters and whether each is present (Tier 1). */
  listAdapters(): Promise<DetectedAdapter[]>
  /** Verify an adapter actually speaks ACP via an `initialize` handshake (Tier 2). */
  testAdapter(id: string): Promise<AdapterTestResult>
}
