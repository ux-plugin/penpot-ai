# Animation model & format strategy

Status: **design locked** (2026-07-04). This is the direction the motion/animation work
builds toward. It sits above the shipped motion code (`src/lib/renderer/motion/*`).

## Thesis

Build our **own** animation engine, runtime, and **format**. Our internal model (the IR)
*is* our format; we document and open-source it. We do **not** standardize on Rive or
Lottie. This keeps our design-first model (tokens, components, layout), clean code-export,
full Skia fidelity, and full independence. The "years to build Rive" is really the mesh
*tooling* polish — we already own the expensive shell (vector surface, hierarchy, timeline,
FK via transform inheritance).

## The unified IR — a layered superset

Key insight: **a keyframe track and a parameter binding are the same primitive** — a curve
sampled over a *domain*. Lottie's domain is time; INP's is a parameter; Rive uses both. So
the model factors into orthogonal layers, and each existing format is just a *subset* of switches:

| Layer | What | Sources |
|---|---|---|
| 1. Scene graph | nodes: transform · path · mesh · fill · text | all |
| 2. Deformers (pluggable per node) | affine · path-keyframe · **bone-skin (LBS)** · **param-blendshape** | Lottie / Rive / INP |
| 3. Drivers | a sampled **curve over a domain**: time → "keyframe track", param/input → "param binding" | all |
| 4. Logic (optional) | state machine + blend states (1D/2D/direct) selecting/mixing drivers | Rive / dotLottie |
| 5. Generators | repeater (parametric duplication), per-character text animators | Lottie |
| 6. Effects + driver composition | blur/shadow/tint/blend-modes stack; **time-remap = a curve feeding another driver's domain** | Lottie |
| 7. Physics (optional) | spring/pendulum nodes producing driver values | Rive / INP |

Each format projects onto this:
- **Lottie** = graph + {affine, path} deformers + *time* drivers + generators + effects.
- **`.riv`** = graph + {affine, bone-skin} deformers + *time+input* drivers + state machine + physics.
- **INP** = graph + {param-blendshape} deformer + *parameter* drivers + physics.

## Why no single format is a superset (capability families are orthogonal)

- **Rive** owns skeleton + FK + bone-skin + IK + constraints + real state machine. Neither of the others has these.
- **Lottie** owns *generators* — repeaters, per-char text animators, time-remap, AE effects. A static keyframe/rig graph can't do these without baking (they *produce/parameterize* structure).
- **INP** owns *free-form param blendshape* deform — arbitrary per-vertex offset fields. Bone-skinning can't span this without degeneracy (candy-wrapper collapse).

So: everything-in-Lottie is **not** possible in the Rive model (missing generators); everything-in-INP is **not** possible in the Rive model (blendshape ≠ bone-skin — Rive can do the param *driving* via Number-input + BlendState1D, but not the free-form *deformer*). Our model = **Rive base + INP blendshape deformer + Lottie generators/effects/composition** = all three families under one roof.

## Format interop

- **Lottie** — the one real open standard (v1.0 standardized 2025, Linux Foundation; deliberately baked-vector, no rigging on roadmap). **First-class import + export** for the baked/simple tier. Skottie (BSD, already in our Skia) can play it. Export native motion → Lottie for ubiquity (~60KB, runs everywhere).
- **`.riv`** — documented but vendor-controlled with **breaking major versions** (format 7 hard-errors on 6) and a closed editor. Import by **transcoding `.riv` → our IR → play with our runtime** (not embedding rive-runtime), so imported content is native/editable/tokenizable/code-exportable, one renderer, independent. The transcoder is the quarantine adapter — if Rive breaks the format, only the importer patches.
  - Fidelity is our burden, scaling with our runtime's feature coverage. **Coverage-gated**: simple `.riv` transcodes trivially/faithfully now; rig/interactive matures with the editor. Unsupported features → warn + partial import, or an **optional embed-rive-runtime fallback** so nothing fails to play. Add a **frame-diff regression harness** (Rive vs ours) to catch semantic drift.
  - **No `.riv` export** as a foundation (taxed/optional only).
- **INP** (Inochi2D) — open (BSD-2) but niche/pre-1.0, param-blendshape paradigm. Import when we adopt the blendshape deformer.
- No open standard exists for rigged animation, and none is on any roadmap — owning our rig format is the sane choice.

## Runtime, language & platforms (all-platforms target)

**Editor ≠ Runtime.** The editor authors; the runtime plays inside the user's shipped product.

- **Editor** (UI, tools, gizmos, timeline, weight-paint, interop importers) = **TypeScript/React**, web + desktop, authoring only — never ships to a device.
- **Runtime** (evaluators: timeline, FK, IK, state machine, skinning, physics, blendshape) = **Rust**, because a TS runtime can't ship native. **ONE Rust codebase** → **wasm32** (web + the editor's live preview) + **native via C FFI** (iOS/Android/Flutter/desktop/Unity). Same runtime everywhere → zero drift. This is the Rive pattern (portable runtime + web/desktop editor), Rust colocated with `render-wasm`.
- **Renderer** = **Skia** everywhere (CanvasKit/render-wasm on web, native Skia on device).
- **Format** = the serialized IR — the contract crossing every boundary. Canonical in Rust (serde) + mirrored TS types. Interop mappers convert foreign formats → our IR **at authoring time** (TS), so the runtime only ever reads *our* format.
- **Simple motion** (transform/opacity) can also **code-gen** to CSS / Web Animations (and native animation APIs) — no runtime needed for the baked tier.
- Skia is the one 2D renderer; 3D stays a three.js overlay (Skia can't do 3D — projection + depth + lighting; `ozz` is 3D and redundant with three.js). Motion animates only compositor-safe props (never reflow; browser hit-tests the transformed geometry — what our modifier-aware-grab should match).

| Layer | Language | Ships to |
|---|---|---|
| Editor UI, tools, timeline, weight-paint, gizmos | TS/React | web + desktop (authoring) |
| Interop mappers (Lottie/`.riv`/INP → our IR) | TS | editor only |
| **Runtime evaluators** | **Rust** | **all platforms** (wasm + native) |
| BBW auto-weights | C++ (libigl) → wasm/native | authoring |
| Renderer | Skia (C++) | all platforms |
| Format | Rust (serde) + mirrored TS | the contract |

Today's TS `anim/` IR + sampler = **prototype + behavior spec**: validate the model fast and drive the editor now; **port each evaluator to Rust as it stabilizes** (tests become the Rust conformance suite).

## Rig-tier library map

| Piece | Source |
|---|---|
| Mesh triangulation | earcut/earcutr, Triangle, spade |
| **Auto bone-weights** (the one research-hard part) | **Bounded Biharmonic Weights (BBW) in libigl** — authoring-time, avoid the MOSEK QP dep |
| LBS deform runtime | trivial (~a page) |
| IK | TheComet/ik (C89) or ~40 lines Rust |
| Physics | Box2D v3 / Chipmunk2D (C, MIT) or Rapier2D (Rust) |
| State machine + rig constraints | **no library anywhere — build in-house** (rive-runtime = MIT reference) |
| Weight-painting UX | ours |

(Spine's runtimes are license-blocked; DragonBones is open but dead; rive-runtime is a *player*, not an authoring library.)

## Phased build

1. **Cutout skeletal rig** — bones = transform nodes reusing our motion sampler; FK = transform inheritance; + IK; + state machine on our interactions graph. **No mesh** — mostly what we already have. A real, shippable rig editor.
2. **Mesh skinning** — triangulate + BBW weights + trivial LBS + weight-paint brush UI. The deferrable hard tier.
3. **Physics** — whenever.

## Scope — V0 vs complete product

**V0 — prove the model + the cross-platform runtime path, minimally; web-only.**
- Features: the Rive-base **simple tier** — unified **timeline (time-domain) + parameter (param-domain) drivers** on the scene graph (transform/opacity) + **minimal cutout bones/FK** (reuse transform inheritance). NO mesh/skinning, blendshape, generators, effects, physics, or state machine.
- Runtime: a **thin Rust→WASM core** (IR + curve sampler + timeline evaluator) driving the existing Skia canvas + TS editor. De-risks the whole all-platforms thesis with the least code (vs building a large TS engine we'd later port).
- Platforms: **web only**. Native wrappers deferred.
- Interop: none (optionally a tiny Lottie-subset import to validate the IR against a real format).
- Editor: reuse the shipped timeline/motion UI + add parameter authoring. No mesh/weight/state-machine editors.
- Format: define IR serialization **v0** (the contract), even minimal.
- Done = one shape, keyframed **and** param-driven, playing through the Rust-WASM runtime on the real canvas, authored in-editor. Proves model + runtime + render + editor on the exact stack that extends to native.

**Complete product.**
- Full IR: all 4 deformers (affine/path/**bone-skin**/**blendshape**) + state machine + blend spaces + generators (repeater/text-animators) + effects + driver composition + physics.
- Runtime: Rust on **all platforms** (wasm + iOS/Android/Flutter/desktop native), Skia everywhere.
- Interop: Lottie import/export, `.riv` transcode import (+ embed fallback + frame-diff harness), INP import.
- Editor: bone tool, mesh editor + BBW weight-paint, state-machine graph editor, full timeline, param panels, gizmos.
- Export: code-gen (CSS/Web-Animations + native) + our documented open format.
- Libraries: Rapier2D/Box2D (physics), earcut (triangulation), **libigl/BBW** (weights), Skia/Skottie (render/Lottie), rive-runtime (ref/fallback/harness), inox2d (INP).

## Standard strategy

Own a documented open format/runtime (cheap; seeds adoption). Be the **superset hub** that
imports/exports both Lottie and Rive so users never choose. Don't do standards-body /
governance / evangelism or try to displace incumbents. Standards follow tools — if the tool
wins, our format becomes a de-facto standard as an outcome (like Lottie did, tool-first).


## Progress

- **2026-07-04 — IR ground floor.** New module `src/lib/renderer/anim/` (separate from the
  shipped narrow `motion/` slice). `types.ts` = the Rive-base object model (Curve/Key/Domain,
  Param, Target/ObjectRef, Binding, Timeline, plus Bone/Skin and StateMachine typed for later
  layers). `sample.ts` = the atom: `sampleCurve(curve, x)` over a domain, `resolveInterp`
  (linear/hold/preset/explicit cubic-bezier w/ Newton+bisection solver), `domainValue`,
  `sampleBinding` against an `EvalContext {time, params}`. This is the unification made real:
  a time-domain curve and a param-domain curve sample through the exact same path. 13 tests,
  lint + tsc clean. Next up (Rive base, bottom-up): timeline evaluator (bindings -> node
  property writes) -> bones + FK -> IK -> state machine/blend evaluation -> then INP blendshape
  deformer + Lottie generators.
- **2026-07-05 — A1 + A2: one model, one interpolation path.** Built the timeline evaluator
  (`anim/evaluate.ts`: `evaluateTimeline` → `Map<nodeId, props>` via a general `Write[]`
  intermediate; per-timeline loop/clamp owned here) and the IR edit primitives (`anim/edit.ts`:
  set/remove/move/find key on a `Timeline`). Replaced the shipped `Clip` model wholesale: the
  store now holds `ShapeMotion[]` (one IR `Timeline` per shape + rest metadata); playback runs
  through `evaluateTimeline` (deleted `motion/sampler.ts` + `easing.ts` — one bezier/lerp path
  now, in `anim/sample`); delta/rest authoring re-expressed on the IR in `motion/edit.ts`; the
  four shape-coupled UIs rewired to Binding/Curve. Kept the render seam + clock (`modifier.ts`,
  `wasm-sink.ts`, `playback-controller.ts`). Store is param-ready (`EvalContext.params` +
  a `motionParams` signal + controller params provider), so A3 (parameters) is next. 451 tests
  green (incl. 36 new anim tests), tsc + eslint clean.
- **2026-07-05 — A3: parameters (param-domain driving).** Made param-domain bindings authorable
  and live-drivable — the parameter half of the unified driver model. `anim/edit`'s key primitives
  now key on (target, domain), so time and param curves for one property coexist independently
  (domain defaults to time, keeping the keyframe path terse). `motion/edit` gained `setParamKeyframe`
  (delta 0 at the param's min, full delta at its max); `rebaseToRest` skips param bindings. The store
  holds `motionParamDefs` + CRUD (`addNumberParam`/`setParamValue`/`removeParam`) and
  `bindPropertyToParam`; `setParamValue` re-seeks the current frame so sliding a parameter drives the
  shape live on the canvas through the same evaluate→sink path as playback. New `ParametersPanel`
  (add/slide/delete params + bind a property → param) mounts in the Motion tab; the timeline ruler
  filters to time-domain bindings. 459 tests green (incl. a store→evaluator integration test proving
  a bound property is param-driven), tsc + eslint clean. V0 acceptance now met on the TS runtime path:
  one shape, keyframed AND param-driven, evaluated through the runtime → Skia. Remaining for V0: LOCK
  the simple-tier model + IR serialization v0, then port types+sample+evaluate to a Rust→WASM runtime.

## Known issues (deferred to a correctness pass)

- **Rotation motion is visually off.** Translation is correct; rotated motion doesn't look right yet —
  likely pivot/compose in `modifier.ts` or render-wasm's rotation handling (render-wasm bakes path
  rotation and ignores the rotation field; see the `project_path_rotation_box` memory). Functional but
  not correct. Deferred.
- **Selection hit is lost when a shape is displaced.** The pointer hit-test runs against the document
  (rest) geometry, so once a motion/param offsets a shape you can't click it at its visual position —
  the "modifier-aware grab" gap. The selection *box* follows on scrub/param-drive (`refreshSelectionRect`),
  but the *hit region* (and the box during continuous play) does not. Pre-existing, not from the A1/A2
  refactor. Deferred.
- **2026-07-06 — Format contract v0 (model locked).** Defined the IR serialization contract:
  `anim/serialize.ts` — a versioned envelope `{ version, doc: AnimDoc }` with `serializeAnimDoc` /
  `deserializeAnimDoc` (validates JSON, version, and the doc shape so the runtime only sees a well-formed
  doc) + `buildAnimDoc(timelines, params)`. The contract is the pure runtime IR (params + timelines);
  authoring-only rest metadata is excluded. The store exposes `currentAnimDoc()` / `serializeMotion()` —
  the exact bytes the Rust runtime's serde will mirror. `ANIM_FORMAT_VERSION = 0` (simple tier). 467
  tests green. Next: port the locked core (types + sample + evaluate) to a Rust→WASM runtime whose serde
  mirrors this envelope, with the TS tests as the conformance suite, then wire the controller to call it.
- **2026-07-07 — R1: Rust runtime core (cross-platform proof).** New crate
  `skia-rs-wasm/anim-runtime/` (pure Rust + serde) ports `anim/types` + `sample` + `evaluate` +
  `serialize`: the IR serde-mapped to the exact JSON contract (untagged `Interp`, `tag="kind"`
  enums, `loop` field), `sample_curve` + `cubic_bezier` (Newton+bisection) + `sample_binding`,
  `normalize_time` + `evaluate_timeline → HashMap<nodeId, props>`, and `serialize`/`deserialize`
  with the version gate (serde typing = structural validation). 10 `cargo test` vectors mirror the
  TS suite, incl. `deserializes_the_ts_contract` — parses the exact bytes `serialize.ts` emits and
  evaluates to identical values, proving cross-language parity. `cargo test --offline` green; the TS
  build is unaffected (crate isolated, `target/` gitignored). This proves the model + core port
  identically — the heart of the all-platforms thesis. Remaining for V0: R2 (the `wasm-bindgen`
  boundary — `load_doc(bytes)` + `eval(time, params) → flat out-buffer`) and R3 (wire the controller
  behind a flag, TS engine as fallback). Both need `wasm32-unknown-unknown`+`wasm-bindgen` or the
  render-wasm emscripten/Docker pipeline, absent in this environment — scaffolded (see the crate
  README), built where the toolchain is available.
- **2026-07-07 — R2 + R3: the Rust→WASM runtime, built and wired (V0 runtime path complete).** No
  wasm-bindgen — folded into render-wasm's existing emscripten pipeline. **Rust:** a host-tested
  `Session` (`anim-runtime/src/session.rs`) owns the doc + node order + live params + a **pre-allocated
  frame buffer** (node-major, 6 prop slots, `NaN` = no change) filled in place each frame — so eval never
  allocates and never grows wasm memory (the HEAPF32-detach discipline). `render-wasm/src/anim.rs` is a
  thin FFI (`anim_alloc`/`anim_load_doc`/`anim_set_param`/`anim_eval`) over `Session`, with
  `anim-runtime` a path dep of the render crate. **TS:** `motion/rust-runtime.ts` feature-detects the FFI
  (`getWasmModule()`), loads the doc via `_alloc_bytes`+`HEAPU8`, sets params event-driven, and reads the
  frame buffer via a **fresh `HEAPF32` each frame**; node order is derived with the same first-appearance
  rule as the Session so no id table crosses the boundary. `PlaybackController` gained an `evaluateFrame`
  seam (Rust when present, TS engine as automatic fallback); the store loads/sets-param on edits.
  **Verified:** `cargo test` (14, incl. cross-language parity + stable-buffer-pointer); `pnpm build:wasm`
  **succeeds** and the built `render-wasm.{js,wasm}` **export all four `anim_*` functions** (confirmed in
  both glue and binary); tsc + eslint + 91 TS tests green (Rust path inert without the module). The built
  wasm **loads and executes** in the browser. The only unverified step is the final on-canvas render —
  the headless preview can't create a Skia GL surface (`render/surfaces.rs`, a WebGL/GPU limitation, not
  the anim code); it runs on a real GPU browser. **V0 acceptance met at every layer that isn't
  headless-GPU-blocked: one shape, keyframed + param-driven, evaluated through the Rust-WASM runtime.**
