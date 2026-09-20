# Interactions DSL — grammar (design-only)

> **Superseded for the authoring surface** (2026-09-21): the free-text fields
> in the UI use a TypeScript expression subset through the TS language
> service, lowered to the id-based tree — see [MODEL.md](MODEL.md) §4–§5. This
> file remains the sketch of a whole-page text projection.

> Status: **DESIGN**. The parser is **not** built. This grammar exists so the IR
> stays a *projection-friendly* model: a lossless, bidirectional text view can be
> added later (the AI / power-user / diff surface) with zero change to the
> foundation. The DSL adds **syntax**, never **capability** — it is exactly
> isomorphic to the stored IR ([ir.ts](../../src/lib/renderer/interactions/ir.ts)).

## Properties (non-negotiable)

- **Isomorphic to the IR** — `parse(text) → IR` and `print(IR) → text` round-trip
  losslessly; the printer is deterministic so generated text is stable/diffable.
- **Declarative, non–Turing-complete** — it *describes* interactions. No
  user-defined loops/functions. Iteration comes only from `repeat` over lists.
- **Same namespace** — references are exactly the addressing grammar
  (`cell | node.cell | item.field`).
- **Same expression whitelist** — conditions/values use the constrained
  JS-subset from [expression.ts](../../src/lib/renderer/interactions/expression.ts).

## Grammar (EBNF sketch)

```ebnf
page        = { decl } ;
decl        = cell_decl | interaction | app_rule | ref_decl | repeat_decl ;

cell_decl   = "cell" ref ":" type [ "@" owner ] [ "in" ident ]
              ( "=" json | "<-" expr ) ;                          (* "<-" makes it a formula *)

interaction = "on" ref "." trigger [ "where" expr ] ":" action_block ;
app_rule    = "on" trigger [ "where" expr ] ":" action_block ;   (* trigger has scope=app *)
action_block= NEWLINE INDENT { action } DEDENT | action ;
action      = action_name [ ref ] [ "<-" expr ] ;

ref_decl    = "ref" ref "<-" expr ;                               (* ref = node.prop *)
repeat_decl = "repeat" ref "over" ref [ "as" ident ] [ "key" expr ] ;

type        = "string"|"number"|"boolean"|"object"|"any"
            | "collection" "<" type ">" | "enum" "[" ident { "," ident } "]" ;
owner       = "document" | "page" ;                               (* a node's cell is owned by its node: card.state *)
ref         = ident { "." ident | "[" expr "]" } ;
trigger     = ident ;                                            (* validated by catalog *)
action_name = ident { "." ident } ;                             (* validated by catalog *)
expr        = (* the constrained JS-subset, see expression.ts *) ;
```

## Round-trip demonstration (the todo page)

**DSL:**

```
cell items: collection<object> @page = []
cell isEmpty: any <- items.length == 0
cell card.state: enum[collapsed, expanded] = "collapsed"

on addBtn.press:
    append items <- { label: "" }

ref addBtn.disabled <- isEmpty
ref row.text <- item.label
repeat row over items as item
```

**IR (what it round-trips to — abbreviated):**

```json
{
  "version": 2,
  "cells": [
    { "id": "items",   "owner": { "kind": "page" }, "type": { "collection": "object" }, "initial": [] },
    { "id": "isEmpty", "owner": { "kind": "page" }, "type": "any", "initial": null, "formula": "items.length == 0" },
    { "id": "state",   "owner": { "kind": "node", "node": "card" }, "type": { "enum": ["collapsed", "expanded"] }, "initial": "collapsed" }
  ],
  "interactions": [{ "on": { "node": "addBtn", "trigger": { "type": "press" } },
                    "do": [{ "type": "collection.append", "target": "items", "value": "{ label: \"\" }" }] }],
  "refs": [
    { "node": "addBtn", "props": { "disabled": "isEmpty" } },
    { "node": "row",    "props": { "repeat": "items", "text": "item.label" }, "item": { "as": "item" } }
  ]
}
```

Every DSL line maps to exactly one IR element and back. `append items <- expr` ↔
the `collection.append` action; `ref` ↔ one entry of a node's `props`;
`repeat … as` ↔ the reserved `repeat` prop plus `item`; `cell … <- expr` ↔ a
formula cell; `cell … in app` ↔ a cell living in the `app` store. Trigger/action
names (`press`, `append`) resolve through the catalog, so the DSL grows with the
catalog — never with the grammar.

## When this gets built

A later phase adds `parse`/`print` (likely over the existing
[expression](../../src/lib/renderer/interactions/expression.ts) tokenizer for the
embedded exprs). Because it's a pure projection of the IR, it touches **zero**
foundation code — same additivity the Phase 0 sanity gate verified for catalog
entries.
