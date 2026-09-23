/**
 * The storage boundary the app talks to: the library (which documents exist,
 * projects, the last-open one) and each document's history (commits of its
 * records). Implemented over SQLite (`StoreBackend`), reached through a worker
 * in the app; `NoneDocumentStore` where nothing can be stored.
 */
import type { CommitInfo, Put, StoredEntry } from '../doc/commits'
import type { DerivedSummary, DocumentSummary, Project } from './document-summary'

export interface CommitRequest {
  puts: Put[]
  /** `puts` is the whole document: keys it leaves out are removed. */
  full?: boolean
  label?: string
  /** What the documents screen shows for the document after this commit. */
  summary: DerivedSummary
}

export interface DocumentStore {
  /** When false the app makes no persistence promises (blank boot, nothing saved). */
  readonly canPersist: boolean
  /** Every document, most recently updated first. */
  list(): Promise<DocumentSummary[]>
  /** Store a new document from its entries, under a fresh id. */
  create(entries: StoredEntry[], summary: DerivedSummary): Promise<DocumentSummary>
  /** Copy a document, history included, under a new id; null if the source is gone. */
  duplicate(id: string): Promise<DocumentSummary | null>
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
  /** The document's entries at its head, or null if it does not exist. */
  open(id: string): Promise<StoredEntry[] | null>
  /** Record a commit on the document's head; null when nothing changed. */
  commit(id: string, request: CommitRequest): Promise<CommitInfo | null>
  /** The head and its ancestors, newest first. */
  log(id: string, limit?: number): Promise<CommitInfo[]>
  /** The commits that changed record `key` (`kind/id`), newest first. */
  historyOf(id: string, key: string): Promise<CommitInfo[]>
  /** The document's entries at `commit`, or null if unknown. */
  stateAt(id: string, commit: string): Promise<StoredEntry[] | null>
}

/** Nothing is stored: one unsaved document for the session. */
export class NoneDocumentStore implements DocumentStore {
  readonly canPersist = false
  async list(): Promise<DocumentSummary[]> {
    return []
  }
  async create(_entries: StoredEntry[], summary: DerivedSummary): Promise<DocumentSummary> {
    return { id: 'ephemeral', ...summary, createdAt: 0, updatedAt: 0 }
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
  async open(): Promise<StoredEntry[] | null> {
    return null
  }
  async commit(): Promise<CommitInfo | null> {
    return null
  }
  async log(): Promise<CommitInfo[]> {
    return []
  }
  async historyOf(): Promise<CommitInfo[]> {
    return []
  }
  async stateAt(): Promise<StoredEntry[] | null> {
    return null
  }
}
