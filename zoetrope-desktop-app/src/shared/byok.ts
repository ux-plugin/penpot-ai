/**
 * Shared contract for the desktop BYOK (bring-your-own-key) bridge.
 *
 * The renderer (zoetrope-editor) manages a provider API key by talking to the Electron
 * main process over these IPC channels. The key is encrypted at rest with the OS
 * keychain (`safeStorage`) and held only in the main process: the renderer sends the
 * key in once (on save) and otherwise sees only non-secret status/metadata. The
 * provider call itself runs in main (D3) so the plaintext key never lives in renderer JS.
 */

import type { AgentBridge } from './agent'
import type { PtyBridge } from './pty'
import type { AcpBridge } from './acp'

export type LlmProvider = 'anthropic' | 'openai' | 'google'

export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai', 'google']

/** Non-secret metadata for one stored key. */
export interface StoredKeyInfo {
  provider: LlmProvider
  /** Last 4 chars of the key, for display only. */
  last4: string
}

/**
 * Non-secret view of the vault — safe to hand to the renderer. Keys are scoped to the
 * provider *row* (`id` = the agent-settings provider id), so several rows — even of the
 * same vendor, custom-named to tell them apart in chat — each hold their own key.
 */
export interface KeyStoreStatus {
  /** Whether the OS keychain can encrypt on this machine. `false` → BYOK unavailable. */
  available: boolean
  /** Stored keys by provider-row id (non-secret metadata only). */
  keys: Record<string, StoredKeyInfo>
}

/** Payload for saving a key — the only message that carries the secret. */
export interface SetKeyRequest {
  /** The provider-row id this key belongs to. */
  id: string
  provider: LlmProvider
  key: string
}

/** IPC channel names for the keystore half of the bridge. */
export const KEYSTORE_CHANNELS = {
  getStatus: 'zoetrope:keystore:get-status',
  set: 'zoetrope:keystore:set',
  clear: 'zoetrope:keystore:clear',
} as const

/** The `keyStore` API exposed on `window.zoetrope`. */
export interface KeyStoreBridge {
  getStatus(): Promise<KeyStoreStatus>
  set(req: SetKeyRequest): Promise<KeyStoreStatus>
  /** Remove the key for one provider row. */
  clear(id: string): Promise<KeyStoreStatus>
}

/** IPC channel names for the chat half of the bridge. */
export const CHAT_CHANNELS = {
  complete: 'zoetrope:chat:complete',
} as const

/**
 * A single non-streaming completion. The renderer builds the whole prompt (domain
 * context + history + request) into `prompt`; main runs the provider call with the
 * stored key and returns the full assistant text. Matches the web facade's contract,
 * which the renderer already consumes as one reply (`SessionCaps.streaming = false`).
 */
export interface ChatCompleteRequest {
  prompt: string
}

export interface ChatCompleteResponse {
  text: string
}

/** The `chat` API exposed on `window.zoetrope`. Runs the provider call in main (BYOK). */
export interface ChatBridge {
  complete(req: ChatCompleteRequest): Promise<ChatCompleteResponse>
}

/** The whole `window.zoetrope` surface. */
export interface ZoetropeApi {
  keyStore: KeyStoreBridge
  chat: ChatBridge
  agent: AgentBridge
  pty: PtyBridge
  acp: AcpBridge
}
