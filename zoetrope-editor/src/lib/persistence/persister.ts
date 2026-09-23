/**
 * Writes the document in the editor to its store as commits.
 *
 * Every applied change marks its record; when no undo group is open and the
 * edits have gone quiet for `idleMs`, the marked records are written as one
 * commit (a drag, a scrub: one commit, not sixty). Undo and redo are edits
 * like any other and commit too. When the whole document is swapped in memory
 * without coming from the store (a seed, an import), the next commit writes
 * every record, so the store never holds a mix of two documents.
 */
import { effect } from '@preact/signals-core'
import { groupOpen, onChangesApplied, onDocumentReplaced } from '../doc'
import type { DocumentStore } from './document-store'
import { summarizeLive } from './document-summary'
import { liveEntries, META_KEY, putOf, recordKey } from './records'

export interface Persister {
  /** The document now in the editor was just loaded from the store as `id`. */
  attach(id: string): void
  /** Write what is pending, then stop writing to the current document. */
  detach(): Promise<void>
  /** Write what is pending now, open group or not, and wait for every write so far. */
  flush(): Promise<void>
  /** The document commits go to, or null. */
  documentId(): string | null
  dispose(): void
}

export function startPersister(store: DocumentStore, idleMs = 200): Persister {
  let docId: string | null = null
  let pending = new Set<string>()
  let full = false
  let label: string | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let writes: Promise<unknown> = Promise.resolve()

  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    cancel()
    timer = setTimeout(() => void write(), idleMs)
  }

  const write = (force = false): Promise<unknown> => {
    cancel()
    const id = docId
    if (!id || (!full && pending.size === 0) || (groupOpen.peek() && !force)) return writes
    const puts = full ? liveEntries() : [...pending].map(putOf)
    const request = { puts, full, label, summary: summarizeLive() }
    pending = new Set()
    full = false
    label = undefined
    writes = writes
      .then(() => store.commit(id, request))
      .catch((err: unknown) => console.error('[persistence] commit failed', err))
    return writes
  }

  const offApplied = onChangesApplied((event) => {
    if (!docId) return
    for (const a of event.applied) {
      const c = a.change
      pending.add(recordKey(c.kind, c.op === 'add' ? c.record.id : c.id))
    }
    if (event.docMeta.length) pending.add(META_KEY)
    label ??= event.label
    schedule()
  })

  const offReplaced = onDocumentReplaced(() => {
    if (!docId) return
    full = true
    pending = new Set()
    schedule()
  })

  const offGroup = effect(() => {
    if (!groupOpen.value && docId && (full || pending.size)) schedule()
  })

  const onHide = () => void write(true)
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide)

  return {
    attach(id) {
      cancel()
      docId = id
      pending = new Set()
      full = false
      label = undefined
    },
    async detach() {
      await write(true)
      docId = null
    },
    async flush() {
      await write(true)
    },
    documentId: () => docId,
    dispose() {
      cancel()
      offApplied()
      offReplaced()
      offGroup()
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide)
    },
  }
}
