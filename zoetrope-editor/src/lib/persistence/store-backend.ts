/**
 * `DocumentStore` over SQLite: one library database, one database per
 * document. Runs wherever the databases are: in the store worker over OPFS in
 * the app, in memory in tests. Every call runs after the previous one
 * finished, so a commit never interleaves with another.
 */
import { DocDb, decode, encode, type CommitInfo, type Sql, type StoredEntry } from '../doc/commits'
import type { CommitRequest, DocumentStore } from './document-store'
import type { DerivedSummary, DocumentSummary, Project } from './document-summary'
import { LibraryDb } from './library-db'

export interface Databases {
  readonly library: Sql
  /** The document's database, opened. May close others to stay within the open-file limit. */
  document(id: string): Promise<Sql>
  /** Delete the document's database and its files. */
  remove(id: string): Promise<void>
}

const META_KEY = 'meta/document'

export class StoreBackend implements DocumentStore {
  readonly canPersist = true
  private readonly library: LibraryDb
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dbs: Databases,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.library = new LibraryDb(dbs.library)
  }

  private run<T>(op: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => {})
    return next
  }

  private async doc(id: string): Promise<DocDb> {
    return new DocDb(await this.dbs.document(id))
  }

  list(): Promise<DocumentSummary[]> {
    return this.run(() => this.library.list())
  }

  create(entries: StoredEntry[], summary: DerivedSummary): Promise<DocumentSummary> {
    return this.run(async () => {
      const id = this.newId()
      const at = this.now()
      await (await this.doc(id)).commit(entries, { full: true, label: 'create', time: at })
      return this.library.put(id, summary, at)
    })
  }

  duplicate(id: string): Promise<DocumentSummary | null> {
    return this.run(async () => {
      const source = this.library.get(id)
      if (!source) return null
      const dump = (await this.doc(id)).dump()
      const copyId = this.newId()
      const copy = await this.doc(copyId)
      copy.restore(dump)
      const name = `${source.name} copy`
      const at = this.now()
      await this.renameMeta(copy, name, at)
      return this.library.put(copyId, { name, pages: source.pages }, at)
    })
  }

  private async renameMeta(db: DocDb, name: string, at: number): Promise<void> {
    const entry = db.entriesAt()?.find((e) => e.key === META_KEY)
    const meta = entry ? decode<Record<string, unknown>>(entry.bytes) : {}
    await db.commit([{ key: META_KEY, bytes: encode({ ...meta, name }) }], { label: 'rename', time: at })
  }

  rename(id: string, name: string): Promise<void> {
    return this.run(async () => {
      const entry = this.library.get(id)
      if (!entry) return
      const at = this.now()
      await this.renameMeta(await this.doc(id), name, at)
      this.library.put(id, { name, pages: entry.pages }, at)
    })
  }

  remove(id: string): Promise<void> {
    return this.run(async () => {
      await this.dbs.remove(id)
      this.library.remove(id)
    })
  }

  setArchived(id: string, archived: boolean): Promise<void> {
    return this.run(() => this.library.setArchived(id, archived))
  }

  setProject(id: string, projectId: string | null): Promise<void> {
    return this.run(() => this.library.setProject(id, projectId))
  }

  listProjects(): Promise<Project[]> {
    return this.run(() => this.library.listProjects())
  }

  createProject(name: string): Promise<Project> {
    return this.run(() => {
      const project: Project = { id: this.newId(), name, createdAt: this.now() }
      this.library.createProject(project)
      return project
    })
  }

  renameProject(id: string, name: string): Promise<void> {
    return this.run(() => this.library.renameProject(id, name))
  }

  deleteProject(id: string): Promise<void> {
    return this.run(() => this.library.deleteProject(id))
  }

  getActiveId(): Promise<string | null> {
    return this.run(() => this.library.getActiveId())
  }

  setActiveId(id: string | null): Promise<void> {
    return this.run(() => this.library.setActiveId(id))
  }

  open(id: string): Promise<StoredEntry[] | null> {
    return this.run(async () => (this.library.get(id) ? (await this.doc(id)).entriesAt() : null))
  }

  commit(id: string, request: CommitRequest): Promise<CommitInfo | null> {
    return this.run(async () => {
      if (!this.library.get(id)) return null
      const at = this.now()
      const info = await (await this.doc(id)).commit(request.puts, { full: request.full, label: request.label, time: at })
      if (info) this.library.put(id, request.summary, at)
      return info
    })
  }

  log(id: string, limit?: number): Promise<CommitInfo[]> {
    return this.run(async () => (this.library.get(id) ? (await this.doc(id)).log(limit) : []))
  }

  historyOf(id: string, key: string): Promise<CommitInfo[]> {
    return this.run(async () => (this.library.get(id) ? (await this.doc(id)).historyOf(key) : []))
  }

  stateAt(id: string, commit: string): Promise<StoredEntry[] | null> {
    return this.run(async () => (this.library.get(id) ? (await this.doc(id)).entriesAt(commit) : null))
  }
}
