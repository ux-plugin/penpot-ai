/**
 * `DocumentStore` in the store worker (./store.worker.ts). Calls are posted
 * in order and answered in order. When the store cannot start (no OPFS, or
 * another tab holds the files) every call fails and `storeError` says why.
 */
import { signal } from '@preact/signals-core'
import type { CommitInfo, StoredEntry } from '../doc/commits'
import type { CommitRequest, DocumentStore } from './document-store'
import type { DerivedSummary, DocumentSummary, Project } from './document-summary'

type Methods = {
  [K in keyof DocumentStore]: DocumentStore[K] extends (...a: never[]) => unknown ? K : never
}[keyof DocumentStore]

export interface StoreCall {
  id: number
  method: Methods
  args: unknown[]
}

export interface StoreReply {
  id: number
  result?: unknown
  error?: string
}

/** Why the store is unavailable, or null while it works. */
export const storeError = signal<string | null>(null)

export class WorkerDocumentStore implements DocumentStore {
  readonly canPersist = true
  private readonly worker: Worker
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor() {
    this.worker = new Worker(new URL('./store.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<StoreReply>) => {
      const { id, result, error } = e.data
      if (id === -1) {
        storeError.value = error ?? 'the document store did not start'
        console.error('[persistence] store unavailable:', storeError.peek())
        return
      }
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (error !== undefined) p.reject(new Error(error))
      else p.resolve(result)
    }
  }

  private call<T>(method: Methods, ...args: unknown[]): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ id, method, args } satisfies StoreCall)
    })
  }

  list() {
    return this.call<DocumentSummary[]>('list')
  }
  create(entries: StoredEntry[], summary: DerivedSummary) {
    return this.call<DocumentSummary>('create', entries, summary)
  }
  duplicate(id: string) {
    return this.call<DocumentSummary | null>('duplicate', id)
  }
  rename(id: string, name: string) {
    return this.call<void>('rename', id, name)
  }
  remove(id: string) {
    return this.call<void>('remove', id)
  }
  setArchived(id: string, archived: boolean) {
    return this.call<void>('setArchived', id, archived)
  }
  setProject(id: string, projectId: string | null) {
    return this.call<void>('setProject', id, projectId)
  }
  listProjects() {
    return this.call<Project[]>('listProjects')
  }
  createProject(name: string) {
    return this.call<Project>('createProject', name)
  }
  renameProject(id: string, name: string) {
    return this.call<void>('renameProject', id, name)
  }
  deleteProject(id: string) {
    return this.call<void>('deleteProject', id)
  }
  getActiveId() {
    return this.call<string | null>('getActiveId')
  }
  setActiveId(id: string | null) {
    return this.call<void>('setActiveId', id)
  }
  open(id: string) {
    return this.call<StoredEntry[] | null>('open', id)
  }
  commit(id: string, request: CommitRequest) {
    return this.call<CommitInfo | null>('commit', id, request)
  }
  log(id: string, limit?: number) {
    return this.call<CommitInfo[]>('log', id, limit)
  }
  historyOf(id: string, key: string) {
    return this.call<CommitInfo[]>('historyOf', id, key)
  }
  stateAt(id: string, commit: string) {
    return this.call<StoredEntry[] | null>('stateAt', id, commit)
  }
}
