/**
 * The document as stored entries: every record under `kind/id`, plus the
 * document fields that are not records yet under `meta/document`, each as
 * canonical bytes.
 */
import {
  BEHAVIOUR_KINDS,
  KINDS,
  meta,
  tables,
  type AnyRecord,
  type DocumentMeta,
  type DocumentRecords,
  type Imported,
  type Kind,
  type Node,
  type Page,
} from '../doc'
import { decode, encode, splitKey, type Put, type StoredEntry } from '../doc/commits'

export const META_KEY = 'meta/document'

export const recordKey = (kind: Kind, id: string): string => `${kind}/${id}`

/** The write for `key` as the document holds it now: its bytes, or a removal. */
export function putOf(key: string): Put {
  if (key === META_KEY) {
    const m = meta.peek()
    return { key, bytes: m ? encode(m) : null }
  }
  const [kind, id] = splitKey(key)
  const record = tables[kind as Kind]?.rows.get(id)?.peek()
  return { key, bytes: record ? encode(record) : null }
}

/** Every entry of the document in the editor. */
export function liveEntries(): StoredEntry[] {
  const out: StoredEntry[] = []
  const m = meta.peek()
  if (m) out.push({ key: META_KEY, bytes: encode(m) })
  for (const kind of KINDS) {
    for (const s of tables[kind].rows.values()) {
      const r = s.peek() as AnyRecord
      out.push({ key: recordKey(kind, r.id), bytes: encode(r) })
    }
  }
  return out
}

/** Every entry of an imported document. */
export function entriesOfImported(im: Imported): StoredEntry[] {
  const out: StoredEntry[] = [{ key: META_KEY, bytes: encode(im.meta) }]
  for (const p of im.pages) out.push({ key: recordKey('page', p.id), bytes: encode(p) })
  for (const n of im.nodes) out.push({ key: recordKey('node', n.id), bytes: encode(n) })
  for (const kind of BEHAVIOUR_KINDS) {
    for (const r of im.records[kind] ?? []) out.push({ key: recordKey(kind, (r as AnyRecord).id), bytes: encode(r) })
  }
  return out
}

/** Stored entries back into a document to load. */
export function importedOfEntries(entries: readonly StoredEntry[]): Imported {
  let m: DocumentMeta | null = null
  const pages: Page[] = []
  const nodes: Node[] = []
  const records: DocumentRecords = {}
  for (const e of entries) {
    if (e.key === META_KEY) {
      m = decode<DocumentMeta>(e.bytes)
      continue
    }
    const [kind] = splitKey(e.key)
    const r = decode<AnyRecord>(e.bytes)
    if (kind === 'page') pages.push(r as Page)
    else if (kind === 'node') nodes.push(r as Node)
    else ((records as Record<string, AnyRecord[]>)[kind] ??= []).push(r)
  }
  pages.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return { meta: m ?? ({ components: {} } as DocumentMeta), pages, nodes, records }
}
