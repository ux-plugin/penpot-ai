# Foundation plan — what to build once so the rest can go in parallel

> Status: **PROPOSED 2026-09-21, not started.** Target model: [MODEL.md](MODEL.md).
> The foundation is the set of contracts every later stream keys on. After
> it lands, motion, machine, text front end, devices, 3D, player and codegen
> each own their own files and can proceed on separate branches.

## 0. Where the code is today (the facts the plan rests on)

| Area | State | Where |
|---|---|---|
| Interactions IR | v2: cells / refs / interactions / appRules; **expressions are strings** parsed at compile time | `src/lib/renderer/interactions/ir.ts`, `expression.ts` (`ExprNode` tree already exists, but is never stored) |
| Interaction storage | per page, `IndexedPage.interactions`; stores on `DocumentMeta.stores`; one change type `set-page-interactions` | `src/lib/worker/types.ts:94`, `src/lib/changes/page-interactions-change.ts` |
| Catalog | open-union registry keyed by string, `status: stable\|planned`, populated on import | `interactions/catalog/registry.ts` |
| Preview runtime | pure interpreter over cells + slot views; no time | `interactions/preview/runtime.ts` |
| Codegen | React emitter over a `PNode` tree; emits **no** motion | `interactions/compile/emit-react.ts` |
| Animation IR | `Timeline { bindings: Binding { target: { object, prop: string }, curve } }`, `Param`, typed-but-dead `Bone/Skin/StateMachine`; Rust mirror in `anim-runtime/` | `src/lib/renderer/anim/types.ts`, `anim-runtime/src/lib.rs` |
| Animation storage | **none**. Lives in preact signals (`motionShapes`), lost on reload; document keeps the rest pose only | `src/lib/renderer/motion/motion-store.ts:42` |
| Animatable props | 6 hard-coded names, mirrored by position in Rust (`PROPS`) | `motion/props.ts`, `motion/rust-runtime.ts:21`, `anim-runtime/src/session.rs:18` |
| Property vocabularies | three disjoint tables: `TokenProperties` (30, some synthetic), `SYNC_ATTRS` (~80, real keys, some shape-typed), `AnimatableProperty` (6, two are not node keys). No schema, no types on properties except tokens | `tokens/types.ts:147`, `component/sync-attrs.ts:26`, `motion/props.ts` |
| Property writes | one seam: `commitNodePartialUpdate` → `mod-obj assign` (merge, cannot delete keys) | `renderer/properties/commit-node-properties.ts:192` |
| Components | `LocalComponent { props: ComponentProp { targets: { nodeId, attr: string } } }`; copies are frames with `shapeRef`; no local variants | `src/lib/common/component.ts:25` |
| 3D | persisted on `node.scene3d` with `objects[]`, `cameras[]` inside; `bindable[]` declared per object, nothing reads it | `renderer/three/scene3d-store.ts:25` |
| Lifecycle bus | `onChangesApplied` subscribers, ordered centrally in `store/commit.ts:43` | `src/lib/changes/change-emitter.ts` |
| Springs, transitions, WAAPI/CSS emission, machine evaluator | do not exist | — |

## 1. The five foundation pieces

Each is one commit with tests. Existing tests stay green, Build mode and
Motion tab keep working through adapters. No panel is rewritten.

### F1 · Property schemas (zod) → descriptors

Schema first, one declaration. Identity is a descriptor id, never the label.
A shape type is a list of bundles; a bundle is a zod object whose fields
carry metadata.

```ts
// src/lib/renderer/properties/schemas/geometry.ts
export const Geometry = z.object({
  x:        z.number().meta({ label: 'X', unit: 'px', animatable: true, bindable: true, tokenable: ['dimension'] }),
  rotation: z.number().meta({ label: 'Rotation', unit: 'deg', animatable: true, bindable: true }),
})
export type Geometry = z.infer<typeof Geometry>

// src/lib/renderer/properties/registry.ts
registerBundle('geometry', Geometry)                       // descriptors 'geometry.x', … with get/set derived from the key
registerBundle('appearance', Appearance, { fill: fillAccessor })   // synthetic: custom get/set
registerShape('rect', ['base', 'geometry', 'appearance', 'radius'])
propertiesOf(shapeType) · resolve(shapeType, propId) → { def, get, set }
```

Steps:

1. `pnpm add zod`. New folder `src/lib/renderer/properties/` with `meta.ts`
   (the metadata type), `registry.ts`, `schemas/{base,geometry,appearance,
   radius,layout,text,modifier,scene3d}.ts`, `shapes.ts` (type → bundles).
2. Schemas cover only the drivable surface: today's `TokenProperties`,
   `SYNC_ATTRS`, `AnimatableProperty`, plus `modifier.scaleX/Y` (no `set`)
   and `scene3d.*` placeholders (no `set` until the lift).
3. Compile-time drift checks against the exporter types:
   `const _g: Geometry = {} as RectShape`.
4. Type-only changes: `anim.Target.prop`, `NodeRefs.props` keys,
   `ComponentPropTarget.attr` become `PropId` (branded). Fix the call sites
   the compiler finds with `propId()`.
5. Tests: every legacy name resolves; `resolve('rect','appearance.fill').set`
   writes `fills`; `modifier.scaleX` has no `set`; `propertiesOf('text')`
   includes `text.content`, `propertiesOf('rect')` does not.
6. Untouched: node objects, commit pipeline, panels, the three legacy tables
   (their owners migrate later).

Unblocks: motion (what can be keyed), machine/bindings (what can be bound),
tokens, codegen (type per path), 3D lift (declares its paths first).

### F2 · Tree expressions with ids

Storage stops being strings.

```ts
// src/lib/renderer/interactions/expr/
Ref  = { kind:'cell'; cell: CellId }
     | { kind:'item'; path: string[] }
     | { kind:'playback'; timeline: TimelineId; field:'done'|'playing'|'time' }
     | { kind:'store'; store: string; path: string[] }
     | { kind:'trigger'; path: string[] }              // payload of the current trigger
Expr = the existing ExprNode with `{ type:'ref'; name }` replaced by `{ type:'ref'; ref: Ref }`
```

- `PageInteractions` **version 3**: `Cell.formula`, `NodeRefs.props[*]`,
  `Interaction.if`, `Action.value`, `item.key` hold `Expr` trees. `upgrade(v2)`
  parses each string and resolves names to ids through `buildScope`.
- `print(expr, scope) → string` and `parse(text, scope) → Expr` are the
  adapters. `evaluate`, `toJs`, `freeRefs` already take `ExprNode`, so they
  change only at the `ref` case. The inspector keeps its text inputs by
  printing and parsing at the edge.
- Cells get a stable `CellId` distinct from their display name (rename is
  now free).

Unblocks: machine (edges hold `Expr`), TS front end (lowers into this),
bindings UI, codegen, the Rust player (same enum in `serde`).

### F3 · Behaviour block with the five maps

The component shape from MODEL.md §2, on the page first, on components
later, with persistence for motion.

```ts
// ir.ts v3
interface Behaviour {
  version: 3
  cells: Cell[]
  bindings: Map<NodeId, Map<PropertyPath, Binding>>   // today's refs, keyed
  machines: Machine[]                                 // one per enum cell; empty now
  rules: Edge[]                                       // today's interactions + appRules: edges with no from/to
  transitions: Map<NodeId, Map<PropertyPath, Transition>>   // empty now
  timelines: Map<TimelineId, Timeline>                // moved in from anim/types.ts
}
```

- `IndexedPage.interactions` becomes `IndexedPage.behaviour`; the change
  type is renamed with an upgrade in `flatten.ts`. One change type per map
  (`set-behaviour-cells`, `set-behaviour-timelines`, …) so two streams
  editing different maps never produce the same undo frame kind.
- `motion-store` reads and writes `behaviour.timelines` instead of its
  signals. This is the one behaviour change in the foundation: **motion is
  persisted**. Playback and the Rust seam are untouched.
- `Machine`, `Edge`, `Transition` types are declared with no evaluator. A
  `rules` edge with `on` + `do` is exactly today's interaction; the preview
  runtime runs those and ignores `machines` until the machine stream lands.

Unblocks: motion and machine streams write disjoint maps; the State section
UI; codegen reads one block.

### F4 · Evaluation contract

One interface everything that executes behaviour implements.

```ts
// src/lib/renderer/interactions/host.ts
interface BehaviourHost {
  load(b: Behaviour, nodes: NodeTable): void
  get(ref: Ref): unknown
  set(ref: Ref, value: unknown): void
  fire(node: NodeId, trigger: TriggerType, payload?: Json): void
  tick(dt: number): Frame                 // property writes for this frame, by node and path
  playback(id: TimelineId): { playing; done; time }
}
```

- The preview runtime and the `PlaybackController` are wrapped as one
  `TsHost`. Its tests become the conformance suite. A `RustHost` and the
  Bevy plugin implement the same interface later and run the same suite.
- `Frame` uses `PropertyPath` from F1 and replaces the positional `PROPS`
  buffer contract between TS and Rust with a path table sent at `load`.

Unblocks: the Rust player, the Luau slot (its library is exactly this
interface), codegen parity tests.

### F5 · Aspect hooks on node lifecycle

Side tables keyed by node id, told when nodes change.

```ts
// src/lib/renderer/aspects/registry.ts
interface Aspect {
  key: string
  onDeleted(nodeIds: NodeId[], page: PageId): Change[]
  onCopied(map: Map<NodeId, NodeId>, page: PageId): Change[]
  onRenamed?(nodeId, from, to): Change[]
}
registerAspect(a)   // driven from the existing onChangesApplied bus, ordered in store/commit.ts
```

- Behaviour (bindings, edges, timelines by node id) and `scene3d` register
  first. Today deletion leaves dangling references that `reconcile` reports
  after the fact; with F5 the fix-up is part of the same frame.

Unblocks: every stream that keys data by node id without touching the
shape type.

## 2. Order and dependencies

```
F1 registry ──┬──► F3 behaviour block ──► F4 host
F2 tree expr ─┘            │
F5 aspects (independent) ◄─┘ (behaviour registers as an aspect)
```

F1 and F2 and F5 have no dependency on each other and can be built in
parallel. F3 needs F1 and F2. F4 needs F3. Roughly two weeks of one person,
or one week of three.

## 3. Streams that open after the foundation

| Stream | Owns | Needs | Touches nothing in |
|---|---|---|---|
| **Motion** | `Transition` (easing, spring), `Clip/Sequence/Parallel/Stagger/Blend`, playback cells, Rust evaluator, Timeline panel | F1 F3 F4 | machines, expr, catalog |
| **Machine** | `Machine` evaluator on an enum cell, `Edge.when/motion`, `while/entry/exit`, state-graph panel | F2 F3 F4 | timelines internals, registry |
| **Text front end** | TS language service worker, `.d.ts` from scope, subset check, lower to `Expr`, formula toggle | F2 | everything else |
| **Devices & input** | catalog platform tags, payload scope, built-in stores, `when` trigger, gesture scoping, `Device` | F2 F3 | motion, machine evaluator |
| **3D lift** | `scene3d.objects[]`/`cameras[]` → child nodes, `3d.*` kinds, registry entries go `stable` | F1 F5 | behaviour |
| **Player** | Rust `BehaviourHost`, bundle with slots, Luau via `Effect(script)`, Bevy plugin | F4 | editor UI |
| **Codegen** | motion and machine printers in `emit-react`, SwiftUI/Compose printers | F3 F4 | editor UI |

Two streams collide only where the table says they share a foundation
piece, and there they share an interface, not a file.

## 4. Decisions needed before starting

1. **Branch.** Build on `claude/cells-ir` (three unpushed commits on top of
   `integrate/2026-09-18`), or merge that first and start a fresh branch off
   `develop`.
2. **3D scope in F1.** Register the 3D paths as `planned` placeholders now
   (cheap, no lift required), or leave 3D out of the registry until the lift
   stream. Recommendation: placeholders, so the lift stream has its target.
3. **Persist motion in F3, or leave it in signals** until the motion stream.
   Recommendation: persist in F3. It is the change that lets the motion
   stream start from a saved document.
