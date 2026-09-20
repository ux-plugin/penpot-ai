# The model — 2D, 3D, motion, interaction in one editor

> Status: **DESIGN, agreed 2026-09-21.** This is the target the cells IR
> ([IR_SPEC.md](IR_SPEC.md)) and the input model ([INPUT_MODEL.md](INPUT_MODEL.md))
> grow into. Where it disagrees with the shipped code, the code is behind.
> Nothing here is implemented beyond cells / refs / interactions.

## 0. The whole thing on one page

```
document   one tree, domain-namespaced kinds       2d.frame · 3d.mesh · 3d.scene (portal)
component  nodes + 4 parts
             cells        the ONE kind of state       Cell { id, type, initial, formula?, store? }
             bindings     property ← expr over cells  Map<PropertyPath, Binding>
             machine      one per enum cell           states { while, entry, exit } · transitions { from, to, on|when, if, do, motion }
             transitions  how a property moves        Map<PropertyPath, Transition>   (150ms ease-out · spring)
             timelines    clips over properties       Map<id, Clip | Sequence | Parallel | Stagger | Blend>
rules      only the machine writes cells
           only bindings and timelines write properties
           one driver per property
           timelines never write cells; they publish  x.playing · x.done · x.time
           machines never touch each other; they share cells
           outside code sees cells only
storage    a tree with stable ids — never strings
syntax     TypeScript expression subset as the text front end, lowered to the tree
scripts    Luau, in the player only, through Effect(script); never in rules
runtime    compiled bundle, integer slots, one evaluation graph; editor ≠ runtime
```

## 1. Document: one tree

- **One tree.** 2D and 3D nodes live in the same tree with a namespaced
  `kind`: `2d.frame`, `2d.path`, `3d.mesh`, `3d.light`, … Portals cross domains:
  `3d.scene` embeds 3D in 2D, `3d.surface` embeds 2D on a 3D face.
- **Freeze rule.** A node of a domain or capability the running edition does
  not own is kept byte-for-byte and drawn from its last baked image. Nothing
  is dropped, nothing is editable.
- **Capabilities are aspects.** Motion, behaviour, tokens, build are keyed by
  node id in side tables with core lifecycle hooks (create / delete / copy /
  rename), not fields on the node.
- **Packages.** `core / domain-2d / domain-3d / behaviour / motion / tokens /
  build`. An **edition** is a domain set × a capability tier. One binary;
  packages lazy-load by entitlement.
- **Shared `PropertyPath` registry.** Every animatable / bindable / tokenable
  property is declared once with its type. Bindings, transitions, timelines
  and tokens all key on it.
- **Prerequisite for 3D.** `scene3d.objects[]` / `cameras[]` become child
  nodes so the registry, bindings and timelines address them like anything
  else.

## 2. Component: four parts around the nodes

```ts
Component {
  nodes:        Node[]
  cells:        Cell[]
  bindings:     Map<PropertyPath, Binding>
  machine:      Machine            // per enum cell; a component may have several
  transitions:  Map<PropertyPath, Transition>
  timelines:    Map<TimelineId, Timeline>
}

Machine {
  cell:  CellId                                   // the current state IS this cell
  states: Record<Value, { while?: TimelineId; entry?: Action[]; exit?: Action[] }>
  transitions: Edge[]
}
Edge { from, to, on?: TriggerRef, when?: Expr, if?: Expr, do?: Action[], motion?: TimelineId[] }

Transition = { duration, easing } | { spring: { stiffness, damping } } | 'instant'
Timeline   = Clip { tracks: Map<PropertyPath, Keyframe[]>, loop? }
           | Sequence(ids) | Parallel(ids) | Stagger(ids, delay) | Blend(ids, weights)
```

**The rules (what makes it clean):**

| Rule | Consequence |
|---|---|
| Only the machine writes cells | no hidden writers; the page graph is complete |
| Only bindings and timelines write properties | a property's value is always explainable |
| One driver per property | literal **xor** binding **xor** keyframes; a transition may accompany a literal or binding, never keyframes |
| Timelines never write cells | they publish `x.playing`, `x.done`, `x.time`, which `when` may read |
| Machines never touch each other | two components interact only through shared cells |
| Outside code sees cells only | the app / host API is `get / set / fire`, nothing else |

**Four forms of motion**, all expressed with the parts above, none new:

1. **Property transition** — `transitions[button.scale] = spring(300, 20)`; the binding changes the target, the transition moves there.
2. **State motion** — `states.idle.while = breathe`; runs while the cell holds that value.
3. **Transition motion** — `edge.motion = [release, confetti]`; runs on the edge.
4. **Trigger motion** — an edge with `on` and no state change, `motion` only.

**Statechart mapping.** Compound state = a cell owned by a state (nested
machine). Orthogonal regions = independent cells. Internal transition = a
self-loop edge with `do` (there is no separate "handler" row).

**Derived, never stored.** `deps(binding)`, `readers(cell)`,
`look(state)` = bindings evaluated at that state value, the page graph
(component lanes, cell hubs, dashed links from `do` / `when` refs).

**Worked example.** Button (cells `state: idle|hover|pressed`, `count`) and
Drawer (cell `phase: closed|opening|open|closing`) share the page cell `open`.
Button's `pressed → hover` edge does `count = count + 1; open = !open` and
runs `release` + `confetti`. Drawer's `closed → opening` fires `when open ==
true`, `opening → open` `when slideIn.done`. Neither machine names the other.

## 3. Rive, for reference

Rive folds all of this into one state machine with layers, inputs and a view
model. Its inputs are deprecated in favour of data binding on the view model;
listeners, events and transition conditions are all defined on view-model
properties. Our cells are its view model made first-class, and our current
state is an explicit enum cell where Rive's is implicit.

## 4. Representation: a tree with ids

Strings are not storage. Every reference is by stable id so renames and
moves never break anything.

```ts
Ref   = Cell(id) | Item(node, path) | Playback(timeline, 'done'|'playing'|'time') | Store(store, path)
Expr  = Lit(value) | Ref | Op(op, Expr[]) | Cond(if, then, else) | Call(builtin, Expr[])
Binding = Direct(Ref) | Switch(on: Ref, cases: Map<Value, Expr>) | Range(from, to, Expr) | Formula(Expr)
Action  = Set(Ref, Expr) | Increment(Ref, Expr) | Toggle(Ref) | Fire(TriggerRef) | Effect(ScriptId)
Type    = number | string | boolean | color | enum(values) | list(Type) | object(fields) | trigger
```

The abstract grammar above is the spec. From it we derive the TS types, the
Rust enums, the JSON schema and, when needed, a concrete syntax. Typing rules
(`Γ ⊢ e : τ`) live beside it, not inside it.

**Validation pipeline:** lex → parse with recovery (holes) → resolve refs in
scope → typecheck → diagnostics. `eval` is acceptable as an *evaluator* after
this pipeline has accepted an expression; it is never the validator.

## 5. Text front end: TypeScript, not our own grammar

Only three places in the UI take free text: `when`, `if`, and the value of a
`do` action. Everything else is a picker (see §6). For those three:

- The user writes a **TypeScript expression**. The TypeScript language
  service supplies completion, hover types and errors.
- We generate a `.d.ts` from the scope: cells, `item`, `gesture`, playbacks,
  stores, all typed. `state`, `count`, `slideIn.done`, `gesture.dx` are typed
  identifiers.
- A **subset check** rejects statements, assignment, arbitrary calls, `this`,
  `new`, loops. Builtins are whitelisted (`Math.*`, list methods).
- What survives is **lowered to the tree**. TS is the front end only; the
  tree is storage; the runtime never sees TS.
- The TS worker (~10 MB) lazy-loads the first time a text field is focused.

**Pickers and text edit the same tree.** Toggling "formula" on a field prints
the tree as TS; toggling back parses it. If the text has no picker form the
field stays in formula mode; storage does not change shape.

This replaces the hand-written EBNF in [DSL.md](DSL.md) as the plan for the
authoring surface. DSL.md remains the sketch of a whole-page text projection.

## 6. The input fields of an interaction

An "interaction" in the UI is one edge of a machine.

| Field | Input | Free text? |
|---|---|---|
| from, to | state picker over the enum cell | no |
| on | node picker + trigger picker from the catalog | no |
| when (instead of on) | condition | yes, boolean |
| if | guard | yes, boolean |
| do | action picker + target cell picker (filtered by writability and type) + value | value only, typed to the cell |
| motion | timeline picker, multi | no |

States add `while` (timeline picker) and `entry` / `exit` (same shape as `do`).
Trigger payload fields (from the catalog) are in scope for `if` and `do`.

## 7. Scripting

- **Rules are never scripted.** Bindings, guards, `do`, `when` stay in the tree
  and codegen to Swift / Kotlin / TypeScript.
- **Scripts fill one slot**: `Effect(script)` →
  `Script { id, source, lang, reads: Ref[], writes: Ref[] }`. They run inside a
  player and are never translated.
- **Language: Luau.** Sandboxed by design, typed, known to Roblox and Rive
  users, and already supported on both sides we care about:
  - our Rust player via `mlua` (`luau` feature) on native;
  - Bevy via `bevy_mod_scripting` (Lua 5.1–5.4, LuaJIT, Luau, Rhai; Rune on
    hold). Bevy itself has no built-in scripting.
- **Web build caveat.** `mlua` binds the C Luau VM, which needs `setjmp`, so it
  builds for `wasm32-unknown-emscripten` only. Options: build the web player
  with emscripten (works today), or a pure-Rust Luau VM (`luaur`, unverified
  maturity; `piccolo` is pure Rust and sandboxed but plain Lua and
  experimental). Hide the VM behind one trait so the web VM can be swapped.
- **The script API is the outside API**, registered as one small library in
  every host: `get(cell)`, `set(cell, v)`, `fire(trigger)`, `playback(id)`,
  `tick(dt)`. In Bevy our runtime is a plugin and registers the same library;
  scripts never touch ECS or slots directly. One script runs unchanged in the
  web player, the native player and a Bevy game.

## 8. Runtime versus editor

The runtime is a **compiled bundle**, not the document:

- Integer slots for cells, properties and playbacks; names resolved at build.
- One evaluation graph: sources (cells, gestures, time) → derived (bindings,
  timelines, bones / skin as slots) → sinks (properties).
- Feature modules linked by need (no 3D in a 2D bundle, no Luau without
  scripts).
- A shared Rust semantics crate so editor preview, native player, wasm player
  and the Bevy plugin agree.
- API surface: `load / set / get / fire / tick / render`.

**Handover paths.** A: the player runs the bundle (any host, including Bevy).
B: codegen — a printer per target (React, SwiftUI, Compose) plus a builtin
mapping table and a small per-target helper lib. Both consume the same tree.

## 9. Engine changes this implies (in order)

1. Registry of `PropertyPath` with type / animatable / bindable / tokenable.
2. Refs by id and tree `Expr` replacing expression strings; `Switch` bindings.
3. `Machine` on an enum cell replacing the flat interactions list; `Edge`
   gains `when`, `motion`; states gain `while` / `entry` / `exit`.
4. `transitions` and `timelines` maps on the component; playback cells.
5. Input model catalog changes ([INPUT_MODEL.md](INPUT_MODEL.md) §6).
6. TS language-service front end for the three text fields.
7. Lift `scene3d.objects[]` / `cameras[]` into nodes.
8. `Effect(script)` + Luau in the player; Bevy plugin registering the same API.

## 10. Open questions

- Multiple machines per component: one per enum cell, or explicit list?
- Where a page-level machine lives (a page is a component?).
- Timeline retargeting across components (a `confetti` reused by many).
- Whether `Blend` needs weights as cells (probably yes; then a binding drives
  them).
- Web Luau: emscripten now, pure-Rust VM later, or no scripts on web v1?
