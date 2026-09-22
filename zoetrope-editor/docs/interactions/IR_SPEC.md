# Interactions IR — reference

> The code is the source of truth. This is a map of where each piece lives and
> the rules that bind them. Module root: `src/lib/renderer/interactions/`.

## Layers

```
authoring surface (panel · later: text DSL)
        │  edits
        ▼
stored sugar  ──(normalize)──►  reactive graph  ──(emit-react)──►  React source
   ir.ts                          ir.ts (GraphNode)                 compile/emit-react.ts
```

- **Stored sugar** is what serializes and what the UI edits. **The graph is a
  compile artifact** (never stored). Expressions are stored as **trees whose
  references are ids** (`Expr` / `Ref`); text is a projection made at the edge
  (`expr.ts`), so renaming a cell never breaks a wire.
- **Storage**: page-scoped — a `PageInteractions` block (`version: 3`) per
  `IndexedPage` (shape/render model untouched; nodes referenced by id, the
  `objects` key). Stores are document-wide: `DocumentMeta.stores`.
- **Upgrade**: a stored `version: 1` (variables / derived / bindings / states /
  repeaters / editable) or `version: 2` (expressions as text, cells by name)
  block is converted on read by `upgradePageInteractions` (`upgrade.ts`); a
  version-1 block's stores are hoisted onto the document. The 2 → 3 step is
  deterministic: a cell's `uid` is its version-2 reference.

## The model — three things

```
cells        the ONE kind of state       Cell { uid, id, owner, type, initial, formula?, store? }
refs         a node's properties point   NodeRefs { node, props: { prop: Expr }, item? }
             at cells
interactions write cells                 Interaction { on: { node, trigger }, if?: Expr, do: Action[] }

Ref  = cell(uid) | item(name) | node(id) | name(text)          what a reference points at
Expr = the constrained-JS AST with `ref` nodes holding a Ref   what is stored
```

- A **cell** has a stable `uid` (identity, never shown) and an `id` (its name:
  `draft`, or `state` in `card.state`). It either holds a value (`initial` is
  what the preview starts from) or is a **formula** (`formula` present —
  computed from other cells, read-only). `owner` says who it belongs to and so where the inspector shows it:
  `document`, `page`, or `node` (a node's own cell, e.g. a **variant set**:
  `type: { enum: [...] }`, addressed as `<node>.<cell>`). `store` names the
  document store the cell lives in — present ⇔ the value is supplied from
  outside; that membership is the whole "comes from the app" statement, and
  everything about props/callbacks is derived from it at lowering.
- A **reference** makes a node property read an expression over cells. Two
  property names are reserved: `repeat` (the node is a template repeated over
  the list the expression names; `item` names the loop variable and keys the
  instances) and `value` (when the expression is a bare writable cell the node
  EDITS it — two-way, a controlled input).
- An **interaction** is a trigger on a node, an optional guard, and actions that
  write cells (`set-variable`, `increment`, `collection.append`, …) or do
  things (`open-url`, `show-in-slot`, …). `AppRule` is the same with no node.

## Files

| File | Responsibility |
|---|---|
| [ir.ts](../../src/lib/renderer/interactions/ir.ts) | `Ref`/`Expr`, `Cell`/`NodeRefs`/`Interaction`, `PageInteractions` (v3), the earlier `V1*`/`V2*` shapes, the merge contract (`reconcile`/`referencedNodeIds`/`dropNodes`), normalized `GraphNode`. |
| [expr.ts](../../src/lib/renderer/interactions/expr.ts) | The edge: `parseExpr`/`resolveExpr` (text → ids), `namesOf`/`exprText` (ids → text), `parseRef`, `walkRefs`/`cellsIn`/`unresolvedNames`, `toTextIR` (the version-2 text projection, the AI wire format). |
| [upgrade.ts](../../src/lib/renderer/interactions/upgrade.ts) | `upgradePageInteractions`: v1 → v2 → v3 on read. |
| [catalog/](../../src/lib/renderer/interactions/catalog) | Open-union registry for trigger/action types: platform tags, fallbacks, `lowers`. Phase 0 entries in `triggers.ts`/`actions.ts`. |
| [expression.ts](../../src/lib/renderer/interactions/expression.ts) | Constrained JS-subset over NAMES: parser → `ExprNode`, `printExpr`, `evaluate` (preview), `toJs` (lowering), `freeRefs`. |
| [addressing.ts](../../src/lib/renderer/interactions/addressing.ts) | The text namespace: `buildScope` (what names mean), `parseRefPath`, `resolveCell`; `validatePageInteractions` over stored trees. |
| [anchor.ts](../../src/lib/renderer/interactions/anchor.ts) | `data-node-id` format + the 1:1 anchor-invariant validator. |
| [compile/normalize.ts](../../src/lib/renderer/interactions/compile/normalize.ts) | Sugar → reactive graph. |
| [compile/emit-react.ts](../../src/lib/renderer/interactions/compile/emit-react.ts) | Reactive behavior → idiomatic React (web emitter). |
| [document/edit-interactions.ts](../../src/lib/renderer/interactions/document/edit-interactions.ts) | Pure reducers the inspector commits through: cells, stores, refs, interactions. |
| [preview/runtime.ts](../../src/lib/renderer/interactions/preview/runtime.ts) | The pure preview interpreter: `initRuntime`, `applyAction`, `diffRuntime`, `affectedNodes`. |

## The addressing namespace (text)

```
ref ::= cell                  (a page or document cell:  items, cart.items)
      | node '.' cell         (a node's own cell:        card.state)
      | item '.' field        (loop item, inside a repeated node)
```
Resolution precedence: loop-item > cell > node. A node id that is not an
identifier is spelled `n_…` in expressions (`nodeRef`). Text is resolved ONCE,
when typed (the reducers) or when a version-2 block is read (the upgrade); a
name that resolves to nothing is kept as a `name` ref so nothing is lost. A
page is valid when no stored expression holds an unresolved name or a missing
cell, every behavior node exists, trigger/action types are known, and action
targets are writable cells of the kind the catalog `expects` (a formula is
never writable; `collection.*` needs a list).

## The expression whitelist

Allowed: literals (string/number/boolean/null/array/object), refs, member/index,
`! -`, `== != < > <= >= + - * / %`, `&& ||`, `?:`, single-param arrows, and the
method whitelist (`filter map some every find findIndex includes indexOf slice
concat join startsWith endsWith` + `Math.{min max abs round floor ceil sqrt
pow}`). `==`/`!=` are **strict** (lower to `===`/`!==`). Everything else (assignment,
arbitrary calls, loops, effects) is rejected at parse time. The evaluator and the
JS lowering are parity-tested to agree.

## The anchor contract

Every behavior-bearing node id appears as `data-node-id="<id>"` **exactly once**;
no id repeats. A repeated template counts once in the static source — runtime
instances carry `data-instance-key`. `validateGeneratedSource(ir, jsx)` enforces
this over AI-generated markup so deterministic weaving stays safe (the gate a
repair loop consumes).

## The three locked core decisions

1. **App/page rule scope** — `AppRule` (sources with no node).
2. **Where state lives** — `Cell.owner` (`document|page|node`) says who it
   belongs to; `Cell.store` says it is supplied from outside. A store cell
   lowers to a typed prop, and a write to it to a callback — the business-logic
   seam, derived, never authored.
3. **Regenerate/merge** — the behavior IR is source of truth; `reconcile(ir,
   presentNodeIds)` flags dangling behavior after regeneration; new behaviorless
   nodes are expected, not errors.

## Where this is going

The target model — one tree for 2D/3D, components with cells / bindings /
machine / transitions / timelines, tree-with-ids representation, TypeScript
as the text front end, Luau for scripts, runtime versus editor — is in
[MODEL.md](MODEL.md). Its §9 lists the engine changes in order.

## Inputs, gestures, devices

How every user input (pointer, keyboard, gamepad, TV remote, pen, XR, watch,
voice, sensors, a user-defined device) lands in these three shapes, and what
the catalog and runtime grow to get there: [INPUT_MODEL.md](INPUT_MODEL.md).

## Sanity gate — verified, not asserted

[sanity.test.ts](../../test/lib/renderer/interactions/sanity.test.ts) proves each
deferred capability is **catalog-only, zero foundation change**:

| Capability | How it lands | Core change? |
|---|---|---|
| **Discrete gesture** (swipe) | `registerTriggers` entry + an event-prop in the emitter table | none |
| **Continuous gesture** (drag value) | a store cell + a reference; emitter lowers to an animation runtime | none |
| **Async / backend** | `registerActions` entry (`lowers: 'effect'`); emitter async lowering | none |
| **Data-driven state-variant** | a variant cell with a `formula` — already in the IR | none |

Growth is confined to **(a) catalog entries** and **(b) the emitter's per-kind /
per-platform lowering tables**. The foundation — IR types, expression language,
addressing namespace, anchor contract — is untouched.
