import { app, ipcMain, safeStorage } from 'electron'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KEYSTORE_CHANNELS,
  LLM_PROVIDERS,
  type KeyStoreStatus,
  type LlmProvider,
  type SetKeyRequest,
} from '../shared/byok'

/**
 * Main-process BYOK vault.
 *
 * The provider key is encrypted with the OS keychain (`safeStorage`) and written to
 * the per-user app-data dir; it is decryptable only on this machine/account. A tiny
 * plaintext sidecar holds non-secret metadata (provider/model/last4) used to render
 * status. The decrypted key is cached in this process only — it never crosses IPC.
 */

// Ciphertext of the API key.
const keyFile = () => join(app.getPath('userData'), 'byok.enc')
// Plaintext, non-secret metadata for status display.
const metaFile = () => join(app.getPath('userData'), 'byok.meta.json')

interface KeyMeta {
  provider: LlmProvider
  model: string
  last4: string
}

// Cached for the app lifetime so the provider call (D3) needn't re-hit the keychain.
let cachedKey: string | null = null
let cachedMeta: KeyMeta | null = null

function isProvider(x: unknown): x is LlmProvider {
  return typeof x === 'string' && (LLM_PROVIDERS as readonly string[]).includes(x)
}

/** Warm the in-memory cache from disk. Silent no-op if nothing is stored or it can't be read. */
async function loadFromDisk(): Promise<void> {
  cachedKey = null
  cachedMeta = null
  if (!safeStorage.isEncryptionAvailable()) return
  try {
    const meta = JSON.parse(await readFile(metaFile(), 'utf8')) as Partial<KeyMeta>
    if (!isProvider(meta.provider) || typeof meta.model !== 'string') return
    const key = safeStorage.decryptString(await readFile(keyFile()))
    cachedKey = key
    cachedMeta = { provider: meta.provider, model: meta.model, last4: meta.last4 ?? key.slice(-4) }
  } catch {
    // No stored key yet, or the file is missing/undecryptable — treat as "no key".
  }
}

function status(): KeyStoreStatus {
  const available = safeStorage.isEncryptionAvailable()
  if (!available || !cachedKey || !cachedMeta) return { available, hasKey: false }
  return {
    available,
    hasKey: true,
    provider: cachedMeta.provider,
    model: cachedMeta.model,
    last4: cachedMeta.last4,
  }
}

async function setKey(req: SetKeyRequest): Promise<KeyStoreStatus> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The OS keychain is unavailable on this system, so a key cannot be stored securely.')
  }
  if (!isProvider(req?.provider)) throw new Error(`Unknown provider: ${String(req?.provider)}`)
  const key = req.key?.trim() ?? ''
  const model = req.model?.trim() ?? ''
  if (!key) throw new Error('The API key is empty.')
  if (!model) throw new Error('The model is empty.')

  const cipher = safeStorage.encryptString(key)
  const meta: KeyMeta = { provider: req.provider, model, last4: key.slice(-4) }
  await writeFile(keyFile(), cipher)
  await writeFile(metaFile(), JSON.stringify(meta), 'utf8')
  cachedKey = key
  cachedMeta = meta
  return status()
}

async function clearKey(): Promise<KeyStoreStatus> {
  cachedKey = null
  cachedMeta = null
  await rm(keyFile(), { force: true })
  await rm(metaFile(), { force: true })
  return status()
}

/**
 * Read the live decrypted key + metadata for the provider call (D3). Main-process only —
 * do NOT expose this over IPC. Returns null when no key is stored.
 */
export function getActiveKey(): { key: string; meta: KeyMeta } | null {
  if (!cachedKey || !cachedMeta) return null
  return { key: cachedKey, meta: { ...cachedMeta } }
}

/** Register the keystore IPC handlers and warm the cache. Call once, after app `ready`. */
export async function registerByokIpc(): Promise<void> {
  await loadFromDisk()
  ipcMain.handle(KEYSTORE_CHANNELS.getStatus, () => status())
  ipcMain.handle(KEYSTORE_CHANNELS.set, (_event, req: SetKeyRequest) => setKey(req))
  ipcMain.handle(KEYSTORE_CHANNELS.clear, () => clearKey())
}
