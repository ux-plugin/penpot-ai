# State cut — plan

Status: steps a, b and c landed 2026-09-23 (`src/lib/doc/`). Builds
`state-model.md` and `history-model.md`. Steps d–f open.

## Rules

- No versions, no upgrade paths, no adapters. A shape dies with its readers.
- Every step deletes what it replaces in the same commit.
- Every step ends green: `tsc`, tests, dev server.
- Core never imports a feature. Features register schemas.

## 1. Record kinds

One flat record per row. Ownership is a `ref(kind, 'cascade')`; every other
reference is `'keep'` (resolves undefined, shows as missing).

| kind | record | replaces |
|---|---|---|
| page | `{ id, name, background, order }` | `IndexedPage` minus objects |
| node | `{ id, page, parent, order, type, …bundles }` | `IndexedShape`, `shapes: string[]` |
| cell | `{ id, name, owner, type, initial, formula?, store? }` | `Cell` in `PageInteractions` |
| binding | `{ id, node, prop: PropId, expr, item? }` | `NodeRefs.props[prop]` |
| rule | `{ id, node?, on, if?, do }` | `Interaction`, `AppRule` |
| timeline | `{ id, node, tracks, rest }` | `ShapeMotion` (motion-store signal) |
| store | `{ id, name }` | `DocumentMeta.stores` |

`meta` (tokens, components, document fields) stays one `Signal<DocumentMeta>`
this cut. They become kinds later.

## 2. Schemas

```ts
// doc/schema/ref.ts
export const refMeta = z.registry<{ kind: Kind; onDelete: 'cascade' | 'keep' }>()
export const ref = (kind: Kind, onDelete: 'cascade' | 'keep' = 'keep') =>
  refMeta.add(z.string(), { kind, onDelete })
export const expr = () => exprMeta.add(z.custom<Expr>(), { refs: cellsIn })   // refs inside a tree

// doc/schema/node.ts — composed from the F1 bundles
export const Node = z.object({
  id: z.string(),
  page: ref('page', 'cascade'),
  parent: ref('node', 'cascade').nullable(),
  order: z.string(),                     // fractional index
  type: z.enum(SHAPE_TYPES),
  ...bundleFields,
})

// doc/schema/cell.ts
export const Cell = z.object({
  id: z.string(), name: z.string(),
  owner: ref('node', 'cascade').or(ref('page', 'cascade')),
  type: ValueType, initial: z.unknown(),
  formula: expr().optional(), store: ref('store').optional(),
})
```

Rule targets, binding expressions, timelines: same two helpers. Nothing else
declares a reference.

## 3. Registry `doc/registry.ts`

Built once by walking the schemas.

| fn | does |
|---|---|
| `refFields(kind)` | `[field, kind, onDelete]` from `refMeta` / `exprMeta` |
| `refsOf(record)` | every `(kind, id)` a record points at |
| `readersOf(kind, id)` | reverse index, derived (§6) |
| `remap(record, map)` | copy/paste, instances |
| `validate(doc)` | dangling refs, wrong kinds |
| `onDelete(kind, id)` | the `del` changes a delete expands to (cascade only) |

## 4. Store `doc/store.ts`

```ts
type Table<R> = Map<Id, Signal<R>>
export const doc = {
  page: Table<Page>, node: Table<Node>, cell: Table<Cell>, binding: Table<Binding>,
  rule: Table<Rule>, timeline: Table<Timeline>, store: Table<Store>,
  meta: Signal<DocumentMeta>,
}
get(kind, id)               // record or undefined
field(kind, id, key)        // memoised computed per field
```

Records are frozen. Only the reducer writes a signal.

## 5. Changes and reducer `doc/changes.ts`, `doc/commit.ts`

```ts
type Change =
  | { op: 'add'; kind; record }
  | { op: 'del'; kind; id }
  | { op: 'mod'; kind; id; set: Partial<Record> }

apply(change): Change            // returns the inverse
```

`commitChanges({ changes, label })`:

1. expand: bulk, `onDelete` cascade
2. effects: component sync, aspects (keep, same API)
3. apply each, collect inverses
4. push undo frame (§7)
5. record commit (§8, async)
6. emit `changes-applied` `{ touched: Map<kind, Set<id>>, before, after }`

Subscribers stay: renderer-sync, selection-sync, worker-sync, scene3d-sync.
Their payload changes from pages to touched records.

Deleted: `process-changes.ts`, `doc-proxy.ts`, penpot `add-obj / del-obj /
mod-obj / mov-objects / reorder-children`, `set-page-interactions`,
`flatten.ts` / unflatten, `IndexedPage` / `IndexedShape`, valtio in the
document path. `changes-builder.ts` emits the three ops. `mov-objects` and
`reorder-children` become `mod node { parent, order }`.

The penpot import stays a one-way converter at the door: `PenpotDocument →
records`.

## 6. Derived `doc/derived/`

```ts
derived<T>({ from: Kind[], build(doc): T, update(t, touched): void })
```

| name | over | replaces |
|---|---|---|
| `childrenOf` | node | `shapes[]`, `ordered-page-nodes.ts` |
| `readersOf` | all ref fields | `referencedNodeIds`, `reconcile`, `dropNodes` |
| `cellsOf`, `bindingsOf`, `rulesOf`, `timelineOf` | per node | `rulesByNode`, `cellByUid`, `buildScope` lookups |
| `visibleRows` | node + expanded | layers panel walk |
| WASM shapes, three.js scene, quadtree | node | same subscribers, fed by `touched` |

All `Readonly`. Nothing outside `derived/` builds an index.

## 7. Undo `doc/undo.ts`

```ts
Frame = { label, inverse: Change[], redo: Change[] }
undo() redo()                         // through commitChanges, no frame pushed
fork() merge(label) discard()         // focus-mode scratch branch
```

Deleted: `history/journal/*`, `history/versions/*`, `focus-pending.ts`,
`history-sync.ts`, `DevJournalPanel.tsx`, their tests.

## 8. Commits and SQLite `doc/commits/`

Tables: `objects(hash, bytes)`, `commits(id, parent, time, label, root)`,
`commit_nodes(commit, kind, id)`, `heads(name, commit)`.

- after each frame: serialize touched records, hash, update trie, write one
  commit row, off the sync path, batched per animation frame
- `checkout(commit)`: diff head vs commit → change set → `commitChanges`
- `historyOf(kind, id)`: `commit_nodes`
- web: `@sqlite.org/sqlite-wasm`, OPFS, in a worker; desktop: SQLite

Deleted: `persistence/kv-indexeddb.ts` document envelope, JSON save of the
whole document. The document list becomes a `docs` table.

## 9. Sync

Out of this cut. The interface it needs exists after §8: a change set with a
revision, applied through `commitChanges`.

## Build order

| step | builds | deletes | reach |
|---|---|---|---|
| a | §2 §3 §4 §5 for page + node; readers move to `get` / `field` / `childrenOf` | doc-proxy, process-changes, penpot Change, flatten, `shapes[]`, valtio from document | ~110 files |
| b | §7 | journal, versions, focus-pending, DevJournalPanel | ~25 |
| c | §6 the rest; subscribers on `touched` | node scans on hot paths (component sync, slot hover, container hit test, layers panel) | ~20 |
| d | cell, binding, rule, timeline, store as kinds | reconcile / referencedNodeIds / dropNodes, interactions-aspect, `PageInteractions`, `upgrade.ts`, V1/V2, `normalize.ts` / `GraphNode`, `nl/interpret.ts`, motion-store hydrate / `setMotionShapes` / `scheduleCommit`; interactions tests rewritten | ~40 |
| e | §8 | kv-indexeddb envelope | ~10 |
| f | §9 | | |

Step a landed with b folded in: the journal codec was written against the
penpot change types, so the undo stack replaced it in the same cut.

What a built, beyond the plan: the root frame is not a record (each page's
nil-UUID root collided in one node table; top-level nodes have no `parentId`,
`childrenOf(pageId)` is the top level, `pageObjects` and the worker supply
the root WASM needs); effects (`registerEffect`) unify component sync,
aspects and 3D crop-resize; the hit-index worker keeps its own page copy fed
by the same three ops (`worker/page-store.ts`); `commitChanges` takes no undo
vectors, `pageId` or `IndexedPage` anywhere.

What c built: `derived()` registry; `readersOf(kind, field, id)`, a reverse
index per reference field built on first use, with `childrenOf` answering
`parentId` and `page`; delete cascade read from the `cascade` declarations
(`ownedBy`), so a page delete takes its nodes; `remap` for copies; `dangling`;
`ofType(page, type)` for hit tests; `rowsOf` for tree views, structure only,
each row subscribed to its own node, collapsible. New references declared:
`shapeRef`, `views`, `activeView`. The interactions deletions moved to d:
they need cells, bindings and rules to be records first.

## Decide before a

1. `order` is a fractional string; `shapes[]` goes. Confirm.
2. Three change ops only. The penpot vocabulary ends at import. Confirm.
3. `meta` stays one signal this cut. Confirm.
4. Behaviour kinds (step d) after undo (b) and derived (c), not before.
