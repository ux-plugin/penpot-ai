/**
 * A commit's state as a hash tree: every record, by key (`kind/id`), mapped
 * to the hash of its bytes.
 *
 * The tree splits 16 ways per level on the hex digits of a hash of the key. A
 * subtree holding at most `MAX_LEAF` entries is one leaf; a larger one is a
 * branch over its non-empty parts. That rule depends only on the entries, so
 * the same state always has the same root, however it was reached: an edit
 * rewrites the nodes on its path and shares the rest with the previous commit,
 * and two states compare by skipping equal hashes.
 *
 * Nodes are content-addressed: a node's name is the hash of its bytes. Reads
 * go through a `NodeStore`; new nodes come back in `written` for the caller to
 * store.
 */
import { decode, encode } from './codec'
import { sha256, sha256Text } from './hash'

export type Hash = string

export interface Entry {
  key: string
  value: Hash
}

export interface Edit {
  key: string
  /** `null` removes the key. */
  value: Hash | null
}

export interface EntryChange {
  key: string
  before: Hash | null
  after: Hash | null
}

export interface NodeStore {
  get(hash: Hash): Uint8Array | undefined
}

export interface TreeWrite {
  root: Hash
  /** Nodes created by this operation, by hash. */
  written: Map<Hash, Uint8Array>
}

export const MAX_LEAF = 32
const PATH_LEN = 16

type Triple = [path: string, key: string, value: Hash]

interface LeafNode {
  e: Triple[]
}

interface BranchNode {
  n: number
  c: Record<string, Hash>
}

type TreeNode = LeafNode | BranchNode

interface PathEdit {
  path: string
  t: Triple | null
}

const isLeaf = (n: TreeNode): n is LeafNode => 'e' in n

async function pathOf(key: string): Promise<string> {
  return (await sha256Text(key)).slice(0, PATH_LEN)
}

function byPath(a: Triple, b: Triple): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
}

class Session {
  readonly written = new Map<Hash, Uint8Array>()

  constructor(private readonly store: NodeStore) {}

  read(hash: Hash): TreeNode {
    const bytes = this.written.get(hash) ?? this.store.get(hash)
    if (!bytes) throw new Error(`missing tree node ${hash}`)
    return decode<TreeNode>(bytes)
  }

  async write(node: TreeNode): Promise<Hash> {
    const bytes = encode(node)
    const hash = await sha256(bytes)
    this.written.set(hash, bytes)
    return hash
  }

  countOf(hash: Hash): number {
    const n = this.read(hash)
    return isLeaf(n) ? n.e.length : n.n
  }

  triplesOf(hash: Hash, out: Triple[] = []): Triple[] {
    const n = this.read(hash)
    if (isLeaf(n)) out.push(...n.e)
    else for (const child of Object.values(n.c)) this.triplesOf(child, out)
    return out
  }

  async build(triples: Triple[], depth: number): Promise<{ hash: Hash; count: number }> {
    if (triples.length <= MAX_LEAF || depth >= PATH_LEN) {
      return { hash: await this.write({ e: [...triples].sort(byPath) }), count: triples.length }
    }
    const groups = new Map<string, Triple[]>()
    for (const t of triples) {
      const g = groups.get(t[0][depth])
      if (g) g.push(t)
      else groups.set(t[0][depth], [t])
    }
    const c: Record<string, Hash> = {}
    const built = await Promise.all([...groups].map(async ([nib, g]) => [nib, await this.build(g, depth + 1)] as const))
    for (const [nib, r] of built) c[nib] = r.hash
    return { hash: await this.write({ n: triples.length, c }), count: triples.length }
  }

  async update(hash: Hash, edits: Map<string, PathEdit>, depth: number): Promise<{ hash: Hash; count: number }> {
    const node = this.read(hash)
    if (isLeaf(node)) {
      const byKey = new Map(node.e.map((t) => [t[1], t]))
      for (const [key, { t }] of edits) {
        if (t) byKey.set(key, t)
        else byKey.delete(key)
      }
      return this.build([...byKey.values()], depth)
    }
    const groups = new Map<string, Map<string, PathEdit>>()
    for (const [key, edit] of edits) {
      const nib = edit.path[depth]
      let g = groups.get(nib)
      if (!g) groups.set(nib, (g = new Map()))
      g.set(key, edit)
    }
    const c = { ...node.c }
    for (const [nib, g] of groups) {
      const child = c[nib]
      const r = child
        ? await this.update(child, g, depth + 1)
        : await this.build(
            [...g.values()].flatMap(({ t }) => (t ? [t] : [])),
            depth + 1,
          )
      if (r.count === 0) delete c[nib]
      else c[nib] = r.hash
    }
    let total = 0
    for (const child of Object.values(c)) total += this.countOf(child)
    if (total <= MAX_LEAF) {
      const triples: Triple[] = []
      for (const child of Object.values(c)) this.triplesOf(child, triples)
      return this.build(triples, depth)
    }
    return { hash: await this.write({ n: total, c }), count: total }
  }
}

/** The tree holding exactly `entries`. */
export async function buildTree(store: NodeStore, entries: readonly Entry[]): Promise<TreeWrite> {
  const s = new Session(store)
  const paths = await Promise.all(entries.map((e) => pathOf(e.key)))
  const { hash } = await s.build(
    entries.map((e, i) => [paths[i], e.key, e.value]),
    0,
  )
  return { root: hash, written: s.written }
}

/** `root` with `edits` applied. */
export async function updateTree(store: NodeStore, root: Hash, edits: readonly Edit[]): Promise<TreeWrite> {
  if (edits.length === 0) return { root, written: new Map() }
  const paths = await Promise.all(edits.map((e) => pathOf(e.key)))
  const s = new Session(store)
  const byKey = new Map<string, PathEdit>()
  edits.forEach((e, i) => byKey.set(e.key, { path: paths[i], t: e.value === null ? null : [paths[i], e.key, e.value] }))
  const { hash } = await s.update(root, byKey, 0)
  return { root: hash, written: s.written }
}

/** Every entry of the tree at `root`. */
export function entriesOf(store: NodeStore, root: Hash): Entry[] {
  return new Session(store).triplesOf(root).map(([, key, value]) => ({ key, value }))
}

/** The value `key` holds in the tree at `root`, or null. */
export async function valueAt(store: NodeStore, root: Hash, key: string): Promise<Hash | null> {
  const path = await pathOf(key)
  const s = new Session(store)
  let node = s.read(root)
  for (let depth = 0; !isLeaf(node); depth++) {
    const child = node.c[path[depth]]
    if (!child) return null
    node = s.read(child)
  }
  return node.e.find((t) => t[1] === key)?.[2] ?? null
}

/** The keys whose values differ between two trees. Equal subtrees are skipped. */
export function diffTrees(store: NodeStore, a: Hash, b: Hash): EntryChange[] {
  const s = new Session(store)
  const out: EntryChange[] = []
  const walk = (x: Hash | undefined, y: Hash | undefined): void => {
    if (x === y) return
    const nx = x ? s.read(x) : undefined
    const ny = y ? s.read(y) : undefined
    if (nx && ny && !isLeaf(nx) && !isLeaf(ny)) {
      for (const nib of new Set([...Object.keys(nx.c), ...Object.keys(ny.c)])) walk(nx.c[nib], ny.c[nib])
      return
    }
    const before = new Map((x ? s.triplesOf(x) : []).map((t) => [t[1], t[2]]))
    const after = new Map((y ? s.triplesOf(y) : []).map((t) => [t[1], t[2]]))
    for (const [key, v] of before) {
      const w = after.get(key) ?? null
      if (w !== v) out.push({ key, before: v, after: w })
    }
    for (const [key, w] of after) if (!before.has(key)) out.push({ key, before: null, after: w })
  }
  walk(a, b)
  return out
}
