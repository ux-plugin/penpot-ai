# State model

Status: decided 2026-09-22, built 2026-09-23 (`src/lib/doc/`, see
`state-cut-plan.md`): pages, nodes, cells, bindings, rules, timelines and
stores are record kinds. Supersedes the "Document layer — Valtio" section of
`state-architecture.md`. Storage and sync are not built.

## Three kinds of state, one writer

| Kind | Holds | Lives in | Written by |
|---|---|---|---|
| document | nodes, cells, rules, timelines, pages | flat records in signals | `commitChanges` only |
| derived | reverse indexes, children lists, three.js objects, WASM shapes, spatial index, playback clips | `derived({ from, build, update })` | the reducer, never callers |
| ephemeral | playhead, selection, hover, open panels | signals, zustand | anyone |

Nothing else holds document data. Valtio leaves the document store.

## Records

A record is one row of one kind: node, cell, rule, timeline, page. A plain
frozen object, keyed by id, held in one `Signal<Record>`. A write replaces the
object. Nothing nests except identity-less values (a fill, a point, a curve).

```ts
const nodes = new Map<NodeId, Signal<Node>>()
const cells = new Map<CellId, Signal<Cell>>()
```

Views subscribe through `computed` on fields, so a fill edit never reaches a
subscriber of the name.

## Tree

A node stores `parent` and a fractional `order`. `childrenOf: Map<NodeId,
Signal<NodeId[]>>` is derived and updated incrementally. The layers panel is
`visibleRows`, a computed over expanded nodes, windowed, each row a set of
field computeds. A collapsed subtree costs nothing.

## References

Declared once in the zod schema, `ref(kind, onDelete)`, and consumed
generically by one registry: `refsOf`, `resolve`, `readersOf`, `remap`,
`validate`, `onDelete`. Three invariants:

- deleting never destroys information held elsewhere: delete removes one
  record; references to it resolve to undefined and show as missing; restore
  brings them back intact;
- every fact is stored once;
- reference semantics are declared once, never hand-rolled per feature.

Reverse indexes are derived caches under `derived/`, typed `Readonly`.
Packages register their schemas; core never imports a feature.

## Storage

Own the model, buy the bytes. SQLite-WASM over OPFS on web, SQLite on desktop,
the same tables on the server: `objects`, `commits`, `commit_nodes`, `heads`.
See `history-model.md` for commits and rewind. Ruled out: TinyBase, RxDB,
Zero, LiveStore, Yjs, Automerge, Loro, Jazz, in-memory SQL.

## Sync

By change sets, never by tree merge. Live: a change set with a revision; the
server orders, writes a commit, broadcasts; a stale revision is rejected and
the client re-applies over what it missed. Offline of any length: three-way
per property against the last synced commit, last write wins where both
changed, structural repair rules, one merge commit. Catch-up needs no log: the
union of `touched` since the client's revision names the records to send.

## Measured, 1M shapes, Node 22

| | build | heap | notes |
|---|---|---|---|
| plain objects | 0.5 s | 441 MB | serialize 1.4 s, load 2.1 s |
| TinyBase | 12.5 s | 847 MB | load 24 s, snapshot 6 s |
| signal per property | 1.5 s | 1657 MB | |
| **signal per record** | **0.5 s** | **459 MB** | 10k writes 12 ms; 1000 computeds recompute 0 ms |
| valtio deep | 60 s | 5409 MB | snapshot 88 s |
| valtio `ref()` | 1.9 s | 427 MB | snapshot 1 s per change |

Field computeds: 10k fill edits reach 0 name subscribers. Scripts in
`scratchpad/tb-bench/`.
