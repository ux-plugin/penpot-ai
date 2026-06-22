# Interactions — Phase 0: The Foundation

> Status: **PHASE 0 COMPLETE** · Branch: `worktree-interactions-phase-0` · Scope: `skia-rs-wasm` (TypeScript)
>
> Phase 0 builds the *complete* foundation so that every later interaction type
> (gestures, async, state-variants, cross-platform) is an **additive catalog
> entry**, never a rewrite. We ship a small catalog, but a whole model.

---

## 0. North star

A design-tool interaction system that:

1. is authored as a **reactive dataflow graph** (Signals + Events + a fixed
   combinator set + ports), with **ECA** as the friendly surface syntax;
2. is stored as a **declarative, normalized IR** addressable by shape id;
3. compiles **deterministically** to idiomatic **React / React-Native** source —
   no runtime engine shipped; React *is* the runtime;
4. sits exactly at the **frontend-business-logic → UI** seam via typed **ports**.

The hard rule that prevents rewrites: **ECA is not the foundation — the
Signal/Event graph is. ECA is a projection that compiles into it.**

---

## 1. Why these primitives are complete (recap of the design)

Every interaction is `INPUT → LOGIC → OUTPUT`. The graph is closed over that:

| Layer | Primitives | Platform |
|---|---|---|
| **Sources** (input) | discrete `Event`, continuous `Signal`, ports, timers, lifecycle | **catalog / platform-specific** |
| **Logic** | `filter` · `derive` · `fold` · `sample` · `switch` · `effect` | **platform-agnostic (pure JS)** |
| **Sinks** (output) | node prop bindings, navigation, ports | **catalog / platform-specific** |

`derive` (pure fns) + `fold` (state) + `effect` (I/O) make the logic layer
computationally universal. The **only** acknowledged gap is multi-directional
constraint solving (layout solver), absorbed later by a single `constraint`
node that wraps a solver. Not in scope for a long time.

---

## 2. Where it attaches in the codebase

Grounded in the current model:

- **Node identity** — `IndexedPage.objects[id]` is a flat map keyed by a stable
  id (`DocumentModel.getNode` in
  [document-model.ts](../../src/lib/renderer/store/document-model.ts)). This id
  is the anchor source and the addressing key. **No new identity system needed.**
- **State mutation path** — `DocumentModel.applyChanges` → `commitChanges({ redoChanges: Change[] })`.
  *Authoring-time* edits to the interaction IR reuse this. (Runtime state
  changes live in the *generated* React app, not here.)
- **Persistence** — pages serialize through the Penpot document format
  (`flattenPageToIndexed` / `unflattenIndexedPageToPage`). `penpot-exporter`
  already exposes an `interactions` field on shapes
  ([shape.ts](../../packages/penpot-exporter/ui-src/lib/types/shapes/shape.ts)) —
  our compat anchor.
- **New module** — `src/lib/renderer/interactions/` owns the IR, grammar,
  expression evaluator, anchor contract, and compiler. It reads node ids from
  the document model; it does **not** modify the shape/render model.

**IR home decision (recommended):** interactions are **page-scoped** —
`IndexedPage.interactions` holds `{ variables, derived, interactions, bindings, ports }`
for that page; per-node data (a node's variant `states`, its authored
interactions) is referenced *by id* into that block, not stored on the shape.
This keeps the shape/render model untouched and the interaction graph in one
serializable place per page. (Alternative: store per-node on the shape for
Penpot-`interactions` compat — see Open Decisions.)

---

## 3. Phase 0 deliverables (the foundation artifacts)

Each is a spec + types. Items **A–G are core** (designed once, never rewritten);
**H** is the proof-of-life.

### A. The IR schema (`interactions/ir.ts`)

Two layers in one file: the **stored ECA-sugar** (what the panel edits) and the
**normalized graph** node-kinds it expands to.

```ts
// ---- stored / authored (the "language") ----
type Scope = 'local' | 'page' | 'global'

interface Variable {
  id: string
  type: 'string' | 'number' | 'boolean' | 'object' | { collection: ValueType }
  scope: Scope
  initial: Json
  source: 'local' | 'port'          // 'port' => generated as a typed prop/callback
  persist?: 'none' | 'local-storage'
}

interface Derived { id: string; expr: Expr }            // pure -> a `derive` node

interface Interaction {                                  // ECA sugar
  on: { node: NodeId; event: TriggerType }               // TriggerType: open-ended union
  if?: Expr                                              // -> `filter`
  do: Action[]                                           // -> `fold` | `effect` | `switch`
}

interface Binding { node: NodeId; prop: string; from: Expr }   // -> `sink`

interface NodeStates {                                    // addressable variant states
  node: NodeId
  states: string[]                                       // AI/design styles each
  active: { from: 'self' } | { bind: Expr }              // self state-machine OR derived
}

interface Port { id: string; dir: 'in' | 'out'; type: ValueType }

interface PageInteractions {
  variables: Variable[]; derived: Derived[]
  interactions: Interaction[]; bindings: Binding[]
  states: NodeStates[]; ports: Port[]
  appRules: AppRule[]                                    // non-node sources (see G)
}

// ---- normalized graph (compile target of the above) ----
type GraphNode =
  | { kind: 'source'; produces: 'signal' | 'event'; ... }
  | { kind: 'filter' } | { kind: 'derive' } | { kind: 'fold' }
  | { kind: 'sample' } | { kind: 'switch' } | { kind: 'effect' }
  | { kind: 'sink' }   | { kind: 'port' }
```

Rules:
- `TriggerType` and `Action['type']` are **open string unions with a registry** —
  adding `swipe` or `collection.append` is a catalog entry, not a type change.
- Every `Action` is a **discriminated union** so `navigate`, `collection.append`,
  `node.setState`, `set-variable`, `effect.call` are additive.
- Store the **sugar**; the normalized graph is a compile artifact (not persisted).

### B. Addressing grammar (`interactions/addressing.ts`)

One namespace everything (conditions, bindings, actions) references:

```
ref   ::= var                       // items, cart.total          (scoped variable)
        | node '.' prop             // addBtn.disabled, row.x     (bindable sink/source)
        | node '.' 'state'          // card.state                 (variant Signal)
        | port                      // onSave, initialItems
member access: '.' field | '[' index ']'
repeater scope: inside a repeater, `node`/`item` resolve to the loop instance
```

Spec defines: resolution rules, scope shadowing (local > page > global),
repeater instance binding (`row[item.id]`), and validation (a ref must resolve
to a declared variable / existing node id / declared port).

### C. Expression language whitelist (`interactions/expression.ts`)

Pure · total · serializable · **identical lowering on web & native.**

```
operators:  == != < > <= >=   && || !   + - * / %   ?:
helpers:    .length  .includes(x)  .some(fn)  .every(fn)  .filter(fn)  .map(fn)
            .find(fn)  Math.min/max  string concat
literals:   number | string | boolean | null | array | object
refs:       <ref> from (B)
FORBIDDEN:  assignment, loops, arbitrary function calls, side effects, eval
```

Deliverable: the `Expr` AST, a parser for the expression mini-language, and a
**deterministic evaluator** used for (1) authoring-time preview and (2) the
source of truth the React emitter transliterates. The emitter must produce the
*same* semantics in JS — so the AST → JS lowering is part of this file.

### D. DSL grammar — design only (`interactions/DSL.md`)

We do **not** build the parser in Phase 0. We **do** write the one-page grammar
to guarantee the IR is a **lossless, bidirectional projection** (so the text
view + AI-authoring seam can be added in a later phase with zero core change).

```
state items: collection = []
derive isEmpty = items.length == 0
on addBtn.press: append items <- { label: "" }
bind addBtn.disabled <- isEmpty
```

Constraint: declarative, non–Turing-complete, same namespace + expression
whitelist. The grammar must round-trip to/from the IR in §A.

### E. Anchor contract spec (`interactions/anchor.ts`)

The design↔code identity contract that makes deterministic injection possible.

- **Rule:** every node id → exactly **one** anchored root element
  (`data-node-id="<id>"`, web; marker prop, native). AI may style/nest freely
  *inside* it; may not move, drop, duplicate, split, or merge the anchor.
- **Repeater amendment:** a repeated node's id is a **template** id; runtime
  instances carry `data-node-id` + `data-instance-key={rowId}`.
- **Validation pass:** parse generated JSX → assert every interactive node's
  anchor is present **exactly once** → fail/repair loop on violation. (Spec the
  pass + failure modes; implement the checker in H.)
- **Cardinality rule** (vaporizing nodes, semantic roles): documented decisions
  for shapes that become CSS-only or `<button>`/`<h1>`.

### F. Platform model (in `ir.ts` registry)

Every catalog **source/sink/action** entry carries:

```ts
{ key, platforms: ('web' | 'native')[], fallback?: CatalogKey, lower: { web, native } }
```

So web↔native is **two emitters over one model**. Phase 0 implements the
**web** emitter; the `native` lowering slot exists from commit one.

### G. The three core decisions to LOCK now (not later — they shape the model)

1. **App/page rule scope** — sources with no node (on-load, timer, key, scroll-
   to-bottom, resize, on-data-change, hardware back). Modeled as
   `PageInteractions.appRules: AppRule[]` — same trigger/condition/action shape,
   page-scoped instead of node-scoped. **Lock the type now.**
2. **State scope model** — `local | page | global` + `persist` + `source:
   'local'|'port'`, declared per variable (§A). This answers "which list?".
   **Lock the enum + resolution now.**
3. **Regenerate / merge strategy** — Plasmic-style split: the **interaction IR is
   the source of truth for behavior**; the **AI presentation is regenerated** and
   re-woven by anchor id. Deleted node ⇒ dangling interaction is flagged; new
   node ⇒ no behavior. Define: the merge algorithm contract + the
   dangling/orphan diagnostics. **Lock the contract now**, implement fully later.

### H. Compiler skeleton + vertical slice (`interactions/compile/`)

One interaction, end to end, proving the spine:

- Input: the **todo IR** — `items` (page collection), `isEmpty` derived,
  `addBtn.press → append items`, `addBtn.disabled ← isEmpty`, a `row` repeater.
- Pipeline: `sugar → normalized graph → React emitter` →
  ```tsx
  const [items, setItems] = useState([])
  const isEmpty = items.length === 0
  // <button data-node-id="addBtn" disabled={isEmpty}
  //         onClick={() => setItems(p => [...p, { label: '' }])}>
  // <ul data-node-id="list">{items.map(i => <Row key={i.id} data-node-id="row" .../>)}</ul>
  ```
- Plus the **anchor validation pass** running against that output.
- Lowering map covered by the slice: `source(event)`, `fold`, `derive`, `sink`,
  repeater. (gesture / effect / switch lowerings are stubbed with TODOs — they're
  later catalog, and the slice proves they slot into the same emitter.)

---

## 4. Proposed module layout

```
skia-rs-wasm/src/lib/renderer/interactions/
  ir.ts            # A — stored sugar + normalized graph types + catalog registry
  addressing.ts    # B — namespace grammar + resolver + validator
  expression.ts    # C — Expr AST, parser, evaluator, JS lowering
  anchor.ts        # E — anchor emit + validation pass
  catalog/
    triggers.ts    # F — open registry (web + native lowerings)
    actions.ts
    sources.ts
  compile/
    normalize.ts   # H — sugar -> graph
    emit-react.ts  # H — graph -> React (web emitter)
  index.ts
docs/interactions/
  PHASE_0_PLAN.md  # this file
  DSL.md           # D — grammar (design only)
  IR_SPEC.md       # A/B/C reference once stabilized
```

Serialization hook: extend `IndexedPage` with an optional `interactions:
PageInteractions` field; thread through `flatten/unflatten` (no shape-model
change).

---

## 5. Definition of done (Phase 0)

- [x] `ir.ts` types compile; `TriggerType`/`Action` are open + registry-backed.
- [x] Addressing grammar + resolver + validator (B) with unit tests.
- [x] Expression parser + evaluator + JS lowering (C) with unit tests (parity-tested).
- [x] DSL grammar written and shown to round-trip to the IR (D — `docs/interactions/DSL.md`).
- [x] Anchor contract spec + working validation pass (E).
- [x] Platform field on catalog entries; web emitter only (F).
- [x] Three core decisions locked as types/contracts (G).
- [x] Vertical slice generates correct React for "add + disable-when-empty" and
      passes the anchor validation (H — generated component typechecks via `tsc`).
- [x] **Sanity gate:** gestures / async / state-variant each shown to be a
      *catalog addition* with **zero** change to the foundation — verified
      empirically by `test/lib/renderer/interactions/sanity.test.ts`.

**Result: 45 tests passing · `tsc` clean · eslint clean. Foundation is sound;
later phases are catalog + emitter growth, no rewrites.**

---

## 6. Decisions (locked)

1. **IR storage location** — ✅ **LOCKED: page-scoped `IndexedPage.interactions`**.
   Per-node data referenced by id; shape/render model untouched.
2. **Penpot `interactions` compat** — ✅ **LOCKED: superset, map later**. IR is
   designed freely; an exporter mapping to/from Penpot's enum comes later. Not
   constrained to Penpot's model now.
3. **Emitter target in Phase 0** — ✅ **LOCKED: web-first (React DOM)**. The
   `native` lowering slot exists from commit one but is unimplemented.
4. **Store sugar vs normalized graph** — ✅ **LOCKED: store the ECA-sugar**
   (matches the panel, diffs well); normalized graph stays a compile artifact.
5. **Expression syntax** — ✅ **LOCKED: a JS-expression subset** (familiar,
   parseable) constrained to the whitelist, not a bespoke syntax.

---

## 7. Suggested build order

1. `ir.ts` types + catalog registry skeleton (A, F, G-types).
2. `expression.ts` (C) — needed by addressing + bindings.
3. `addressing.ts` (B) — depends on C.
4. `compile/normalize.ts` + `emit-react.ts` + vertical slice (H).
5. `anchor.ts` validation pass (E) against H's output.
6. `DSL.md` (D) + `IR_SPEC.md`, then the §5 sanity gate.
