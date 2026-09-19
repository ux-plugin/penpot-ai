/**
 * document-persistence — capability-gated storage for a library of documents.
 *
 * Persistence isn't universally available: a standalone web/desktop build can use
 * IndexedDB, but a Figma plugin sandbox or an embedded host may own (or forbid)
 * storage. So the app talks to a `DocumentPersistenceProvider` chosen by
 * environment capability — never a hardcoded backend. When the selected provider
 * reports `canPersist === false`, the app behaves exactly as it did before
 * persistence existed (blank document, no autosave, empty library).
 *
 * Layout in the KV: `doc:<id>` holds one document's envelope, `index` holds the
 * listable summaries, `active` holds the last-open id. The list is read from
 * `index` alone — drawing the documents screen never decodes a document.
 *
 * Documents are serialized with JSON, NOT structured clone: `getDocument()` can
 * carry valtio proxies in its node graph and `structuredClone` throws
 * DataCloneError on a proxy (the same trap scene3d-sync hit) — JSON reads straight
 * through. JSON is also what lets us version the envelope.
 */

import type { PenpotDocument } from 'penpot-exporter/types'
import { summarize, type DocumentSummary, type Project } from './document-summary'

export type { DocumentSummary, Project } from './document-summary'

export type PersistenceProviderId = 'indexeddb' | 'host' | 'none'

export interface DocumentPersistenceProvider {
  readonly id: PersistenceProviderId
  /** When false the app makes no persistence promises (blank boot, no autosave). */
  readonly canPersist: boolean
  /** Every stored document, most recently updated first. */
  list(): Promise<DocumentSummary[]>
  /** One document, or null if absent / unreadable / wrong schema. */
  load(id: string): Promise<PenpotDocument | null>
  /** Write a document and re-derive its index entry. */
  save(id: string, doc: PenpotDocument): Promise<void>
  /** Store a new document under a freshly minted id. */
  create(doc: PenpotDocument): Promise<DocumentSummary>
  /** Copy a document under a new id, or null if the source is gone. */
  duplicate(id: string): Promise<DocumentSummary | null>
  /** Rename without loading the whole document into the editor. */
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  /** Archive keeps the document but drops it out of the default list. */
  setArchived(id: string, archived: boolean): Promise<void>
  /** File a document under a project, or `null` to unfile it. */
  setProject(id: string, projectId: string | null): Promise<void>
  listProjects(): Promise<Project[]>
  createProject(name: string): Promise<Project>
  renameProject(id: string, name: string): Promise<void>
  /** Removes the project; its documents survive, unfiled. */
  deleteProject(id: string): Promise<void>
  getActiveId(): Promise<string | null>
  setActiveId(id: string | null): Promise<void>
}

/** The storage boundary a provider builds on: a minimal async string KV.
 *  IndexedDB-backed in the app; an in-memory map in tests. */
export interface KvStore {
  get(key: string): Promise<string | null>
  /** Every key currently stored. Only the index rebuild needs this — it's what
   *  lets the library be reconstructed from the documents themselves. */
  keys(): Promise<string[]>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// Bump on any breaking change to the persisted document shape — older envelopes
// then fail to decode and that document falls out of the library rather than
// loading incompatible content. v2: 3D moved from per-object entries to the
// scene-container model (node.scene3d is a Scene3DDocument).
//
// NOT bumped when documents moved from the single `current` key to `doc:<id>`:
// the envelope itself is byte-identical, only its key changed.
const SCHEMA_VERSION = 2

// The index is a derived cache, so it gets its own version independent of the
// document envelope. Bump it whenever `DocumentSummary` changes shape: a stale
// index is rebuilt from the documents rather than migrated, which is why no
// version-compatibility branch exists anywhere in this file.
// v3: entries carry per-page detail (`pages`) instead of pageCount/boardCount.
// v4: entries carry `archived` and `projectId`.
// Must differ from any version previously written — reusing a number would let
// an index with the older entry shape through.
const INDEX_VERSION = 4

const INDEX_KEY = 'index'
const PROJECTS_KEY = 'projects'
const ACTIVE_KEY = 'active'
const DOC_PREFIX = 'doc:'
const docKey = (id: string) => `${DOC_PREFIX}${id}`

/** The pre-library single-document key. Read once by `adoptLegacyDocument`, then
 *  deleted. Delete this constant and its call site once every local store has
 *  rolled over — nothing is deployed, so this is purely so an in-progress
 *  document on someone's machine survives the upgrade. */
const LEGACY_DOC_KEY = 'current'

interface Envelope {
  version: number
  savedAt: number
  doc: PenpotDocument
}

interface IndexEnvelope {
  version: number
  documents: DocumentSummary[]
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

/** When a document was last written, for rebuilding an index that lost its
 *  timestamps. Null when the envelope doesn't carry one. */
function readSavedAt(raw: string | null): number | null {
  if (!raw) return null
  try {
    const savedAt = (JSON.parse(raw) as Partial<Envelope>)?.savedAt
    return typeof savedAt === 'number' ? savedAt : null
  } catch {
    return null
  }
}

/** Newest first — the order the documents screen lists in. */
function byRecency(a: DocumentSummary, b: DocumentSummary): number {
  return b.updatedAt - a.updatedAt
}

/**
 * A provider backed by an async string KV. Read/clear failures degrade to "not
 * there" rather than trapping the app; save failures are logged. The index is a
 * derived cache: if it is missing, corrupt, or from an older summary shape it is
 * rebuilt from the `doc:` keys, so a damaged index costs a pass over the
 * documents rather than the library.
 */
export class KvDocumentProvider implements DocumentPersistenceProvider {
  readonly id: PersistenceProviderId
  readonly canPersist = true
  /** Guards the read-modify-write of `index` so concurrent saves can't drop each
   *  other's entries — autosave and an explicit action can overlap. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly kv: KvStore,
    id: PersistenceProviderId = 'indexeddb',
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.id = id
  }

  /** Serialize index mutations. Every method that touches `index` goes through
   *  here, so the read-modify-write is never interleaved. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => {})
    return run
  }

  /** The index, or null when it is absent, corrupt, or from an older summary
   *  shape — all three mean "rebuild", never "the library is empty". */
  private async readIndex(): Promise<DocumentSummary[] | null> {
    try {
      const raw = await this.kv.get(INDEX_KEY)
      if (!raw) return null
      const envelope = JSON.parse(raw) as Partial<IndexEnvelope>
      if (envelope?.version !== INDEX_VERSION) return null
      if (!Array.isArray(envelope.documents)) return null
      const entries = envelope.documents.filter(
        (d): d is DocumentSummary => typeof d?.id === 'string' && Array.isArray(d?.pages),
      )
      // Dropping entries means the index disagrees with what this build expects,
      // whatever its version claims. Rebuild rather than quietly serving a
      // shorter library — a version number someone forgot to bump must not read
      // as "you have no documents".
      return entries.length === envelope.documents.length ? entries : null
    } catch (err) {
      console.error('[persistence] index read failed', err)
      return null
    }
  }

  /**
   * Reconstruct the index from the stored documents. The index is a cache over
   * the `doc:` keys, so it is always derivable — losing it costs one pass over
   * the documents, not data. This stands in for a migration: change the summary
   * shape, bump INDEX_VERSION, and the next read rebuilds itself.
   *
   * `createdAt` isn't recoverable (it only ever lived in the index), so the
   * envelope's `savedAt` stands in for both timestamps.
   */
  private async rebuildIndex(): Promise<DocumentSummary[]> {
    const documents: DocumentSummary[] = []
    for (const key of await this.kv.keys()) {
      if (!key.startsWith(DOC_PREFIX)) continue
      const raw = await this.kv.get(key)
      const doc = decodeDocument(raw)
      if (!doc) continue
      const savedAt = readSavedAt(raw) ?? this.now()
      documents.push({
        id: key.slice(DOC_PREFIX.length),
        ...summarize(doc),
        createdAt: savedAt,
        updatedAt: savedAt,
      })
    }
    await this.writeIndex(documents)
    return documents
  }

  /** The index, rebuilt first if it can't be trusted. */
  private async loadIndex(): Promise<DocumentSummary[]> {
    return (await this.readIndex()) ?? (await this.rebuildIndex())
  }

  private async writeIndex(documents: DocumentSummary[]): Promise<void> {
    const envelope: IndexEnvelope = { version: INDEX_VERSION, documents }
    await this.kv.set(INDEX_KEY, JSON.stringify(envelope))
  }

  /**
   * One-way pickup of the pre-library `current` document. Runs only when there is
   * a legacy document AND no index yet, so it cannot fire twice or shadow a real
   * library. Deleting the legacy key is what makes it idempotent.
   */
  private async adoptLegacyDocument(documents: DocumentSummary[]): Promise<DocumentSummary[]> {
    if (documents.length) return documents
    const legacy = decodeDocument(await this.kv.get(LEGACY_DOC_KEY))
    if (!legacy) return documents
    const at = this.now()
    const summary: DocumentSummary = {
      id: this.newId(),
      ...summarize(legacy),
      createdAt: at,
      updatedAt: at,
    }
    await this.kv.set(docKey(summary.id), encodeDocument(legacy, at))
    await this.writeIndex([summary])
    await this.kv.delete(LEGACY_DOC_KEY)
    return [summary]
  }

  async list(): Promise<DocumentSummary[]> {
    return this.enqueue(async () => {
      try {
        const documents = await this.adoptLegacyDocument(await this.loadIndex())
        return [...documents].sort(byRecency)
      } catch (err) {
        console.error('[persistence] list failed', err)
        return []
      }
    })
  }

  async load(id: string): Promise<PenpotDocument | null> {
    try {
      return decodeDocument(await this.kv.get(docKey(id)))
    } catch (err) {
      console.error('[persistence] load failed', err)
      return null
    }
  }

  /** Write the document and re-derive its index entry. Returns the entry as
   *  stored, so callers never have to recompute (and drift from) it. */
  private async writeDocument(id: string, doc: PenpotDocument): Promise<DocumentSummary | null> {
    try {
      const at = this.now()
      await this.kv.set(docKey(id), encodeDocument(doc, at))
      const documents = await this.loadIndex()
      const existing = documents.find((d) => d.id === id)
      // `summarize` derives only what the document itself knows. Anything the
      // *library* knows — where it's filed, whether it's archived — has to be
      // carried forward explicitly, or the next autosave silently unfiles and
      // unarchives the document.
      const entry: DocumentSummary = {
        id,
        ...summarize(doc),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        ...(existing?.archived ? { archived: true } : {}),
        ...(existing?.projectId ? { projectId: existing.projectId } : {}),
      }
      await this.writeIndex([entry, ...documents.filter((d) => d.id !== id)])
      return entry
    } catch (err) {
      console.error('[persistence] save failed', err)
      return null
    }
  }

  async save(id: string, doc: PenpotDocument): Promise<void> {
    await this.enqueue(() => this.writeDocument(id, doc))
  }

  async create(doc: PenpotDocument): Promise<DocumentSummary> {
    const id = this.newId()
    const entry = await this.enqueue(() => this.writeDocument(id, doc))
    // A failed write still yields a usable id: the session opens the document in
    // memory and the next autosave retries the store.
    return entry ?? { id, ...summarize(doc), createdAt: this.now(), updatedAt: this.now() }
  }

  async duplicate(id: string): Promise<DocumentSummary | null> {
    const source = await this.load(id)
    if (!source) return null
    const documents = await this.list()
    const sourceName = documents.find((d) => d.id === id)?.name ?? source.name
    return this.create({ ...source, name: `${sourceName} copy` })
  }

  async rename(id: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const documents = await this.loadIndex()
        if (!documents.some((d) => d.id === id)) return
        const at = this.now()
        await this.writeIndex(
          documents.map((d) => (d.id === id ? { ...d, name, updatedAt: at } : d)),
        )
        // Keep the stored document in step with its entry, so opening it later
        // doesn't resurrect the old name.
        const doc = decodeDocument(await this.kv.get(docKey(id)))
        if (doc) await this.kv.set(docKey(id), encodeDocument({ ...doc, name }, at))
      } catch (err) {
        console.error('[persistence] rename failed', err)
      }
    })
  }

  /** Patch one index entry in place. Archive and filing never touch the stored
   *  document — they're library facts, not document content. */
  private async patchEntry(
    id: string,
    patch: (entry: DocumentSummary) => DocumentSummary,
  ): Promise<void> {
    return this.enqueue(async () => {
      try {
        const documents = await this.loadIndex()
        if (!documents.some((d) => d.id === id)) return
        await this.writeIndex(documents.map((d) => (d.id === id ? patch(d) : d)))
      } catch (err) {
        console.error('[persistence] entry patch failed', err)
      }
    })
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    // Archiving deliberately leaves `updatedAt` alone: it isn't an edit, and
    // bumping it would shuffle the document to the top of the list on its way
    // out of it.
    await this.patchEntry(id, ({ archived: _was, ...rest }) =>
      archived ? { ...rest, archived: true } : rest,
    )
  }

  async setProject(id: string, projectId: string | null): Promise<void> {
    await this.patchEntry(id, ({ projectId: _was, ...rest }) =>
      projectId ? { ...rest, projectId } : rest,
    )
  }

  private async readProjects(): Promise<Project[]> {
    try {
      const raw = await this.kv.get(PROJECTS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (p): p is Project => typeof p?.id === 'string' && typeof p?.name === 'string',
      )
    } catch (err) {
      console.error('[persistence] projects read failed', err)
      return []
    }
  }

  async listProjects(): Promise<Project[]> {
    return this.enqueue(async () =>
      [...(await this.readProjects())].sort((a, b) => a.name.localeCompare(b.name)),
    )
  }

  async createProject(name: string): Promise<Project> {
    const project: Project = { id: this.newId(), name, createdAt: this.now() }
    await this.enqueue(async () => {
      try {
        await this.kv.set(PROJECTS_KEY, JSON.stringify([...(await this.readProjects()), project]))
      } catch (err) {
        console.error('[persistence] project create failed', err)
      }
    })
    return project
  }

  async renameProject(id: string, name: string): Promise<void> {
    await this.enqueue(async () => {
      try {
        const projects = await this.readProjects()
        await this.kv.set(
          PROJECTS_KEY,
          JSON.stringify(projects.map((p) => (p.id === id ? { ...p, name } : p))),
        )
      } catch (err) {
        console.error('[persistence] project rename failed', err)
      }
    })
  }

  async deleteProject(id: string): Promise<void> {
    await this.enqueue(async () => {
      try {
        const projects = await this.readProjects()
        await this.kv.set(PROJECTS_KEY, JSON.stringify(projects.filter((p) => p.id !== id)))
        // Documents outlive their project — deleting a folder must never delete
        // what's in it. They come back as unfiled.
        const documents = await this.loadIndex()
        if (documents.some((d) => d.projectId === id)) {
          await this.writeIndex(
            documents.map(({ projectId, ...rest }) =>
              projectId === id ? rest : { ...rest, projectId },
            ),
          )
        }
      } catch (err) {
        console.error('[persistence] project delete failed', err)
      }
    })
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.kv.delete(docKey(id))
        await this.writeIndex((await this.loadIndex()).filter((d) => d.id !== id))
        if ((await this.kv.get(ACTIVE_KEY)) === id) await this.kv.delete(ACTIVE_KEY)
      } catch (err) {
        console.error('[persistence] remove failed', err)
      }
    })
  }

  async getActiveId(): Promise<string | null> {
    try {
      return await this.kv.get(ACTIVE_KEY)
    } catch (err) {
      console.error('[persistence] active read failed', err)
      return null
    }
  }

  async setActiveId(id: string | null): Promise<void> {
    try {
      if (id === null) await this.kv.delete(ACTIVE_KEY)
      else await this.kv.set(ACTIVE_KEY, id)
    } catch (err) {
      console.error('[persistence] active write failed', err)
    }
  }
}

/** No-op provider: the environment can't (or shouldn't) persist. The app still
 *  runs — it just holds one unsaved document for the session. */
export class NonePersistenceProvider implements DocumentPersistenceProvider {
  readonly id = 'none' as const
  readonly canPersist = false
  async list(): Promise<DocumentSummary[]> {
    return []
  }
  async load(): Promise<PenpotDocument | null> {
    return null
  }
  async save(): Promise<void> {}
  async create(doc: PenpotDocument): Promise<DocumentSummary> {
    return { id: 'ephemeral', ...summarize(doc), createdAt: 0, updatedAt: 0 }
  }
  async duplicate(): Promise<DocumentSummary | null> {
    return null
  }
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
  async setArchived(): Promise<void> {}
  async setProject(): Promise<void> {}
  async listProjects(): Promise<Project[]> {
    return []
  }
  async createProject(name: string): Promise<Project> {
    return { id: 'ephemeral', name, createdAt: 0 }
  }
  async renameProject(): Promise<void> {}
  async deleteProject(): Promise<void> {}
  async getActiveId(): Promise<string | null> {
    return null
  }
  async setActiveId(): Promise<void> {}
}

/**
 * Seam for a host-owned store — a Figma plugin sandbox or embedded host that
 * exposes its own persistence (e.g. `figma.clientStorage`, or postMessage to the
 * host). Not implemented: there's no host bridge in this build, so the probe
 * never selects it. When a bridge exists, flesh this out and flip `canPersist`.
 */
export class HostPersistenceProvider implements DocumentPersistenceProvider {
  readonly id = 'host' as const
  readonly canPersist = false
  async list(): Promise<DocumentSummary[]> {
    return []
  }
  async load(): Promise<PenpotDocument | null> {
    return null
  }
  async save(): Promise<void> {}
  async create(doc: PenpotDocument): Promise<DocumentSummary> {
    return { id: 'ephemeral', ...summarize(doc), createdAt: 0, updatedAt: 0 }
  }
  async duplicate(): Promise<DocumentSummary | null> {
    return null
  }
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
  async setArchived(): Promise<void> {}
  async setProject(): Promise<void> {}
  async listProjects(): Promise<Project[]> {
    return []
  }
  async createProject(name: string): Promise<Project> {
    return { id: 'ephemeral', name, createdAt: 0 }
  }
  async renameProject(): Promise<void> {}
  async deleteProject(): Promise<void> {}
  async getActiveId(): Promise<string | null> {
    return null
  }
  async setActiveId(): Promise<void> {}
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
    return new KvDocumentProvider(makeKv('zoetrope-editor', 'documents'), 'indexeddb')
  }
  return new NonePersistenceProvider()
}
