# Interactions DSL — grammar (design-only)

> Status: **DESIGN**. The parser is **not** built in Phase 0. This grammar exists
> so the IR stays a *projection-friendly* model: a lossless, bidirectional text
> view can be added later (the AI / power-user / diff surface) with zero change to
> the foundation. The DSL adds **syntax**, never **capability** — it is exactly
> isomorphic to the stored IR ([ir.ts](../../src/lib/renderer/interactions/ir.ts)).

## Properties (non-negotiable)

- **Isomorphic to the IR** — `parse(text) → IR` and `print(IR) → text` round-trip
  losslessly; the printer is deterministic so generated text is stable/diffable.
- **Declarative, non–Turing-complete** — it *describes* interactions. No
  user-defined loops/functions. Iteration comes only from repeaters/collections.
- **Same namespace** — references are exactly the addressing grammar
  (`variable | derived | port | node.prop | node.state | item.field`).
- **Same expression whitelist** — conditions/values use the constrained
  JS-subset from [expression.ts](../../src/lib/renderer/interactions/expression.ts).

## Grammar (EBNF sketch)

```ebnf
page        = { decl } ;
decl        = state_decl | derived_decl | port_decl
            | interaction | app_rule | binding | repeater | states_decl ;

state_decl  = "state" ident ":" type [ "@" scope ] "=" json [ "persist" ] ;
derived_decl= "derive" ident "=" expr ;
port_decl   = "port" ("in"|"out") ident ":" type ;

interaction = "on" ref "." trigger [ "where" expr ] ":" action_block ;
app_rule    = "on" trigger [ "where" expr ] ":" action_block ;   (* trigger has scope=app *)
action_block= NEWLINE INDENT { action } DEDENT | action ;
action      = action_name [ ref ] [ "<-" expr ] ;

binding     = "bind" ref "<-" expr ;                              (* ref = node.prop *)
repeater    = "repeat" ref "over" ref [ "as" ident ] [ "key" expr ] ;
states_decl = "states" ref "=" "[" ident { "," ident } "]"
              ( "self" [ "=" ident ] | "<-" expr ) ;

type        = "string"|"number"|"boolean"|"object"|"any"|"collection" "<" type ">" ;
scope       = "local"|"page"|"global" ;
ref         = ident { "." ident | "[" expr "]" } ;
trigger     = ident ;                                            (* validated by catalog *)
action_name = ident { "." ident } ;                             (* validated by catalog *)
expr        = (* the constrained JS-subset, see expression.ts *) ;
```

## Round-trip demonstration (the todo page)

**DSL:**

```
state items: collection<object> @page = []
derive isEmpty = items.length == 0

on addBtn.press:
    append items <- { label: "" }

bind addBtn.disabled <- isEmpty
bind row.text <- item.label
repeat row over items as item
```

**IR (what it round-trips to — abbreviated):**

```json
{
  "variables": [{ "id": "items", "type": { "collection": "object" }, "scope": "page", "initial": [], "source": "local" }],
  "derived":   [{ "id": "isEmpty", "expr": "items.length == 0" }],
  "interactions": [{ "on": { "node": "addBtn", "trigger": { "type": "press" } },
                    "do": [{ "type": "collection.append", "target": "items", "value": "{ label: \"\" }" }] }],
  "bindings":  [{ "node": "addBtn", "prop": "disabled", "from": "isEmpty" },
                { "node": "row", "prop": "text", "from": "item.label" }],
  "repeaters": [{ "node": "row", "over": "items", "as": "item" }]
}
```

Every DSL line maps to exactly one IR element and back. `append items <- expr` ↔
the `collection.append` action; `bind` ↔ `Binding`; `repeat … as` ↔ `Repeater`;
`derive` ↔ `Derived`; `state … @page` ↔ a page-scoped `Variable`. Trigger/action
names (`press`, `append`) resolve through the catalog, so the DSL grows with the
catalog — never with the grammar.

## When this gets built

A later phase adds `parse`/`print` (likely over the existing
[expression](../../src/lib/renderer/interactions/expression.ts) tokenizer for the
embedded exprs). Because it's a pure projection of the IR, it touches **zero**
foundation code — same additivity the Phase 0 sanity gate verified for catalog
entries.
