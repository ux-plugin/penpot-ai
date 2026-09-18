# History redesign plan — scoped selective undo

Status: design, not started. Written 2026-07-25.
Supersedes the stack-based model in `src/lib/history/`. See also
`docs/state-architecture.md`, `docs/tokens-styles-port-plan.md`.

## Why

The current history is two arrays plus a special-case parallel buffer for focus
modes. It works, but it cannot express three things we now need:

1. **Shape-scoped history** — "rewind this shape", independent of what else
   happened after.
2. **Multiplayer** — two people editing one document, each with their own undo
   that never rewinds the other's work.
3. **Per-mode rules** — path edit, animation, shader and 3D each want different
   undo semantics, and adding each one currently means another special case
   alongside `focusBuffer`.

## Naming and prior art

There is no single named industry standard that covers all three. The
established terms, one per axis:

| Requirement | Term | Source |
| --- | --- | --- |
| Undo a specific shape's change, not the last one | **selective undo** (non-linear, regional) | Berlage, TOCHI 1994 |
| Each user undoes only their own edits | **local undo** (vs. global undo) | Sun, *Undo as Concurrent Inverse in Group Editors*, TOCHI 2002 (ANYUNDO) |
| Different rules per mode | **undo scope** / per-mode **undo types** | Yjs `UndoManager`; Blender `BKE_undosys` |

Umbrella phrase for what this document describes: **scoped selective undo with
rebased inverses.**

Closest real implementations worth reading:

- **Yjs `UndoManager`** — scoping (`scope`, `trackedOrigins`) plus multiplayer.
- **Blender `BKE_undosys`** — per-mode `UndoType` registration; the closest
  precedent for mode-dependent rules.
- **`prosemirror-history` + `prosemirror-collab`** — the rebasing math, small
  enough to read in an afternoon. This is the one to read first.
- **Figma** — per-user undo computed against current state and applied forward.

## Core model

Three pieces, kept strictly separate. Fusing them is what makes undo systems
unmaintainable.

### 1. One log

Append-only, per-document, shared by all actors. **Not** one log per shape, and
**not** one stack per mode. Cross-shape operations are the majority of the
interesting ones — group, ungroup, reparent, reorder, boolean ops, autolayout
reflow, component propagation, token propagation across 10k shapes — and a
per-shape log has nowhere to put them atomically.

Git is the mental model: one ordered commit log, and per-file history is a
*derived query*.

```ts
type Txn = {
  seq: number          // server-assigned total order
  actor: ActorId
  parentSeq: number    // what the client saw when it committed
  scope: ScopeTag      // 'canvas' | 'path-edit:<id>' | 'timeline:<clip>' | ...
  groupId?: GroupId
  undoes?: number      // back-pointer; null for forward edits
  ops: Op[]            // each op carries entity id + interned ancestor pathId
}
```

### 2. A lens per mode

A mode does not own a history. It owns a *query*.

```ts
interface HistoryLens {
  id: string
  filter(txn: Txn, ctx: Ctx): boolean
  pick(log: Log, cursor: Cursor, ctx: Ctx): TxnId | null
  conflict: ConflictPolicy
  onEnter?(): Barrier
  onExit?(): 'collapse' | 'keep' | 'discard'
  budget: { maxEntries: number; maxBytes: number }
}
```

- Canvas: `filter = actor === me`, `pick = most recent`.
- Path edit: `filter = actor === me && scope === 'path-edit:' + activeId`.
- Shape tab: `filter = touches.has(shapeId)`, any actor.
- Animation: filter by clip, pick by keyframe time rather than recency.

Same log, four behaviours, no new machinery per mode.

### 3. Undo applies a new inverse transaction

Undo is **never** a stack pop.

```
undo(lens, ctx):
  target = lens.pick(log, cursor, ctx)
  inv    = invert(target)                     // computed structurally
  inv'   = rebase(inv, log.since(target))     // map through everything after
  if conflicted(inv') -> lens.conflict.resolve(...)
  commit(inv', { undoes: target })            // appended like any other edit
```

Redo is the inverse of the undo txn, found via the `undoes` back-pointer. No
redo stack exists.

This single property buys all three requirements: multiplayer (an undo is an
ordinary op other clients merge normally), selective undo (any entry can be
inverted, not just the last), and shape-scoped undo (an index lookup feeding
`pick`).

**`rebase()` is shared by undo and by multiplayer sync.** Undo rebases an
inverse over subsequent entries; sync rebases pending local entries over the
server's gap. One implementation. Build it first.

## Two verbs, not one

| | **Undo** (Cmd+Z) | **Restore** (history tab) |
| --- | --- | --- |
| Action | Invert one operation, rebased | Reconstruct state at seq T, emit one diff |
| Respects concurrent edits | Yes | No — asserts a state, like `git revert` |
| Lifetime | Session | Forever |
| Cost | O(1) | O(replay from nearest snapshot) |
| Fails when | Target's effect is gone | Referenced parent/token no longer exists |

The history tab uses **restore**. Someone scrubbing a visual timeline means
"make it look like that" — a state assertion, not an operation inversion.
Implementing the tab as N inverses drags the dependency problem into a UI where
the user cannot reason about it.

Restore must **clamp to currently-valid references**: if an old fill pointed at
a deleted token, or the old parent frame is gone, restore the resolved value /
reparent to the nearest surviving ancestor and flag the row.

## Tree relationships

Two questions with opposite answers.

**Is the log shaped like the tree?** No. Reparenting is routine; if log
structure mirrors hierarchy, moving a shape orphans its history. Key everything
by stable UUID.

**Does each op record its ancestry?** Yes — and this is load-bearing, because
**subtree membership is temporal.** A shape that was inside frame F in May and
moved out in June must still appear in F's May history. Reconstructing the tree
at each point in time to answer that is prohibitive.

So store the ancestor path *at commit time*, interned:

```
op.entity = shapeId
op.pathId = 0x4A1   ->   paths[0x4A1] = [root, page2, frameF, groupG]
```

Distinct paths in a document are few relative to op count, and ops within a txn
usually share one — so per-op cost is a 4-byte `pathId`, not ~32 bytes of ids.

**A reparent op is indexed under both old and new ancestry.** "Button moved out
of F" belongs in F's history even though the shape's new path points elsewhere.

The bigger win from keeping ancestry is not query speed but **snapshot
granularity**: snapshot per subtree (frame / page / component) rather than
per document, so reconstructing one shape replays from a nearby aggregate
snapshot. Without this the tab's per-row thumbnails are unaffordable.

## Storage

### Decisions

Locked unless a phase turns up a reason to revisit. Numbered so code comments and
review threads can cite them.

| # | Decision | Choice | Rejected |
| --- | --- | --- | --- |
| D1 | Local store | SQLite, one document per file | raw append-only file, IndexedDB, LMDB |
| D2 | Server store | Postgres, same logical schema | document store; Kafka as source of truth |
| D3 | Web store | SQLite WASM over OPFS | IndexedDB — would be a second implementation |
| D4 | Relational or document | **SQL** | NoSQL: an append-only log has the most stable schema in the system, which is the one thing NoSQL is for |
| D5 | Row granularity | one row per **transaction** | one row for the whole log; one row per op (20–50x overhead) |
| D6 | Op payload | packed binary blob in the row | JSON; row-per-op |
| D7 | Large payloads | spill above ~4 KB to content-addressed objects | inline blobs — forces SQLite overflow-page chains |
| D8 | Multi-valued indexes | inverted tables, `WITHOUT ROWID` | JSON1 expression indexes; FTS |
| D9 | Scalar indexes | ordinary `CREATE INDEX` on `txn` columns | inverted tables for everything |
| D10 | Snapshots | per **aggregate** (frame / page / component), stored as files | whole-document snapshots; snapshots in-row |
| D11 | Ids in index rows | interned integers + intern tables | 16-byte UUIDs inline (~2.5x index size) |
| D12 | Concurrency | WAL; one writer connection, readers separate | default rollback journal; shared connection |
| D13 | Sequence authority | server when connected; the client is its own sequencer offline and solo | Lamport-only with no total order |
| D14 | Ops encoding | versioned **per transaction** (`txn.enc`) | one global encoding version |
| D15 | Document unit | a directory: `journal.sqlite` + `objects/` + `snapshots/` | single file with everything inline; many documents per file |

**Local: SQLite.** It answers "file or database?" with both — one portable file,
plus ACID appends, real indexes and range scans. **Server: Postgres**, same
logical schema. **Web: SQLite WASM over OPFS**, not IndexedDB, so there is one
implementation.

**SQL, not NoSQL.** The reason inverts the usual instinct: an append-only log has
the most *stable* schema in the system, since written entries can never be
reshaped — schema flexibility is the one thing NoSQL sells and the one thing we
do not need. Meanwhile we do need a monotonic total order (the whole multiplayer
design), multi-key atomic append (token propagation must land as one row), and
set-intersection over inverted indexes.

### Schema

One row per **transaction** — not one row for the log, not one row per op.

```sql
PRAGMA journal_mode = WAL;   -- the tab reads while the user keeps editing
PRAGMA user_version = 1;     -- SQL schema version (see migrations below)

-- interned ids (D11). Referenced by every index row, so keep them 4 bytes wide.
CREATE TABLE actor  (actor_id INTEGER PRIMARY KEY, uuid BLOB UNIQUE NOT NULL);
CREATE TABLE entity (entity   INTEGER PRIMARY KEY, uuid BLOB UNIQUE NOT NULL);
CREATE TABLE scope  (scope_id INTEGER PRIMARY KEY, tag  TEXT UNIQUE NOT NULL);

-- the log. Immutable: only compaction behind a covering snapshot removes rows.
CREATE TABLE txn (
  seq        INTEGER PRIMARY KEY,   -- total order (see "Sequence assignment")
  actor_id   INTEGER NOT NULL REFERENCES actor(actor_id),
  parent_seq INTEGER NOT NULL,      -- what the committer saw; enables rebase
  scope_id   INTEGER NOT NULL REFERENCES scope(scope_id),
  group_id   INTEGER,
  undoes     INTEGER,               -- back-pointer; NULL for forward edits
  flags      INTEGER NOT NULL,      -- isCheckpoint | isCollapsed | isImport | ...
  enc        INTEGER NOT NULL,      -- ops encoding version (D14)
  created_at INTEGER NOT NULL,
  ops        BLOB    NOT NULL       -- packed binary op array
);

-- derived, rebuildable, droppable during compaction
CREATE TABLE txn_entity  (entity INTEGER, seq INTEGER,
  PRIMARY KEY(entity, seq)) WITHOUT ROWID;
CREATE TABLE txn_subtree (ancestor INTEGER, seq INTEGER,
  PRIMARY KEY(ancestor, seq)) WITHOUT ROWID;
CREATE TABLE path     (path_id INTEGER PRIMARY KEY, ancestors BLOB);
CREATE TABLE snapshot (aggregate INTEGER, seq INTEGER, hash BLOB,
  PRIMARY KEY(aggregate, seq));
CREATE TABLE blob_ref (hash BLOB PRIMARY KEY, size INTEGER, refs INTEGER);

-- mutable session state. Client only — the server has none of this.
CREATE TABLE cursor  (actor_id INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE pending (local_id   INTEGER PRIMARY KEY,
                      parent_seq INTEGER NOT NULL,
                      scope_id   INTEGER NOT NULL,
                      enc        INTEGER NOT NULL,
                      ops        BLOB    NOT NULL);

CREATE INDEX txn_lens   ON txn(scope_id, actor_id, seq DESC);
CREATE INDEX txn_undoes ON txn(undoes);
```

Server-side Postgres is the same schema plus a `doc_id` column on every table,
partitioned by it. Locally there is no `doc_id` — the file *is* the document
(D15).

Three deliberate choices:

- **`ops` is one packed blob**, not a row per op. Whole transactions are almost
  always read together; row-per-op multiplies overhead 20–50x.
- **Payloads over ~4 KB spill** to `objects/<hash>` (path geometry, shader
  source, meshes, image fills). SQLite's default `page_size` is 4096 — keeping
  rows under a page avoids overflow chains, so a txn read is one page. Free
  dedup as a bonus: the same 200-node path stored 40 times costs one copy.
- **Snapshots are files**, referenced from the DB, per aggregate.

Typical txn row is ~200 bytes, so ~20 MB for a 100k-txn document.

### Two kinds of index

- **Scalar, one value per txn** (`actor_id`, `scope_id`, `group_id`, `undoes`)
  -> ordinary `CREATE INDEX`, because they are real columns.
- **Multi-valued** (entities, ancestors) -> inverted index *tables*, because a
  txn touches many shapes and the ids live inside the packed blob where SQL
  cannot reach them. Written in the same SQLite transaction as the row.

| Index | Powers |
| --- | --- |
| `txn(scope_id, actor_id, seq)` | undo lens per mode |
| `txn(undoes)` | redo |
| `txn_entity` | shape history tab; shape-scoped undo |
| `txn_subtree` | frame/component history; subtree restore; per-scope eviction |
| `snapshot(aggregate, seq)` | nearest snapshot for replay (thumbnails) |

Every query is a set operation:

```sql
-- shape history tab
SELECT t.seq, t.actor_id, t.created_at, t.ops
FROM txn_entity e JOIN txn t ON t.seq = e.seq
WHERE e.entity = ?1 ORDER BY e.seq DESC LIMIT 50;

-- undo in path-edit
SELECT seq FROM txn
WHERE scope_id = ?1 AND actor_id = ?2 AND seq <= ?3 AND undoes IS NULL
ORDER BY seq DESC LIMIT 1;
```

Index tables are **derived, never authoritative** — everything in them is
recoverable by unpacking `ops`. Compaction can drop index rows for cold
segments; the tab just gets slower for ancient history rather than losing it.

Set `PRAGMA journal_mode=WAL` — the tab reads while the user keeps editing.

### Sequence assignment (D13)

- **Connected:** the server assigns `seq`. Unacked local work lives in `pending`
  with a local monotonic `local_id`; `txn` only ever holds server-ordered
  entries. On ack, the row moves from `pending` to `txn` with its real `seq`.
- **Solo or offline:** the client is its own sequencer — `seq = max(seq) + 1` and
  `pending` stays empty.
- `seq` is never reused. `parent_seq` records what the committer saw, which is
  the input `rebase()` needs.

Phases 1–3 run entirely in solo mode, so nothing about server sequencing has to
exist before Phase 4.

### Encoding version and migrations (D14)

Two independent versions, for two different reasons:

- **`PRAGMA user_version`** — the SQL schema. Migrated normally, forward-only.
- **`txn.enc`** — the packed ops encoding, stored **per row**. Old rows can never
  be rewritten: the log is immutable and may be covered by content-addressed
  snapshots. So the decoder must retain *every* `enc` version it has ever
  written.

Adding an `enc` version is therefore a permanent maintenance commitment. Prefer
additive op fields over changed layouts, and keep the decoder's version table
small on purpose.

### File layout and portability (D15)

A document is a directory, not a single file:

```
mydoc.zoe/
  journal.sqlite
  objects/<hash>      spilled op payloads, content-addressed
  snapshots/<hash>    per-aggregate snapshots
```

Same layout inside an OPFS directory on web; `objects/` and `snapshots/` go to
object storage on the server. Single-file export (share, email, attach to a bug)
is a zip of the directory — everything is already content-addressed, so dedup
survives the round trip.

### Object GC

`blob_ref.refs` is decremented when compaction drops the last transaction
referencing a hash. A sweep deletes rows at zero and unlinks the file. Run it
opportunistically on open, never on the commit path. Orphaned objects are safe to
leak — they cost disk, never correctness.

### Connections (D12)

One writer connection in WAL mode. The history tab reads on its own connection so
a slow thumbnail query can never block a commit. Do not share a connection
between writer and reader.

### Storage classes

| Class | What | Where |
| --- | --- | --- |
| Immutable, append-only | `txn`, index tables, snapshots, objects | SQLite + object files |
| Mutable, tiny | `cursor` (per-actor undo position), `pending` (unacked commits) | SQLite, few rows |
| Ephemeral | hot window, materialized document, lens registry | memory only |

Cmd+Z does not touch disk. The **hot window** is a ring of the last few thousand
transactions already decoded, so undo is a pointer walk. SQLite is the durable
tier and the fallback for whatever the window has evicted — in practice only the
tab reaches it.

`pending` **must** persist: it holds commits the server has not acked, so after
a crash mid-offline-session it is the only record of the user's work. It is the
one table where rows are deleted rather than appended.

`cursor` need not persist. The undo position resets to head on reopen (see
"reopening" below), so persisting it is optional polish.

Server-side only the immutable class exists — cursors and pending queues are
per-client.

### Retention

Tiered, like a time-series rollup:

| Age | Kept |
| --- | --- |
| < 30 min | every transaction, full fidelity |
| < 24 h | coalesced per `(entity, field)` in ~30 s windows |
| < 30 d | structural ops (create/delete/reparent/reorder) + checkpoints |
| Forever | snapshots at coarse intervals + named/auto milestones |

Invariant: **entries may only be evicted behind a covering snapshot.**
Granularity degrades with age; reconstructable state never does.

**Per-scope budgets, never a single global cap.** Path edit's 500 drags evict
path edit's own oldest entries; canvas history is untouched. Plus:

- **Collapse on mode exit** (already implemented today) — a focus session
  becomes one outer entry with the sub-log attached as children. The parent
  costs one slot under canvas's budget regardless of session length; children
  live under the mode's budget. The change from today is that the children are
  **retained** rather than discarded.
- **Priority classes, not FIFO.** Evict by `bytes x recency / significance`. A
  6 MB run of 2px nudges goes long before a delete.

### Reopening

- The log persists. Forever, compacted.
- The undo cursor does not — it starts at head.

That is correct, not a limitation: rebasing inverses over three weeks of other
people's edits is unpredictable. Going far back after a restart is a
**restore**, which is well-defined at any distance because it asserts rather
than rebases.

Offline edits accumulate in `pending` and rebase over the server's gap on
reconnect — literally git rebase. Two guardrails: above a threshold on pending
length or gap size, surface a "review changes" step instead of auto-rebasing;
and keep a pre-rebase copy so the rebase is itself undoable.

## Multiplayer

**Server-ordered log with rebase-on-push** — a central sequencer per document.
Not CRDT, not classical OT. Structurally a git server that only accepts
fast-forwards while clients rebase before pushing.

```
client: apply optimistically -> push {parentSeq, ops}
server: head == parentSeq ? assign seq, append, broadcast
                          : reject with head  ->  client rebases pending, retries
```

**Why not full CRDT:** the document has invariants a CRDT will not preserve — no
cycles in the shape tree, z-order semantics, autolayout constraints,
component/instance coupling — and we would end up with two logs (the CRDT's
internal one plus this journal) competing for the same job.

**Why the sequencer is cheap here:** field-level ops keyed by `(entity, field)`
commute. Two people editing different properties, or the same property in
sequence, need no transformation — append in arrival order, last writer wins.
Only three classes need arbitration:

| Class | Rule |
| --- | --- |
| Reparent | Server rejects if it would create a cycle (it holds the true head); otherwise LWW on the parent field |
| Reorder / z-index | **Fractional indexing** (LexoRank-style keys) — concurrent inserts commute, no arbitration |
| Delete vs. modify | Delete wins; the modify is retained (tombstoned) so restore still works |

**Two channels, and the split governs log volume:**

- **Durable** — committed transactions only. A 400-frame drag is *one* commit
  on release.
- **Ephemeral** — live cursors, selection halos, in-progress drag positions.
  Broadcast, never persisted, lossy is fine.

**Conflict policy is per-property, not just per-mode.** "Someone else moved this
since my move" -> refuse or offset. "Someone else renamed it" -> clobber. Lens
sets a default; op type may override.

Server options: Postgres plus a per-document actor or advisory lock to serialize
appends. If Cloudflare is ever on the table, one Durable Object per document is
an unusually good fit — single-threaded execution *is* the sequencer, with
SQLite storage built in.

## Sync layers are actors, not a special case

The Figma plugin is a **sync layer**, not a place that stores history. Nothing
about the plugin runtime's constraints (`clientStorage` is 5 MB; the plugin UI
iframe has a null origin so no IndexedDB/OPFS; the main thread is QuickJS in wasm
with no browser APIs; Figma owns Cmd+Z) touches this design, because no journal
ever lives there.

It collapses to: **an import is an actor writing to the log.** Three consequences,
all of which the existing design already covers:

- **One bulk transaction per import**, never one per shape — a 4,000-shape import
  must not flood the log or the user's undo depth. Same multi-id bulk op needed
  for token propagation.
- **`scope: 'import:figma'` and a synthetic actor**, so imports get their own lens
  and their own retention budget and cannot evict canvas history.
- **Flag the import txn as a checkpoint.** "Just before the import" is the restore
  point people actually want.

Re-import conflicts (a shape changed on both sides) use the same per-property
conflict policy as multiplayer — the sync layer is simply an actor whose policy
leans toward "refuse and surface" rather than last-writer-wins.

"What changed since the last sync" is a seq-range query. Free.

### The one requirement history imposes on sync

**Shape ids must be stable across re-imports.** Without a persistent
`figmaNodeId <-> shapeId` mapping, every re-sync mints new UUIDs, every shape's
history restarts, and the tab shows nothing but repeated "Created" rows.

Store it on both sides: the canonical map in our document, and a back-reference
on the Figma node via `setSharedPluginData` (100 kB per entry is ample for one
id, and it travels with the Figma file, surviving plugin uninstall). This is the
only thing in the plugin story that has to be decided before Phase 3.

## Selective undo is not always well-defined

If op A creates a shape and op B recolors it, "undo A only" has no canonical
answer. Needs an explicit dependency relation plus a per-lens policy: **refuse**,
**cascade** (undo dependents too), or **partial**. Vector path editing probably
wants cascade; property tweaks want partial.

**Do not store inverses at record time.** Store the *before* value plus enough
attribution to decide at undo time whether it is still ours to restore. A
pre-baked inverse resurrects stale values as soon as a collaborator touches the
same field.

## UI

### Shape history tab

A projection, not a second history: `filter = touches.has(shapeId)`, straight
off `txn_entity`.

Rows are **semantic events, not ops** — raw `set x = 41.2` is unreadable.
Coalesce by `(entity, groupId, ~time window)` and label:

```
[thumb] Fill changed             DH   2m
[thumb] Path edited · 4 nodes    DH   4m
        > 340 steps in path edit
[thumb] Moved · 3 times          AC   1h
[thumb] Created                  DH   20 Jul
```

Three things worth building:

- **Thumbnails per row** — reconstruct the shape at that seq, render isolated
  into a 48 px offscreen tile, cache by `(shapeId, seq)`, render lazily on
  scroll-into-view. This is the only new `render-wasm` surface:
  `render_isolated(subtree, w, h) -> pixels`.
- **Scrub preview is local-only and uncommitted.** Hovering renders a ghost.
  Nothing commits or broadcasts until confirm — otherwise collaborators get
  spammed while someone drags the scrubber.
- **Deleted shapes.** The log holds deletes, so "restore the button I deleted
  Tuesday" comes nearly free. No design tool does this well.

### Placement: right panel

Shape history goes in the **right** panel, as a fifth `inspectorTab` value.

The app's own convention is *left panel navigates the document, right panel
edits the current selection*. The left panel does not change when you select
something; the right one does. Shape history is selection-scoped and follows
selection, so it belongs on the right — and restore is a change, not
navigation. Cost is near zero: one signal value plus one branch at
`RightSidePanel.tsx:285`, the same slot Motion and Interactions occupy.

### One tab, scope follows selection

There is **no separate document-history surface**. Document history is the same
tab with nothing selected — `filter = all` is just the identity lens, so it
costs no extra machinery.

The scope control is the single source of truth, with three values defaulted
from selection and overridable by the user:

| Selection | Default scope | Query |
| --- | --- | --- |
| nothing | `Document` | no filter |
| one shape | `This shape` | `txn_entity[id]` |
| a frame / group | `Include children` | `txn_subtree[id]` |
| several shapes | `This selection` | union of `txn_entity[id]` |

Multi-select is a **union**, not an intersection — "history of what I have
selected" is what people mean.

Four things this needs to be usable:

- **A pin.** Selection churns constantly, so comparing two shapes' histories is
  impossible if the panel always follows. A pin in the header freezes the
  current scope while selection moves on (the same affordance as DevTools'
  pinned element). Without this, selection-driven scope is frustrating.
- **Debounce + preserved view state.** Keep scroll position and row expansion
  per scope so flicking through a selection does not reset the panel.
- **Document rows are coarser and actor-first.** Shape scope says "Fill
  changed"; document scope says "Sarah edited Card / Button — 14 changes". Wider
  coalescing window (minutes, not seconds), grouped by day, with saved points as
  milestone rows. It is an activity feed at that altitude, not an op list.
- **Document rows come from the coarse retention tier.** 100k transactions is
  not scrollable. Document scope shows checkpoints, milestones and rollups by
  default, with drill-down into the fine tier — which is exactly the tier
  structure under "Retention" surfacing in the UI.

Restore at document scope is a big, destructive-feeling action: require
confirmation, show a preview, and make clear it lands as one appended
transaction and is therefore itself undoable.

A horizontal timeline was never required — Google Docs and Notion version
history are vertical lists, which fits a 320 px panel fine. That assumption was
the only thing that argued for a wider, left-side home.

Fallback if five tabs prove too tight at panel width: open it as a **floating
panel via the existing side-editor pattern** (as `FloatingColorEditorPanel` /
stroke settings do) from the layer context menu. Less discoverable, no tab
crowding, and precedented in this codebase. The panel host is a one-line change
either way, so this is not a decision that locks anything in.

### Display may follow selection; actions may not

These two look contradictory and are not:

- **A read-only view scoped by selection is fine** — that is what an inspector
  is. The scope is visible on screen, the user can see what they are looking at,
  and reading changes nothing. So the History tab following selection is correct.
- **A keybinding scoped by selection is not.** Cmd+Z must never silently mean
  different things because selection changed. The user does not perceive
  selection as a mode, so the surprise cost is high and invisible.

Hence: undo scope comes from something the user perceives as a *place* — focus
modes are places, and a shape is a place when you are focused *into* it. Current
selection is not. Per-shape undo is exposed as an explicit "Undo change to this
shape" command, and every restore button in the panel names its target rather
than relying on ambient scope.

## Current code assessment

Measured 2026-07-25 against `develop`.

**The seam:** everything enters history through one function,
`recordHistoryFrame` in `src/lib/history/history-sync.ts`, called synchronously
from `commitChanges`. Swap what sits behind it and none of the 22
`commitChanges` call sites move.

**`CommitFrame` already is a transaction.** `src/lib/changes/commit-types.ts:15`
is already `{ redoChanges, undoChanges, docMetaRedo/Undo, groupId }` — a forward
vector plus its inverse plus a group tag. It is missing only `seq`, `actor`,
`parentSeq` and `scope`, and those go on the frame, not on `Change` (which comes
from the `penpot-exporter` submodule — extend locally, as with stroke settings).

| Area | Now | After |
| --- | --- | --- |
| `history-store.ts` | 369 lines; `undoStack` / `redoStack` / `focusBuffer` | rewritten as journal + cursor + lens registry, ~500–600 |
| `focus-undo.ts` + `focus-pending.ts` | 132 lines; parallel sub-history | mostly **deleted** — becomes a scope tag and a lens |
| `undo` / `redo` in `page-crud.ts` | 34 lines; pop-a-stack | lens `pick()` + `rebase()` + commit inverse |
| `changes/` | 512 lines | unchanged |
| 22 `commitChanges` call sites | — | unchanged |
| `render-wasm` | — | one addition: `render_isolated` |

`FocusBuffer`, the buffer-vs-stack branching in `landFrame`, and the dual-reader
guards (`if (focusBuffer) return` in both `undo` and `redo`) all **go away**.
Focus mode stops being a special case and becomes `scope = 'path-edit:<id>'`.
That region gets simpler.

**Genuinely new:** `rebase()` (nothing today resembles it); SQLite persistence
(there is a persistence layer — `kv-indexeddb.ts`, `document-persistence.ts` —
but history is not in it: `useHistoryStore` is pure zustand and `clearHistory`
wipes it, so the log is a new store alongside the existing KV); the index
extractor pulling object ids out of `Change[]` to populate `touches`; and all of
multiplayer — there is no websocket, presence or CRDT layer anywhere in `src`.

**One thing already solved:** `foldFrames` collapses a focus session into one
entry on exit, so 340 path edits cost one slot against `MAX_UNDO = 200`
(`history-store.ts:9`). But it solves it by *discarding* the sub-steps — the
buffer is dropped on exit and re-entering starts empty. That is the actual gap
this closes: same one-slot cost, except the children survive under their own
scope budget, which is exactly what the tab needs to have anything to show.

## Phases

Only Phase 1 touches existing code. 2–4 are additive.

**Phase 1 — journal, single-player, no persistence.** Replace the two stacks
with one log + cursor + lens registry behind `recordHistoryFrame`. Delete
`FocusBuffer` and the dual-reader guards; canvas and path-edit become lenses.
Add `seq` / `actor` / `parentSeq` / `scope` to the frame. Behaviour-preserving —
the two existing files in `test/lib/history/` are the regression net.

**Phase 1a — `rebase()` with property tests.** Do this first within Phase 1, or
even before it. It is the shared dependency of undo, sync and offline, and the
piece that is expensive to retrofit if the semantics are wrong.

**Phase 2 — persistence.** SQLite WASM over OPFS, the schema above, both index
tables, per-aggregate snapshots, blob spill, tiered retention. Undo cursor still
resets on open.

**Phase 3 — history tab.** Read-only. New `inspectorTab` value + panel component
+ `render_isolated` in `render-wasm` for thumbnails. All four scopes (document,
this shape, include children, this selection) from one lens with a swapped
predicate; pin; restore as a forward diff commit; deleted-shape view.

**Phase 4 — multiplayer.** Sequencer, WS transport, durable/ephemeral split,
fractional indexing for reorder, cycle rejection on reparent, presence. Changes
nothing from Phases 1–3.

Land the **multi-id bulk op** and the propagation `origin` link in the op
encoding from day one — they change the wire format, and the bulk op is already
needed for the token-propagation bloat (~5 MB at 10k shapes; see
`docs/tokens-styles-port-plan.md`).

## Open questions

- Dependency between operations — **mechanism settled, policy still open.**
  See "Operation dependencies" below.
- Whether the animation lens picks by keyframe time or by recency.
- Component/instance `origin` links: how the tab renders "changed via main
  component" and whether it links across.
- Coalescing windows per scope: how coarse document rows should be before they
  stop being useful.
- Whether saved points are only automatic (checkpoints) or the user can name one.
- Hot-window size, and whether the cursor persists for single-player sessions.

### Operation dependencies

"Undo A only" is ill-defined when later operations were built on A (see
"Selective undo is not always well-defined"). Prior art for the general case is
Cheng, He, Xu, Han, Cai & Chen, *A multi-user selective undo/redo approach for
collaborative CAD systems*, JCDE 1(2) 2014, 103–115 (doi 10.7315/JCDE.2014.011)
— same group as the Cai/He selective-undo line already cited. They derive a
*dependency operation set* from a Feature Combination Hierarchy, undo the target
together with its whole set, re-evaluate only the affected branch, and forbid
redoing an operation that was undone as a dependency.

**We need much less machinery than they do, and the reason is worth recording.**
Their hierarchy exists because parametric CAD dependencies are *implicit*: a
feature is defined against topological entities created by an earlier feature
("fillet this edge"), which is the persistent-naming problem. Ours are
*explicit* — every dependency in this codebase is a UUID stored in the node.
That includes 3D: `scene3d` is a plain scene graph, not CSG, so it adds no
constructive dependencies. So the answer is an **index, not a hierarchy**:

- **Structural edges come free.** An op on an entity depends on whatever created
  it; a child depends on whatever created its parent. Both fall out of `add` and
  `mov`, which already carry `parent`.
- **Reference edges need one extractor per field** — `refsOf(op) -> EntityId[]`
  over token bindings, component/instance links, slot targets, shader material
  field references, interaction targets. Verify each against the real node shape
  when building it; not all carry the reference in the obvious form.
- Feed both into a derived inverted table `txn_refs(referenced, seq)`, alongside
  `txn_entity` and `txn_subtree`. The dependency set of a target is then the
  entities it created, the later transactions touching or referencing those, and
  the transitive closure — a backward walk bounded by the gap, structurally the
  same as the liveness pass.

**This implies no encoding commitment (D14) and can be deferred at zero cost.**
Index tables are derived, never authoritative, and rebuildable from `ops`, so
`txn_refs` can be built when Phase 3 needs it and backfilled over history
already written. Contrast the `scene3d` decomposition, which *is* an encoding
change and therefore has a Phase 2 deadline.

**Still open — the policy.** Cascade is correct but harsh: silently deleting a
shape and an hour of edits on it because an old create was undone is arguably
worse than refusing. Current lean for the Phase 3 tab is **refuse with an
explanation**, keeping cascade as an explicit "undo this and everything built on
it" action, with the choice per lens. If cascade is adopted, their redo
restriction follows — an operation undone as a dependency must not be
independently redoable.

Note Phase 1 needs none of this: today's system already cascades destructively
through `del-obj`, so behaviour matches either way. This becomes reachable when
the tab lets a user undo an arbitrary old operation.

## Naming for the code

- The whole thing: `Journal` — a log/DAG, not a stack. Name it so nobody adds
  `.pop()`.
- The per-mode plugin: `HistoryLens`.
- In comments and docs: **selective undo** / **scoped undo**, so future readers
  can find the literature.
