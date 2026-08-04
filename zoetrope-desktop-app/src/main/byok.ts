import { app, ipcMain, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KEYSTORE_CHANNELS,
  LLM_PROVIDERS,
  type KeyStoreStatus,
  type LlmProvider,
  type SetKeyRequest,
  type StoredKeyInfo,
} from '../shared/byok'

/**
 * Main-process BYOK vault.
 *
 * Holds one API key PER provider row (keyed by the agent-settings provider id), so
 * several rows — even of the same vendor, custom-named — each carry their own key. All
 * keys are encrypted together with the OS keychain (`safeStorage`) into a single blob in
 * the per-user app-data dir, decryptable only on this machine/account. A plaintext
 * sidecar holds non-secret metadata (provider/last4) for status display. Decrypted keys
 * are cached in this process only — they never cross IPC.
 */

// Ciphertext of the JSON key map `{ [rowId]: key }`.
const keyFile = () => join(app.getPath('userData'), 'byok.enc')
// Plaintext, non-secret metadata for status display.
const metaFile = () => join(app.getPath('userData'), 'byok.meta.json')

interface Entry {
  key: string
  provider: LlmProvider
  last4: string
}

// Cached for the app lifetime so provider calls needn't re-hit the keychain. Keyed by row id.
const cache = new Map<string, Entry>()

function isProvider(x: unknown): x is LlmProvider {
  return typeof x === 'string' && (LLM_PROVIDERS as readonly string[]).includes(x)
}

/** Warm the in-memory cache from disk. Silent no-op if nothing is stored or it can't be read. */
async function loadFromDisk(): Promise<void> {
  cache.clear()
  if (!safeStorage.isEncryptionAvailable()) return
  try {
    const meta = JSON.parse(await readFile(metaFile(), 'utf8')) as Record<string, Partial<StoredKeyInfo>>
    const keys = JSON.parse(safeStorage.decryptString(await readFile(keyFile()))) as Record<string, unknown>
    for (const [id, info] of Object.entries(meta)) {
      const key = keys[id]
      if (typeof key !== 'string' || !isProvider(info?.provider)) continue
      cache.set(id, { key, provider: info.provider, last4: info.last4 ?? key.slice(-4) })
    }
  } catch {
    // No stored keys yet, or the files are missing/undecryptable — treat as empty.
  }
}

/** Encrypt the whole key map + write the metadata sidecar. */
async function persist(): Promise<void> {
  const keys: Record<string, string> = {}
  const meta: Record<string, StoredKeyInfo> = {}
  for (const [id, e] of cache) {
    keys[id] = e.key
    meta[id] = { provider: e.provider, last4: e.last4 }
  }
  await writeFile(keyFile(), safeStorage.encryptString(JSON.stringify(keys)))
  await writeFile(metaFile(), JSON.stringify(meta), 'utf8')
}

function status(): KeyStoreStatus {
  const available = safeStorage.isEncryptionAvailable()
  if (!available) return { available, keys: {} }
  const keys: Record<string, StoredKeyInfo> = {}
  for (const [id, e] of cache) keys[id] = { provider: e.provider, last4: e.last4 }
  return { available, keys }
}

async function setKey(req: SetKeyRequest): Promise<KeyStoreStatus> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The OS keychain is unavailable on this system, so a key cannot be stored securely.')
  }
  const id = req?.id?.trim() ?? ''
  if (!id) throw new Error('Missing provider id.')
  if (!isProvider(req?.provider)) throw new Error(`Unknown provider: ${String(req?.provider)}`)
  const key = req.key?.trim() ?? ''
  if (!key) throw new Error('The API key is empty.')

  cache.set(id, { key, provider: req.provider, last4: key.slice(-4) })
  await persist()
  return status()
}

async function clearKey(id: string): Promise<KeyStoreStatus> {
  cache.delete(id)
  await persist()
  return status()
}

/**
 * Read the live decrypted key for a provider call. Main-process only — do NOT expose over
 * IPC. With an `id`, returns that row's key; without, the first stored key (legacy chat
 * fallback, which has no row concept). Returns null when nothing matches.
 */
export function getActiveKey(id?: string): { key: string; provider: LlmProvider } | null {
  const e = id ? cache.get(id) : cache.values().next().value
  return e ? { key: e.key, provider: e.provider } : null
}

/** Register the keystore IPC handlers and warm the cache. Call once, after app `ready`. */
export async function registerByokIpc(): Promise<void> {
  await loadFromDisk()
  ipcMain.handle(KEYSTORE_CHANNELS.getStatus, () => status())
  ipcMain.handle(KEYSTORE_CHANNELS.set, (_event, req: SetKeyRequest) => setKey(req))
  ipcMain.handle(KEYSTORE_CHANNELS.clear, (_event, id: string) => clearKey(id))
}
