# Interactions IR — reference

> The code is the source of truth. This is a map of where each piece lives and
> the rules that bind them. Module root: `src/lib/renderer/interactions/`.

## Layers

```
authoring surface (panel · later: text DSL)
        │  edits
        ▼
stored ECA-sugar  ──(normalize)──►  reactive graph  ──(emit-react)──►  React source
   ir.ts                              ir.ts (GraphNode)                 compile/emit-react.ts
```

- **Stored sugar** is what serializes and what the UI edits. **The graph is a
  compile artifact** (never stored). Expressions are stored as **source text** and
  parsed at compile time — keeping the IR diffable and DSL-projectable.
- **Storage**: page-scoped — a `PageInteractions` block per `IndexedPage`
  (shape/render model untouched; nodes referenced by id, the `objects` key).

## Files

| File | Responsibility |
|---|---|
| [ir.ts](../../src/lib/renderer/interactions/ir.ts) | Stored sugar types, `PageInteractions`, normalized `GraphNode`, the merge contract (`reconcile`/`referencedNodeIds`). |
| [catalog/](../../src/lib/renderer/interactions/catalog) | Open-union registry for trigger/action types: platform tags, fallbacks, `lowers`. Phase 0 entries in `triggers.ts`/`actions.ts`. |
| [expression.ts](../../src/lib/renderer/interactions/expression.ts) | Constrained JS-subset: parser → `ExprNode`, `evaluate` (preview), `toJs` (lowering), `freeRefs`. |
| [addressing.ts](../../src/lib/renderer/interactions/addressing.ts) | The reference namespace: `buildScope`, `parseRefPath`, `validatePageInteractions`. |
| [anchor.ts](../../src/lib/renderer/interactions/anchor.ts) | `data-node-id` format + the 1:1 anchor-invariant validator. |
| [compile/normalize.ts](../../src/lib/renderer/interactions/compile/normalize.ts) | Sugar → reactive graph. |
| [compile/emit-react.ts](../../src/lib/renderer/interactions/compile/emit-react.ts) | Reactive behavior → idiomatic React (web emitter). |

## The addressing namespace

```
ref ::= variable | derived | port            (a value)
      | node '.' prop                          (bindable prop)
      | node '.' state                         (variant signal)
      | item '.' field                         (loop item, inside a repeater)
```
Resolution precedence: loop-item > data (variable/derived/port) > node. A page is
valid when every `freeRefs` root of every expression resolves, every behavior node
exists, trigger/action types are known, and action targets match the catalog's
`expects` (e.g. `collection.append` → a collection variable; `node.setState` →
`<node>.state`).

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
no id repeats. A repeater template counts once in the static source — runtime
instances carry `data-instance-key`. `validateGeneratedSource(ir, jsx)` enforces
this over AI-generated markup so deterministic weaving stays safe (the gate a
repair loop consumes).

## The three locked core decisions

1. **App/page rule scope** — `AppRule` (sources with no node).
2. **State scope** — `Variable.scope` (`local|page|global`) + `source`
   (`local|port`). `port` variables become typed props/callbacks — the
   business-logic seam.
3. **Regenerate/merge** — the behavior IR is source of truth; `reconcile(ir,
   presentNodeIds)` flags dangling behavior after regeneration; new behaviorless
   nodes are expected, not errors.

## Sanity gate — verified, not asserted

[sanity.test.ts](../../test/lib/renderer/interactions/sanity.test.ts) proves each
deferred capability is **catalog-only, zero foundation change**:

| Capability | How it lands | Core change? |
|---|---|---|
| **Discrete gesture** (swipe) | `registerTriggers` entry + an event-prop in the emitter table | none |
| **Continuous gesture** (drag value) | a `port`-fed `Variable` + a `Binding`; emitter lowers to an animation runtime | none |
| **Async / backend** | `registerActions` entry (`lowers: 'effect'`) + a `Port`; emitter async lowering | none |
| **Data-driven state-variant** | a bound `NodeStates` (`active: { bind }`) — already in the IR | none |

Growth is confined to **(a) catalog entries** and **(b) the emitter's per-kind /
per-platform lowering tables**. The foundation — IR types, expression language,
addressing namespace, anchor contract — is untouched. **Phase 0 foundation is
sound.**
