/**
 * document-persistence — capability-gated whole-document persistence.
 *
 * Persistence isn't universally available: a standalone web/desktop build can use
 * IndexedDB, but a Figma plugin sandbox or an embedded host may own (or forbid)
 * storage. So the app talks to a `DocumentPersistenceProvider` chosen by
 * environment capability — never a hardcoded backend. When the selected provider
 * reports `canPersist === false`, the app behaves exactly as it did before
 * persistence existed (blank document on boot, no autosave).
 *
 * The document graph is serialized with JSON, NOT structured clone: `getDocument()`
 * can carry valtio proxies in its node graph and `structuredClone` throws
 * DataCloneError on a proxy (the same trap scene3d-sync hit) — JSON reads straight
 * through. JSON is also what lets us version the envelope.
 */

import type { PenpotDocument } from 'penpot-exporter/types'

export type PersistenceProviderId = 'indexeddb' | 'host' | 'none'

export interface DocumentPersistenceProvider {
  readonly id: PersistenceProviderId
  /** When false the app makes no persistence promises (blank boot, no autosave). */
  readonly canPersist: boolean
  /** The stored document, or null if absent / unreadable / wrong schema. */
  load(): Promise<PenpotDocument | null>
  save(doc: PenpotDocument): Promise<void>
  clear(): Promise<void>
}

/** The storage boundary a provider builds on: a minimal async string KV.
 *  IndexedDB-backed in the app; an in-memory map in tests. */
export interface KvStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const SCHEMA_VERSION = 1
const DOC_KEY = 'current'

interface Envelope {
  version: number
  savedAt: number
  doc: PenpotDocument
}

/** Serialize a document for storage (versioned envelope, JSON). */
export function encodeDocument(doc: PenpotDocument, savedAt: number): string {
  const envelope: Envelope = { version: SCHEMA_VERSION, savedAt, doc }
  return JSON.stringify(envelope)
}

/** Parse stored text → document, or null if absent / corrupt / wrong version. */
export function decodeDocument(raw: string | null): PenpotDocument | null {
  if (!raw) return null
  try {
    const envelope = JSON.parse(raw) as Partial<Envelope>
    if (!envelope || envelope.version !== SCHEMA_VERSION || !envelope.doc) return null
    return envelope.doc as PenpotDocument
  } catch {
    return null
  }
}

/** A provider backed by an async string KV. Read/clear failures degrade to "no
 *  saved document" rather than trapping the app; save failures are logged. */
export class KvDocumentProvider implements DocumentPersistenceProvider {
  readonly id: PersistenceProviderId
  readonly canPersist = true

  constructor(
    private readonly kv: KvStore,
    id: PersistenceProviderId = 'indexeddb',
    private readonly now: () => number = () => Date.now(),
  ) {
    this.id = id
  }

  async load(): Promise<PenpotDocument | null> {
    try {
      return decodeDocument(await this.kv.get(DOC_KEY))
    } catch (err) {
      console.error('[persistence] load failed', err)
      return null
    }
  }

  async save(doc: PenpotDocument): Promise<void> {
    try {
      await this.kv.set(DOC_KEY, encodeDocument(doc, this.now()))
    } catch (err) {
      console.error('[persistence] save failed', err)
    }
  }

  async clear(): Promise<void> {
    try {
      await this.kv.delete(DOC_KEY)
    } catch (err) {
      console.error('[persistence] clear failed', err)
    }
  }
}

/** No-op provider: the environment can't (or shouldn't) persist. Current behaviour. */
export class NonePersistenceProvider implements DocumentPersistenceProvider {
  readonly id = 'none' as const
  readonly canPersist = false
  async load(): Promise<PenpotDocument | null> {
    return null
  }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}

/**
 * Seam for a host-owned store — a Figma plugin sandbox or embedded host that
 * exposes its own persistence (e.g. `figma.clientStorage`, or postMessage to the
 * host). Not implemented: there's no host bridge in this build, so the probe
 * never selects it. When a bridge exists, flesh this out and flip `hasHostBridge`.
 */
export class HostPersistenceProvider implements DocumentPersistenceProvider {
  readonly id = 'host' as const
  readonly canPersist = false
  async load(): Promise<PenpotDocument | null> {
    return null
  }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}

/** Whether an embedded-host persistence bridge is present. Always false today;
 *  this is where a Figma-plugin / desktop host would be detected. Kept minimal so
 *  it can later defer to a richer `platform.ts` capability layer. */
function hasHostBridge(): boolean {
  return false
}

/** Pick the provider for the current environment. */
export function selectPersistenceProvider(
  makeKv: (db: string, store: string) => KvStore,
): DocumentPersistenceProvider {
  if (hasHostBridge()) return new HostPersistenceProvider()
  if (typeof indexedDB !== 'undefined') {
    return new KvDocumentProvider(makeKv('skia-rs-wasm', 'documents'), 'indexeddb')
  }
  return new NonePersistenceProvider()
}
