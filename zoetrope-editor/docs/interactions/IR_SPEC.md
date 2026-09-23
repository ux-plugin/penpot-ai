# Interactions IR — reference

> The code is the source of truth. This is a map of where each piece lives and
> the rules that bind them. Module root: `src/lib/renderer/interactions/`.

## Layers

```
authoring surface (panel · AI chat in text form)
        │  edits = changes
        ▼
records in the document  ──behaviourOf(page)──►  Behaviour  ──(emit-react)──►  React source
cell · binding · rule · store                     { cells, bindings, rules }    compile/emit-react.ts
doc/schema/behaviour.ts                            ir.ts                 └──(runtime)──► live preview
```

- **Records** are what serializes and what the UI edits: `cell`, `binding`,
  `rule` and `store` are record kinds of the document, beside `page` and `node`
  (`docs/state-model.md`). Expressions are stored as **trees whose references
  are ids** (`Expr` / `Ref`); text is a projection made at the edge (`expr.ts`),
  so renaming a cell never breaks a wire.
- **Ownership** is declared in the schemas: a rule, a binding or a node's cell
  is deleted with its node, a page's with its page. A reference to a cell from
  an expression is not an ownership: a deleted cell leaves the reference
  dangling and validation reports it.
- **Stores** are document-wide records; a cell names its store (`keep`). Deleting
  a store detaches its cells (`removeStore`).
- **Text form** (`TextBehaviour`, `toText` / `fromText`): the same records with
  names instead of ids and source instead of trees. The AI chat reads and writes
  it; `fromText` keeps the ids of records that did not change.

## The model — three things

```
cells     the ONE kind of state       Cell { id, name, page?, node?, type, initial, formula?, store? }
bindings  a node's property reads     Binding { id, page, node, prop, expr, item? }
          cells
rules     write cells                 Rule { id, page, node?, order, on: Trigger, if?: Expr, do: Action[] }

Ref  = cell(id) | item(name) | node(id) | name(text)            what a reference points at
Expr = the constrained-JS AST with `ref` nodes holding a Ref     what is stored
```

- A **cell** has an `id` (identity, never shown) and a `name` (`draft`, or
  `state` in `card.state`). It either holds a value (`initial` is what the
  preview starts from) or is a **formula** (`formula` present — computed from
  other cells, read-only). Where it lives is its references: `node` (a node's
  own cell, e.g. a **variant set**: `type: { enum: [...] }`, addressed as
  `<node>.<name>`), `page` only (the page's), or neither (the document's).
  `store` names the store the cell lives in — present ⇔ the value is supplied
  from outside; everything about props/callbacks is derived from it at lowering.
- A **binding** makes one node property read an expression over cells. Two
  property names are reserved: `repeat` (the node is a template repeated over
  the list the expression names; `item` names the loop variable and keys the
  instances) and `value` (when the expression is a bare writable cell the node
  EDITS it — two-way, a controlled input).
- A **rule** is a trigger, an optional guard, and actions that write cells
  (`set-variable`, `increment`, `collection.append`, …) or do things
  (`open-url`, `show-in-slot`, …). With `node` it fires on that node; without,
  it belongs to the page (load, timer, key). `order` is a fractional index.

## Files

| File | Responsibility |
|---|---|
| [doc/schema/behaviour.ts](../../src/lib/doc/schema/behaviour.ts) | The record schemas with their references (`ref(kind, onDelete)`). |
| [ir.ts](../../src/lib/renderer/interactions/ir.ts) | `Ref`/`Expr`, `Trigger`/`Action`, `Behaviour` and its lookups (`findCell`, `cellById`, `bindingOf`, `rulesOn`, `editedCell`, `behaviourNodes`). |
| [expr.ts](../../src/lib/renderer/interactions/expr.ts) | The edge: `parseExpr`/`resolveExpr` (text → ids), `namesOf`/`exprText` (ids → text), `parseRef`, `walkRefs`/`cellsIn`/`unresolvedNames`, `formulasInOrder`, `toText`/`fromText` (the text form). |
| [catalog/](../../src/lib/renderer/interactions/catalog) | Open-union registry for trigger/action types: platform tags, fallbacks, `lowers`. Phase 0 entries in `triggers.ts`/`actions.ts`. |
| [expression.ts](../../src/lib/renderer/interactions/expression.ts) | Constrained JS-subset over NAMES: parser → `ExprNode`, `printExpr`, `evaluate` (preview), `toJs` (lowering), `freeRefs`. |
| [addressing.ts](../../src/lib/renderer/interactions/addressing.ts) | The text namespace: `buildScope` (what names mean), `parseRefPath`, `resolveCell`; `validateBehaviour` over stored trees. |
| [anchor.ts](../../src/lib/renderer/interactions/anchor.ts) | `data-node-id` format + the 1:1 anchor-invariant validator. |
| [compile/emit-react.ts](../../src/lib/renderer/interactions/compile/emit-react.ts) | Behaviour → idiomatic React (web emitter). |
| [document/behaviour.ts](../../src/lib/renderer/interactions/document/behaviour.ts) | `behaviourOf(page)`, `storesOf`, `commitBehaviour`, `diffBehaviour`/`replaceBehaviour`. |
| [document/edit-interactions.ts](../../src/lib/renderer/interactions/document/edit-interactions.ts) | The inspector's edits as changes: cells, stores, bindings, rules. |
| [preview/runtime.ts](../../src/lib/renderer/interactions/preview/runtime.ts) | The pure preview interpreter: `initRuntime`, `applyAction`, `runRule`, `diffRuntime`, `affectedNodes`. |

## The addressing namespace (text)

```
ref ::= cell                  (a page or document cell:  items, cart.items)
      | node '.' cell         (a node's own cell:        card.state)
      | item '.' field        (loop item, inside a repeated node)
```
Resolution precedence: loop-item > cell > node. A node id that is not an
identifier is spelled `n_…` in expressions (`nodeRef`). Text is resolved ONCE,
when typed (the edits) or when a text form is read (`fromText`); a
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

1. **App/page rule scope** — a `Rule` with no `node`.
2. **Where state lives** — a cell's `page` / `node` references say who it
   belongs to; `Cell.store` says it is supplied from outside. A store cell
   lowers to a typed prop, and a write to it to a callback — the business-logic
   seam, derived, never authored.
3. **Regenerate/merge** — behaviour is owned by its node: when a node goes,
   its rules, bindings and cells go in the same commit, and undo brings them
   back. New behaviourless nodes are expected, not errors.

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
| **Data-driven state-variant** | a variant cell with a `formula` — already in the model | none |

Growth is confined to **(a) catalog entries** and **(b) the emitter's per-kind /
per-platform lowering tables**. The foundation — IR types, expression language,
addressing namespace, anchor contract — is untouched.
