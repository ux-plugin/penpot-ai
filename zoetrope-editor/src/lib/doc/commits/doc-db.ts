/**
 * One document's history in SQLite: content-addressed objects (record bytes
 * and tree nodes), commits, the records each commit touched, and the head.
 *
 *   objects(hash, bytes)                      a record's bytes, or a tree node
 *   commits(id, parent, time, label, root)    root = the state's hash tree
 *   commit_records(kind, id, commit_id)       per-record history
 *   heads(name, commit_id)                    `main` is the document now
 *
 * A commit is named by the hash of its parent, root, time and label, so two
 * copies of a document agree on names without talking.
 */
import { canonicalJson } from './codec'
import { sha256, sha256Text } from './hash'
import { buildTree, diffTrees, entriesOf, updateTree, type Hash, type NodeStore } from './tree'
import type { Sql } from './sql'

const SCHEMA = `
pragma temp_store = memory;
create table if not exists objects(hash text primary key, bytes blob not null) without rowid;
create table if not exists commits(id text primary key, parent text, time integer not null, label text, root text not null);
create table if not exists commit_records(kind text not null, id text not null, commit_id text not null, primary key (kind, id, commit_id)) without rowid;
create table if not exists heads(name text primary key, commit_id text not null) without rowid;
`

const MAIN = 'main'

export interface CommitInfo {
  id: string
  parent: string | null
  time: number
  label: string | null
  root: Hash
}

/** A record as stored: its key (`kind/id`) and canonical bytes. */
export interface StoredEntry {
  key: string
  bytes: Uint8Array
}

/** A write: new bytes for a key, or `null` to remove it. */
export interface Put {
  key: string
  bytes: Uint8Array | null
}

export interface CommitOptions {
  /** `puts` is the whole state: keys it leaves out are removed. */
  full?: boolean
  label?: string
  time: number
}

/** `kind/id` → [kind, id]. Ids may contain slashes; kinds do not. */
export function splitKey(key: string): [string, string] {
  const i = key.indexOf('/')
  return [key.slice(0, i), key.slice(i + 1)]
}

export class DocDb implements NodeStore {
  constructor(private readonly sql: Sql) {
    sql.run(SCHEMA)
  }

  get(hash: Hash): Uint8Array | undefined {
    return this.sql.all<{ bytes: Uint8Array }>('select bytes from objects where hash = ?', [hash])[0]?.bytes
  }

  commitInfo(id: string): CommitInfo | null {
    return this.sql.all<CommitInfo>('select id, parent, time, label, root from commits where id = ?', [id])[0] ?? null
  }

  head(): CommitInfo | null {
    const row = this.sql.all<{ commit_id: string }>('select commit_id from heads where name = ?', [MAIN])[0]
    return row ? this.commitInfo(row.commit_id) : null
  }

  /**
   * Record `puts` as a commit on the head. Returns it, or null when the state
   * did not change. Hashing happens first; the writes are one transaction.
   */
  async commit(puts: readonly Put[], opts: CommitOptions): Promise<CommitInfo | null> {
    const head = this.head()
    const values = await Promise.all(puts.map((p) => (p.bytes ? sha256(p.bytes) : Promise.resolve(null))))
    const written = new Map<Hash, Uint8Array>()
    puts.forEach((p, i) => {
      if (p.bytes) written.set(values[i]!, p.bytes)
    })
    const view: NodeStore = { get: (h) => written.get(h) ?? this.get(h) }
    let base = head?.root
    if (!base) {
      const empty = await buildTree(view, [])
      for (const [h, b] of empty.written) written.set(h, b)
      base = empty.root
    }
    const tree = opts.full
      ? await buildTree(
          view,
          puts.flatMap((p, i) => (values[i] ? [{ key: p.key, value: values[i]! }] : [])),
        )
      : await updateTree(
          view,
          base,
          puts.map((p, i) => ({ key: p.key, value: values[i] })),
        )
    for (const [h, b] of tree.written) written.set(h, b)
    if (head && tree.root === head.root) return null
    const touched = diffTrees(view, base, tree.root).map((c) => c.key)
    const info: CommitInfo = {
      id: '',
      parent: head?.id ?? null,
      time: opts.time,
      label: opts.label ?? null,
      root: tree.root,
    }
    info.id = await sha256Text(canonicalJson({ parent: info.parent, root: info.root, time: info.time, label: info.label }))
    this.sql.transaction(() => {
      for (const [h, b] of written) this.sql.run('insert or ignore into objects(hash, bytes) values (?, ?)', [h, b])
      this.sql.run('insert or ignore into commits(id, parent, time, label, root) values (?, ?, ?, ?, ?)', [
        info.id,
        info.parent,
        info.time,
        info.label,
        info.root,
      ])
      for (const key of touched) {
        const [kind, id] = splitKey(key)
        this.sql.run('insert or ignore into commit_records(kind, id, commit_id) values (?, ?, ?)', [kind, id, info.id])
      }
      this.sql.run('insert into heads(name, commit_id) values (?, ?) on conflict(name) do update set commit_id = excluded.commit_id', [
        MAIN,
        info.id,
      ])
    })
    return info
  }

  /** Every record at `commit` (the head when omitted), or null for none. */
  entriesAt(commit?: string): StoredEntry[] | null {
    const info = commit ? this.commitInfo(commit) : this.head()
    if (!info) return null
    return entriesOf(this, info.root).map((e) => {
      const bytes = this.get(e.value)
      if (!bytes) throw new Error(`missing object ${e.value} for ${e.key}`)
      return { key: e.key, bytes }
    })
  }

  /** The head and its ancestors, newest first. */
  log(limit = 100): CommitInfo[] {
    const out: CommitInfo[] = []
    let c = this.head()
    while (c && out.length < limit) {
      out.push(c)
      c = c.parent ? this.commitInfo(c.parent) : null
    }
    return out
  }

  /** The commits that changed record `key`, newest first. */
  historyOf(key: string): CommitInfo[] {
    const [kind, id] = splitKey(key)
    return this.sql.all<CommitInfo>(
      `select c.id, c.parent, c.time, c.label, c.root from commit_records r join commits c on c.id = r.commit_id
       where r.kind = ? and r.id = ? order by c.time desc, c.id`,
      [kind, id],
    )
  }

  /** Every row, to copy the document into another database. */
  dump(): DocDump {
    return {
      objects: this.sql.all<DocDump['objects'][number]>('select hash, bytes from objects'),
      commits: this.sql.all<CommitInfo>('select id, parent, time, label, root from commits'),
      records: this.sql.all<DocDump['records'][number]>('select kind, id, commit_id from commit_records'),
      heads: this.sql.all<DocDump['heads'][number]>('select name, commit_id from heads'),
    }
  }

  /** Write a `dump` into this database. */
  restore(d: DocDump): void {
    this.sql.transaction(() => {
      for (const r of d.objects) this.sql.run('insert or ignore into objects(hash, bytes) values (?, ?)', [r.hash, r.bytes])
      for (const c of d.commits) {
        this.sql.run('insert or ignore into commits(id, parent, time, label, root) values (?, ?, ?, ?, ?)', [c.id, c.parent, c.time, c.label, c.root])
      }
      for (const r of d.records) this.sql.run('insert or ignore into commit_records(kind, id, commit_id) values (?, ?, ?)', [r.kind, r.id, r.commit_id])
      for (const h of d.heads) this.sql.run('insert or replace into heads(name, commit_id) values (?, ?)', [h.name, h.commit_id])
    })
  }
}

export interface DocDump {
  objects: { hash: string; bytes: Uint8Array }[]
  commits: CommitInfo[]
  records: { kind: string; id: string; commit_id: string }[]
  heads: { name: string; commit_id: string }[]
}
