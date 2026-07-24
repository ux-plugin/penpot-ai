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

interface ZoetropeBridge {
  keyStore: KeyStoreBridge
  chat: ChatBridge
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
