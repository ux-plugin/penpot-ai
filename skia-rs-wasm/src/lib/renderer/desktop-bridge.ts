/**
 * Typed access to the Electron desktop bridge (`window.zoetrope`), exposed by the
 * zoetrope-desktop-app preload. Absent in a plain browser (accessors return null),
 * which is what keeps BYOK desktop-only.
 *
 * The shapes below MIRROR `zoetrope-desktop-app/src/shared/byok.ts` — the two packages
 * don't share a module, so keep them in sync by hand.
 */

export type LlmProvider = 'anthropic' | 'openai' | 'google'

export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai', 'google']

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}

/** Non-secret view of the stored key. */
export interface KeyStoreStatus {
  available: boolean
  hasKey: boolean
  provider?: LlmProvider
  model?: string
  last4?: string
}

export interface SetKeyRequest {
  provider: LlmProvider
  model: string
  key: string
}

export interface KeyStoreBridge {
  getStatus(): Promise<KeyStoreStatus>
  set(req: SetKeyRequest): Promise<KeyStoreStatus>
  clear(): Promise<KeyStoreStatus>
}

export interface ChatBridge {
  complete(req: { prompt: string }): Promise<{ text: string }>
}

/** A terminal-based AI CLI preset detected on PATH. `path` is null when not installed. */
export interface DetectedAgent {
  id: string
  name: string
  argv: string[]
  path: string | null
}

export interface AgentRunRequest {
  argv: string[]
  prompt: string
  cwd: string
}

export interface AgentRunResponse {
  text: string
  exitCode: number
  stderr?: string
}

/** Runs a headless terminal AI CLI in the main process (desktop only). */
export interface AgentBridge {
  detect(): Promise<DetectedAgent[]>
  run(req: AgentRunRequest): Promise<AgentRunResponse>
  pickFolder(): Promise<string | null>
}

export interface PtyCreateRequest {
  cwd: string
  cols: number
  rows: number
  shell?: string
  /** Run a specific command instead of an interactive shell (e.g. an agent login). */
  command?: string
  args?: string[]
}

/** An interactive shell (node-pty) in the main process (desktop only). */
export interface PtyBridge {
  create(req: PtyCreateRequest): Promise<number>
  write(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  onData(id: number, cb: (data: string) => void): () => void
  onExit(id: number, cb: (exitCode: number) => void): () => void
}

/** The body of a streamed ACP `session/update` notification (loosely typed — see AcpView). */
export interface AcpUpdateBody {
  sessionUpdate: string
  content?: { type: string; text?: string }
  // tool_call / tool_call_update
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  // plan
  entries?: { content: string; status: string; priority?: string }[]
}

/** A streamed update tagged with its owning chat, so parallel chats route independently. */
export interface AcpUpdateEnvelope {
  chatId: string
  update: AcpUpdateBody
}

/** The adapter a chat runs; omitted → the bundled Claude Code adapter. */
export interface AcpAgentSpec {
  command?: string
  args?: string[]
  label?: string
}

/** A terminal-auth login command to host in a terminal (from the agent). */
export interface AcpLoginCommand {
  command: string
  args: string[]
  label?: string
}

export interface AcpPromptResult {
  stopReason: string
  /** Set when the agent needs authentication before it can run. */
  authRequired?: boolean
  login?: AcpLoginCommand
}

export interface AcpPromptRequest {
  /** The chat this prompt belongs to — selects/creates its own agent session. */
  chatId: string
  text: string
  cwd: string
  agent?: AcpAgentSpec
}

/** Drives structured coding agents over ACP in the main process (desktop only). */
export interface AcpBridge {
  prompt(req: AcpPromptRequest): Promise<AcpPromptResult>
  cancel(chatId: string): void
  close(chatId: string): void
  onUpdate(cb: (envelope: AcpUpdateEnvelope) => void): () => void
}

interface ZoetropeBridge {
  keyStore: KeyStoreBridge
  chat: ChatBridge
  agent: AgentBridge
  pty: PtyBridge
  acp: AcpBridge
}

function bridge(): ZoetropeBridge | null {
  if (typeof window === 'undefined') return null
  const z = (window as unknown as { zoetrope?: Partial<ZoetropeBridge> }).zoetrope
  return z && z.keyStore ? (z as ZoetropeBridge) : null
}

/** The keychain-backed key store, or null on the web. */
export function getKeyStore(): KeyStoreBridge | null {
  return bridge()?.keyStore ?? null
}

/** The main-process BYOK chat call, or null on the web. */
export function getDesktopChat(): ChatBridge | null {
  return bridge()?.chat ?? null
}

/** The main-process AI-agent runner, or null on the web. */
export function getAgent(): AgentBridge | null {
  return bridge()?.agent ?? null
}

/** The main-process interactive terminal, or null on the web. */
export function getPty(): PtyBridge | null {
  return bridge()?.pty ?? null
}

/** The main-process ACP coding agent, or null on the web. */
export function getAcp(): AcpBridge | null {
  return bridge()?.acp ?? null
}
