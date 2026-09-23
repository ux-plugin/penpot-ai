# History model

Status: decided 2026-09-22. Supersedes `history-redesign-plan.md` (journal,
lens, rebase) and the per-subject `versions/` store. Nothing below is built yet.

## Two mechanisms, one entry point

| | Undo / redo | Snapshots |
|---|---|---|
| question | take back what I just did | what did the document look like |
| unit | inverse of an edit | a state |
| lifetime | session, gone on reload | durable |
| needs | speed, exactness | crash safety, sharing, rewind |

They were coupled before (one log serving both), and that coupling is what
produced the lens, rebase and liveness code. Kept apart, each is small.

`commitChanges` is the only writer of both: it applies the changes, pushes an
undo frame, and records a snapshot. No other code touches either.

## Undo / redo

An in-memory stack of frames, one per commit. A frame is the commit's inverse
changes. Undo applies the inverse through `commitChanges` and moves the cursor;
new work truncates the redo side. Cleared on reload.

A focus mode (path edit, shader, 3D scene, animation) is a **scratch branch**
on the same vello canvas: `fork` opens a branch with its own empty stack,
`merge` squashes it into one frame on the parent stack, `discard` throws it
away. No scope tags, no lens.

## Snapshots

A snapshot is a **commit**: the document state after one edit, with structural
sharing so an edit costs the size of what changed.

```
commit { id, parent, time, label, touched: NodeId[], root: TreeHash }
object { hash → bytes }          content-addressed: shape blobs, trie nodes
```

- **Rewind the document**: check out a commit. Applied as an ordinary change
  set, so it gets an undo frame and a new commit. No special mode.
- **Per-shape history**: the commits whose `touched` contains the shape.
- **Revert a commit**: inverse diff over its `touched` set, as a new commit.
- **Restore one shape**: an ordinary edit plus repair rules. Missing parent
  goes to root, missing children are dropped from order, dangling cell
  references stay visible as errors.
- **Retention**: squash runs of commits into one (union of `touched`); the
  objects only they referenced are collected.

Entangled operations are handled by granularity: "revert commit" undoes the
whole operation, "restore shape" edits one shape and repairs.

## What this deletes

`src/lib/history/journal/` (op, codec, journal-store, lens, rebase, scope),
`src/lib/history/versions/`, `DevJournalPanel`, and the journal sections of
`history-redesign-plan.md`. The Change pipeline and every `commitChanges`
call site are untouched.

## Database

The store is a blob store plus one index, not a query engine. See
`state-architecture.md` for the in-memory side (valtio stays).

- `objects(hash, bytes)`, `commits(id, parent, time, label, root)`,
  `commit_nodes(commit, node)` for per-shape history, `heads(name, commit)`.
- Web: SQLite-WASM over OPFS. Desktop: SQLite. Server: the same tables.
- Sync later is git push: objects and commits the other side lacks, with a
  revision check on the head for multiplayer.
- Ruled out by this decision: CRDT stores (they own history), event-log
  engines (there is no log), reactive query layers (valtio is the in-memory
  model).
