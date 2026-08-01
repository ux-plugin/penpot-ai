# Vello as a peer rendering backend — decisions & plan

Status: **Phase 0 done, Phase 1 in progress.** Architecture: **two standalone wasm modules, one chosen at runtime.**

This supersedes the earlier "Option A, focus-mode first" framing. See [Decision log](#decision-log) for what changed and why.

---

## Where things live

Committed on `develop` as `109b8d95fe` — *feat(render-wasm): backend-neutral render-core + Vello backend groundwork* — with the `vello` submodule pinned at `39f16bd9`, *feat(sparse_strips): user-authored WGSL filters + Penpot backend evaluation*.

Note: the main worktree has since moved off `develop` onto `wip/tree-snapshot-2026-07-25`. `develop` itself still points at `109b8d95fe`, and the four commits on that wip branch do not touch the Vello track.

| Thing | Path | Notes |
|---|---|---|
| Neutral shared crate | `render-core/` | kurbo + peniko + the node/scene model. Owned by neither backend |
| Skia backend | `render-wasm/` | cargo package `render`, bin `render_wasm` |
| Skia↔neutral boundary | `render-wasm/src/core_convert.rs` | free fns, affine-only |
| Shape → neutral projection | `render-wasm/src/model_export.rs` | **transitional** — unnecessary in the end state |
| Vello backend | `render-vello/` | was `focus_embed` inside the submodule; see D15 |
| Vello fork | `vello/` (submodule → `ux-plugin/vello.git`) | branch `custom-wgsl-filter`; carries **only** the engine change |
| This plan | `docs/render/vello-backend-plan.md` | spans all three crates, so it is not render-wasm's |

The `vello-spike` worktree at `../penpot-ai-vello-spike` is now empty of vello work and can be removed.

Both trees are clean: the main repo and the `vello` submodule carry no uncommitted work.

---

## Decision log

### D1 — Vello is worth adopting
It beats Skia on the case Skia handles poorly: many stacked effects, zoomed in, animated. Proven in-browser on WebGPU with a working user-authored WGSL filter.

### D2 — Two wasm modules, exactly one loaded at runtime
One binary **cannot** be both targets:
- render-wasm must build for `wasm32-unknown-emscripten` — the Skia binaries it links are prebuilt only for that target. Skia pins the module to Emscripten.
- `wgpu`'s browser backend is built on `web-sys`, which is wasm-bindgen-generated and only works on `wasm32-unknown-unknown` plus the wasm-bindgen post-processing step.

So: two artifacts, and the host **downloads exactly one**. Because only one is ever loaded, this eliminates the concerns that killed earlier designs — no runtime memory duplication, no cross-module projection, no second serialization target, no dual-canvas plumbing.

The single-binary alternative (wgpu's GLES backend over Emscripten's GL via `glow`) stays deferred: unproven, WebGL2-level only, and it reopens the shared-GL-context sampler-leak risk.

### D3 — The Vello module is a standalone peer, not a focus-mode add-on
`render-vello` is a **full replacement** for `render-wasm`, not a side canvas for shader focus mode. Consequences:
- `model_export.rs` (render-wasm re-deriving a neutral model for another module) is **the wrong direction** in the end state and becomes unnecessary.
- Both modules are fed directly by the host with the same document.

**`model_export` dies via D4, not via D6/A.** It disappears the moment the host projects directly to `render-vello` (Phase 2), because then nobody asks render-wasm to re-derive a neutral scene. That is independent of whether render-wasm ever adopts the core's types internally. The original wording implied D3 required approach A; it does not, and D16 explains why that distinction matters.

### D4 — `skia-rs-wasm` is the host and owns the document
Not CLJS. `skia-rs-wasm` holds the document model (`IndexedShape`/`IndexedPage`), resolves geometry in TS (`renderer/geom/`: vector-network-faces, planarize, fillet, path-arc, subpaths, matrix), and already drives render-wasm via `node-factory`/`wasm-module`. Projection to a renderer originates **there**, which is what makes the two modules peers.

Exception: **text**. Skia's paragraph layout lives inside render-wasm, not in the host.

### D5 — Shared Rust crate: `render-core`
Backend-neutral, `#![forbid(unsafe_code)]`, compiled into both artifacts with only one shipping per session. It re-exports kurbo and peniko (D12) and adds `model` — `ShapeKind`, `Node`, `Scene`, i.e. only the part that is genuinely Penpot's. Builds for `wasm32-unknown-emscripten` and `wasm32-unknown-unknown`; 3 tests. It lives at the repo root as a sibling of both backends (D15).

*Original wording, now superseded:* this decision first specified "zero dependencies" and a hand-written `geom` module of f32 atoms mirroring `SkMatrix` element order and Skia's precision, explicitly so that approach A would be "a type-swap, not a behavior change." D12 replaced those atoms with kurbo, which is f64. That was the right call for the handoff and for the Vello backend, but it is precisely what changed A's cost — see D16.

### D6 — Approach B for the model boundary
For the model boundary we chose **B: neutral model + convert at the handoff**, over **A: swap Skia types in place**. A is one indivisible ~260-site change because the four geom atoms (`Matrix`, `Point`, `Rect`, `Color`) are type-coupled.

B unblocks Vello without touching the shipping Skia engine, and it is reversible.

**Amended by D16.** This decision originally read "approach B now, approach A as the destination," on the reasoning that D3's end state wants the core to *be* the model. Two things falsify that as written:
1. D3's consequence — `model_export` disappearing — follows from D4 (the host projects to both peers), not from A. See the note in D3.
2. D12 made A materially more expensive by making the core f64, against a Skia that is f32 by construction.

So A is no longer the assumed destination. It is one option, gated on conditions D16 states. Phase 7 stays "converge or hold" and is now genuinely open rather than leaning.

### D7 — One ABI contract, two adapters
Both modules expose the same logical surface so the host can load either interchangeably. The interop differs (Emscripten `Module._fn` vs wasm-bindgen), so each gets a thin TS adapter behind one `Renderer` interface in `skia-rs-wasm`.

### D8 — Animator: Rive's model, not full rebuild
Dependency-ordered dirty propagation (`m_DependencyOrder`, `graphOrder`, `m_DirtDepth`, `ComponentDirt` flags) rather than re-encoding the scene each frame. Rive also ring-buffers its GPU allocators.

### D9 — Present-to-present cadence is the fps standard
See [Measurement](#measurement-methodology). Encode-throughput and GPU-fence timing both mislead.

### D10 — Custom effects → WGSL via `FilterPrimitive::Custom`
The fork's mechanism works end to end. The SkSL RuntimeEffects (glass refraction/displacement/composite, noise, texture, diamond/angular gradients) port to WGSL through it.

### D11 — Text → Parley
The single largest sub-project. Skia `textlayout` Paragraph → Parley layout/shaping feeding Vello glyph runs.

Downgraded from research to integration by D14: Graphite and Blitz both ship the parley + fontique + skrifa path against Vello today, and Bevy and Gosub have adopted Parley too.

### D12 — Geometry and paint atoms come from kurbo + peniko, not from us
`render-core/src/geom.rs` **is** kurbo. `model.rs`'s `Color`, `Fill`, `Path`, `PathSeg` **are** peniko plus `kurbo::BezPath`. Both crates are pure Rust and `no_std`-capable (allocator required), and neither pins a wasm target — which was the entire reason we hand-rolled in the first place.

kurbo also already ships most of what Phase 1 was going to write by hand: `stroke()` / `stroke_with()` (stroke expansion), `dash()`, `flatten()`, the `offset` module, `fit_to_bezpath`. peniko covers `Brush`, `Gradient`, `Image`, `BlendMode`, `Compose`, fill rule and `Style`; `color` covers CSS Color 4.

This supersedes D5's "zero dependencies" — the dependency is the point.

**Known gap:** kurbo has no boolean path operations ([linebender/kurbo#277](https://github.com/linebender/kurbo/issues/277)). Graphite's standalone `path-bool` is the option when bool shapes need to render.

**Gate: cleared.** `kurbo 0.13.1` + `peniko 0.6.1` (the vello fork's own pins, so both artifacts link one kurbo) build for **`wasm32-unknown-emscripten`** and **`wasm32-unknown-unknown`**, with render-core's tests green natively. Six transitive crates, all pure Rust: `arrayvec`, `polycool`, `smallvec`, `color`, `linebender_resource_handle`.

**Cost this incurs elsewhere, stated plainly:** kurbo is f64 and Skia is f32. That is free for the handoff and for the Vello backend, and it is the reason approach A got more expensive. D16 has the analysis; D5 records what was given up.

Worth noting for anyone repeating this: there is no emscripten SDK on the dev machine — render-wasm builds inside `docker/devenv`, and `render-wasm/build` sources `/opt/emsdk/emsdk_env.sh`, which does not exist locally. The check still works natively because an **rlib** build invokes no linker, so `cargo build --lib --target wasm32-unknown-emscripten` needs no `emcc`. Linking the full render-wasm cdylib still does.

### D13 — Backend-abstraction crates are a reference, not a dependency
Two crates already solve "one drawing API, several 2D backends":

- **`anyrender`** (Dioxus, for Blitz) — `PaintScene` + `WindowRenderer` + `ImageRenderer`, kurbo/peniko-typed, with `anyrender_vello`, `_vello_hybrid`, `_vello_cpu` and `_skia` backends.
- **`imaging`** (forest-rs) — adopted by Masonry in [xilem#1696](https://github.com/linebender/xilem/pull/1696), replacing its hardcoded Vello classic. `PaintSink` streams borrowed `*Ref<'_>` commands; `record::Scene` retains an owned stream for validation and replay. Backends: `imaging_skia` (skia-safe 0.97), `imaging_vello`, `_vello_cpu`, `_vello_hybrid`, `_tiny_skia`. Plus `imaging_conformance`, `imaging_snapshot_tests`, `imaging_wind_tunnel`, `svg_imaging`, `velato_imaging`.

We take the **shape**, not the crate, for two reasons:
1. Both solve *one binary, many backends*. Our split is two separately-compiled wasm artifacts for different targets (D2) with the switch in TypeScript (D7). A Rust trait cannot span them.
2. `FilterPrimitive::Custom` carrying user-authored WGSL (D10) cannot be expressed in a backend-neutral sink — Skia cannot run WGSL. Our differentiator is inherently per-backend.

Prefer `imaging`'s `PaintSink` shape over `anyrender`'s `PaintScene`: its explicit **streaming vs retained** split maps onto the caching plan (D8) directly — the retained form is the subtree-replay hook, the streaming form is the per-frame path. `anyrender` has one `Scene` and does not make the distinction.

`imaging_conformance` is a candidate for Phase 2's visual diff: it already targets skia-safe against vello_hybrid, our exact pair. Note render-wasm pins skia-safe 0.93.1 while `imaging_skia` uses 0.97.0.

### D14 — Reuse the Linebender stack wherever it already exists
See [Ecosystem survey](#ecosystem-survey). The short version: the filter graph, blur, drop shadow and atlas in `vello_common` are **upstream**, not ours — our fork commit adds only `FilterPrimitive::Custom`, the evaluation scenes and the embeddable renderer that is now `render-vello` (D15). Text is parley + fontique + glifo. Lottie is velato + interpoli. SVG is vello_svg.

### D15 — Three sibling crates; the submodule depends on nothing outside itself
`render-core/`, `render-wasm/` and `render-vello/` sit side by side at the repo root, and both backends depend on the core.

Previously the Vello module lived *inside* the submodule as `vello/sparse_strips/vello_hybrid/examples/focus_embed`, with `render-core = { path = "../../../../../render-wasm/render-core" }` — a child repository declaring a dependency on a path in its superproject. Because `focus_embed` was also a workspace member, a bare `cargo metadata` at the fork root needed a file from Penpot: **the fork could not be built standalone**, and every upstream rebase dragged a foreign dependency along.

Now the direction is parent → child throughout. `render-vello` depends into `vello/`; the fork carries only `FilterPrimitive::Custom` (an upstreamable engine change) plus the evaluation scenes, which stay because they are written against vello's own `ExampleScene`/`RenderingContext` harness.

**No shared cargo workspace, deliberately.** Under D2 the two backends never link together — two binaries, exactly one ships — so a unified lockfile buys nothing. `render-vello`'s kurbo/peniko are pinned automatically because `vello_hybrid` is in its graph; `render-core` only has to declare compatible versions. A workspace at the repo root would also make cargo treat this polyglot monorepo as a Rust workspace.

**The cost, recorded so it is not rediscovered:** leaving vello's workspace turned every `workspace = true` in `render-vello/Cargo.toml` into a hand-pinned version — wgpu, web-sys, wasm-bindgen and the rest. They must be re-checked against `vello/Cargo.toml`'s `[workspace.dependencies]` whenever the submodule is bumped; two incompatible wgpu copies in one graph fail confusingly.

**Known naming wart:** `render-wasm` vs `render-vello` reads as though only one targets wasm. Both do; the honest pair is `render-skia`/`render-vello`. Renaming touches `render-wasm/build`, the docker devenv, `skia-rs-wasm`'s `build:wasm` and the artifact name, so it is deferred rather than decided against. The same applies to `FocusRenderer`/`create_focus_renderer` in `render-vello`, which are leftovers from the superseded focus-mode framing (D3).

### D16 — The f32/f64 boundary; approach A is gated, not destined
The facts, all verified in source rather than assumed:

- **Skia is f32 by construction.** `include/core/SkScalar.h` has `typedef float SkScalar;` unconditionally — there is no double-scalar build option. `skia_safe::Point` is `{x: scalar, y: scalar}`; `Rect` is four bare `f32`.
- **kurbo is f64-only.**
- **Vello also encodes f32 to the GPU.** `vello_encoding::Transform` is `matrix: [f32; 4]`, `translation: [f32; 2]`. kurbo's f64 is CPU-side curve math — flattening, offsetting, stroke expansion — truncated at the encode boundary exactly as Skia truncates at the draw call.

So both engines rasterize in f32, because GPUs do. **f64 is a curve-algorithm choice, not a rendering-precision one.** "Make everything f64" is not available, and A cannot avoid a per-call truncation.

**Where A's cost actually is.** Not the casts. At 10k shapes, ~20 conversions each is ~200k `f32.demote_f64` per frame; even pessimistically that is well under 1% of a 16.7 ms budget, and caching converted values would fix it if it were not. The cost is the **working set**: at the plan's own sizing (~52 B/node + ~22 B/cubic segment at f32) a 10k-shape document is ~5 MB of geometry, and f64 roughly doubles it — the difference between plausibly cache-resident and definitely not. Caching cannot help, because the copies *are* the problem. Pan and zoom dirty everything, which is exactly when it bites.

**What A would buy.** f64 world space with f32 device space is a legitimately better architecture at extreme zoom, where f32 world coordinates lose precision. Plus one model instead of two. It is a trade, not a loss.

**Ordering is what decides it, and Masonry shows why.** Masonry runs kurbo f64 through its entire widget tree with no f32 mirror, and does not pay per frame — because `masonry_core/src/passes/paint.rs` keeps `scene_cache: HashMap<WidgetId, (Scene, Scene, Scene)>` and only re-records when a `request_paint` flag is set; a clean widget's recorded scene is reused, `clear()`ed rather than reallocated. **The retained scene is the cache.** So whether A's memory cost matters is not a property of the type system — it is a property of whether dirty-gated per-node retained scenes exist. That is D8, currently scheduled in Phase 6.

**Therefore A is not attempted until both hold:** D8's dirty gating has landed, and a pan/zoom on a real document has been measured with D9's present-to-present harness. With those, A is cheap. Without them, A is expensive for precisely the reason the casts are not.

*Caveat on the precedent:* Masonry is hundreds of widgets, not 10k shapes, its damage-region handling is still open ([xilem#789](https://github.com/linebender/xilem/issues/789)), and a UI never pans or zooms its whole scene. It validates the pattern, not the scale. The cache-residency numbers above are reasoning from the plan's sizing figures, not measurements.

### D17 — Layer ownership: reuse the payload layouts, keep the calling convention for now

The stack, host to GPU, and who owns each layer:

| # | Layer | Shared? |
|---|---|---|
| 1 | TS · document model + geometry resolution | both |
| 2 | TS · delta computation (`changedKeys`/`wantsKey`) | both |
| 3 | TS · `api/*.ts` property setters (34 modules) | both |
| 4 | ABI payload layouts (`Raw*Data` + `ToJs`) | both — **currently in the wrong crate** |
| 5 | Transport + calling convention | per backend, bridged by a facade |
| 6 | Decode → engine types | per backend |
| 7 | Scene store | per backend |
| 8 | Caches / scheduler | per backend — but see the SSA seam below |
| 9 | Geometry algorithms | both, via kurbo (D12) |
| 10 | Rasterization | per backend, by design |

**"Reuse the existing ABI" vs "define a new format" was a false dichotomy.** It decomposes into three independent decisions:

1. **Where do the payload layouts live?** → `render-core`. `RawSolidData`, `RawGradientData` and friends are `#[repr(C)]` over `u32`/`f32`/`u8` — the *definitions* carry no Skia. The `From<Raw…> for shapes::Fill` conversions in the same files do, via `shapes::Color`, which is `pub type Color = skia::Color` (`shapes.rs:179`) — so a bare `grep skia` on those files misleadingly returns 0. **The files split: definitions move, conversions stay.** Orphan rules permit it, since `impl From<Foreign> for Local` is legal.

   **Consequence to watch:** `ToJs` lives in `render-wasm/macros`. If `render-core` derived it from there, `render-core` would depend *into* `render-wasm` — recreating exactly the wrong-direction dependency D15 removed from the vello submodule. So the macro crate relocates to the repo root as a shared sibling first.
2. **What calling convention?** → keep render-wasm's for Phase 2. Two reasons. Emscripten's `Module` is just an object of `_name` methods plus `HEAPU8`, so a facade over a raw `WebAssembly.Instance` is ~30 lines and leaves all 34 `api/*.ts` modules untouched — it is not a 170-function port. And an identical wire format buys **differential testing**: capture real buffers from a live session, replay the same bytes into both modules, diff the results. That test does not exist if the formats differ. Revisit in Phase 3 when D7 formalises the `Renderer` interface.
3. **What does `render-vello` store?** → `render_core::model::Scene`, not a mirror of render-wasm's Skia-typed `Shape` tree. This is what keeps A's one real cost — duplicating the store — from materialising.

Only ~20 of the ~170 entry points matter for Phase 2 (geometry only); text, effects, layout and images arrive with their phases.

**Known debt accepted:** the ABI carries implicit current-shape cursor state (`with_current_shape_mut!`), so ordering is load-bearing and unvalidatable from the payload. Explicit `upsert(id, payload)` / `remove(id)` / `commit()` removes that class of bug and is the Phase-3 target. We accept it now because the sequence is already proven in production.

**The SSA seam.** Skia references per module in `tile_grid/ssa/`: `dep_graph` 0, `dispatcher` 0, `liveness` 0, `validator` 0, `surface_ref` 0 — against `production_sink` 22, `allocator` 6, `schedule_builder` 6, `surface_map` 6. The **scheduler is already backend-neutral**; the coupling is concentrated in the executor. Porting SSA to Vello is therefore parameterising the surface backing and writing a Vello production sink, not rewriting the tile system. Recorded so nobody later assumes it is Skia-bound.

**`render-core`'s target**, identical under either Phase-7 branch: `abi/` (payload layouts), `model/` (neutral scene), kurbo + peniko (geometry), `sched/` (the Skia-free SSA half). Converging (D16) would add the decode and the scene store, shared — and those move together, since the decode's output type *is* the store's type.

**Never `render-core`'s:** transport (Emscripten vs raw wasm is forced by D2), rasterization (the point of two backends), and the SSA executor (`production_sink.rs` does real Skia work). That ceiling bounds the crate.

**Split trigger:** if all four modules land, `render-core` is doing four unrelated jobs and `render-core-{abi,model,sched}` becomes the right shape. One crate is correct while it is this small — one dependency edge, one version.

---

## What is already built

**Phase 0 — embeddable Vello module. Done.**
`render-vello` (originally `focus_embed`) exposes `FocusRenderer` on a **host-provided** canvas with no internal event loop: `render()`, `resize()`, `key()`, `set_scene()`, `set_transform()`, `status()`. WebGPU-first with WebGL2 fallback, preferred surface format (no extra per-frame copy), enlarged filter atlas, frame-skip instead of panic on atlas exhaustion. Verified in browser. Builds standalone for `wasm32-unknown-unknown` since D15.

**Phase 1 — neutral core + end-to-end proof. Steps 1–3 and 5 done; step 4 remains.**
- `render-core` re-exports kurbo + peniko and keeps `model` (`ShapeKind`/`Node`/`Scene`); 3 tests. `geom.rs` deleted (D12).
- `core_convert.rs` — Skia↔kurbo boundary, with the matrix element-order trap pinned by an asymmetric fixture and a map-a-point test.
- `model_export.rs` — `Shape` → `render_core::model::Node` for rects, circles, paths, solid fills, emitting `BezPath`/`Brush`. Strokes and gradients are step 4.
- `scene.rs` in `render-vello` — renders a `render_core::model::Scene` with Vello, now with no conversion helpers at all.
- **End-to-end verified in browser:** real Skia `Shape` → neutral model → Vello pixels (rect, circle, cubic path), zero console errors. *Verified before the D12/D15 rewrite; not re-run since.*

---

## Findings

### Measurement methodology
Three ways to compute fps, only one correct:

1. `1000 / encode_ms` — CPU encode throughput. Overstates badly (showed an impossible 172 fps).
2. `on_submitted_work_done` GPU fence — **lowballs** (showed 7 fps). The callback is deferred by main-thread contention, so samples absorb event-loop lag.
3. **Present-to-present interval** — equals perceived fps, vsync-capped. This is the standard.

### Encode cost and caching tiers
Encode measured ~12 ms on the stress scene. Caching, cheapest first:
1. Dirty-propagating typed change-set (Rive model) — re-encode only what changed.
2. Layer-texture caching — cache rendered subtrees.
3. Filter-atlas pooling.
4. Per-path encode cached in **local space**, transformed on GPU — a deep Vello change, and zoom still forces re-flattening.
5. Dynamic resolution under motion.

### Tiling
A cross-frame tile cache is **useless for globally dynamic scenes** — pan/zoom invalidates every tile. Effects make it worse: blur crosses tile seams, so tiles need aprons.

### Threading
- `vello_cpu` has a rayon `multi_threaded` dispatch. **`vello_hybrid` does not.**
- wasm threads need `SharedArrayBuffer` → cross-origin isolation (COOP `same-origin` + COEP `require-corp`). Fine when we control the headers.
- For third-party embeds where we don't: message-passing workers, no header requirement.

### Shader graph
`naga` is an IR / translator / validator — **not an optimizer**. `spirv-opt` optimizes *within* a shader; neither restructures passes. Fusing a DAG into one shader is only valid for **pointwise runs between convolution barriers**.

Pass counts (`is_multi_pass` is true only for these two): GaussianBlur = 2 (BLUR_H, BLUR_V); DropShadow = 4 (OFFSET, BLUR_H, BLUR_V, COMPOSITE); Custom = 1.

### Sizing
- Binaries: render-wasm ~8.3 MB release; `render-vello` 4.2 MB (measured as `focus_embed`, pre-restructure). Only one downloads.
- Geometry data: ~52 B/node + ~22 B/cubic segment.
- render-wasm's `Path` already stores geometry **twice** (`segments: Vec<Segment>` + `skia_path: skia::Path`).

### Ecosystem survey

What already exists, so we do not rebuild it.

**Adopt as-is.** `kurbo` (geometry, stroke expansion, dashing, flatten, offset, fit) · `peniko` (Brush, Gradient, Image, fill rule, BlendMode, Compose, Style) · `color` (CSS Color 4) · `parley` + `fontique` + `glifo` (layout, shaping, fallback, outlines, colour emoji, `PlainEditor`) · `vello_common::filter` (filter graph, blur, drop shadow, atlas — **upstream**) · `velato` + `interpoli` (Lottie, value animation) · `vello_svg` (usvg → scene).

**Copy the shape.** `anyrender` and `imaging` (see D13) · Masonry's imaging migration · Graphite's `path-bool` for booleans.

**Still ours.** Document → scene projection from `skia-rs-wasm` and the wire format · the Skia-side adapter · the SkSL → WGSL effect ports · inner shadow and backdrop blur (Vello gaps) · dirty propagation and caching.

**Peer projects on this stack.** Graphite pairs Vello with kurbo, resvg/usvg, parley and skrifa, on wgpu 29 targeting WebGPU — their Vello path is self-described as alpha. Blitz pairs Vello with Parley, Stylo and Taffy through `anyrender`. Both landed on the same crate set we would.

**Maturity.** `vello_hybrid` is "roughly beta quality" as of Linebender's Q1 2026 report — usable, with rough edges and performance work outstanding.

---

## Plan

### Phase 1 (finish) — adopt kurbo + peniko as the core
Rewritten under D12. The original "hand-write strokes, gradients, opacity/blend, hierarchy, corner radius into `render-core`" is largely writing kurbo and peniko a second time.

1. **Gate:** verify kurbo + peniko build for `wasm32-unknown-emscripten`. Everything below depends on it.
2. Delete `render-core/src/geom.rs`; re-export kurbo. Replace `model.rs`'s `Color`, `Fill`, `Path`, `PathSeg` with peniko and `kurbo::BezPath`. Keep only what is genuinely ours: node identity, `ShapeKind`, hierarchy, the Penpot effect stack.
3. Retype `core_convert.rs` as kurbo↔Skia rather than ours↔Skia. Still affine-only.
4. Extend `model_export` in step — strokes and gradients now map onto peniko types instead of newly hand-written ones. Keep the native tests green.
5. Relocate `render-core` out of `render-wasm/` to a shared root and repoint both consumers. **Done** — went further, per D15: `render-vello` also moved out of the submodule, so all three crates are siblings.

*Deferred to later phases: text, effects, custom shaders, boolean ops.*

**Status: Phase 1 complete.** `render-core` is kurbo + peniko with `geom.rs` deleted; `core_convert` is Skia↔kurbo with the matrix element-order trap pinned by tests; `model_export` emits `BezPath`/`Brush`, gradients and strokes.

Three things step 4 settled, each recorded in the code:
- **Gradients**: linear → `new_linear`, radial → `new_radial` (radius from `Gradient::width.0`), angular → `new_sweep` over 0..2π. **Diamond has no peniko equivalent** — a Penpot/Figma construct, not a CSS/SVG one — so it is not projected and rides along with the Phase-4 SkSL→WGSL work (D10).
- **Strokes**: `kurbo::Stroke` already carries width, join, caps, miter limit and dash pattern, so `model::Stroke` is just `{ style, brush }`. **`StrokeKind` inner/outer is dropped, not approximated** — it is an offsetting decision with no kurbo slot, and projecting it as centred would draw it in the wrong place. Path offsetting comes later.
- **`Gradient`'s fields are now `pub`** in `shapes/fills.rs` — the first edit to shipping engine code under D6. It is read-only data exposure, not a type swap, so B's guarantee (no behaviour change in the Skia path) holds. `colors`/`offsets` remain parallel; only `add_stops` appends.

### Phase 2 — live data path
Feed `render-vello` a real document from `skia-rs-wasm` rather than a hand-built model. **Wire format settled by D17**: reuse render-wasm's, with `Raw*Data` relocated into `render-core` so both backends parse identical bytes through identical definitions.

1. Move `Raw*Data` + `ToJs` from `render-wasm/src/wasm/**` into `render-core::abi`; render-wasm keeps its `From<Raw…> for shapes::Fill`.
2. Facade in `skia-rs-wasm` presenting a `Module`-shaped object (`_name` methods, live `HEAPU8` getter) over a raw `WebAssembly.Instance`, so `api/*.ts` is untouched.
3. `render-vello`: the ~20 geometry entry points, decoding into `render_core::model::Scene`.
4. Vello renders a real Penpot page (geometry only).

Visual diff against Skia — replay captured buffers into both modules and diff, which the identical wire format makes possible. Also evaluate `imaging_conformance` and `imaging_snapshot_tests` (D13) before writing our own harness, since they already target skia-safe against vello_hybrid.

**Status: steps 1 and 2 done; step 3 in progress.** Step 3 is being taken in slices, ordered so that the shortest path to a real page comes first — paths, then hierarchy, then lifecycle, then host wiring; strokes and the differential harness follow the first pixels.

- **Slice A (done)** — path segments and corners. `RawSegmentData` and its three command layouts moved into `render_core::abi::path` with the same safe codec treatment the fills got, and the *same* padding bug fixed (`RawMoveCommand`/`RawLineCommand` carry sixteen explicit bytes of it). `decode_path` is strict where the code it replaces printed a warning and carried on — a ragged buffer misreads every segment after it, which shows up as subtly wrong geometry rather than an error. `Node` gained `corners: Option<RoundedRectRadii>`; Penpot's `r1..r4` is already TL/TR/BR/BL, matching both Skia's `RRect` array and kurbo's field order, so nothing is reordered anywhere. render-vello gained five entry points, and `set_shape_kind` was renamed `set_shape_type` — the host calls `_set_shape_type`, so the old name was a function it could never reach.
- **Slice B (done)** — hierarchy and clipping. `Scene` became a tree: nodes keyed by id, walked from `ROOT_ID` (the nil UUID, which the host addresses like any other node) through each node's `children`. Keyed rather than ordered because the wire delivers nodes in no particular order — a child routinely arrives before the parent listing it. `ShapeKind` gained `Frame` and `Group`; `Node` gained `children`, `parent` and `clip`. render-vello gained ten entry points (`set_parent`, `add_shape_child`, `set_children_0..5`, `set_children`, `set_shape_clip_content`) and a recursive walk.

  **Two findings from reading render-wasm's traversal, both of which would have silently produced wrong pixels:**
  - **Parent transforms are not accumulated.** Penpot stores absolute `selrect`s, so a child is already in page space; render-wasm applies `scale · viewport · shape_matrix` from scratch per shape and never carries a parent CTM. Containers contribute layers and nothing else. Composing a parent matrix in — the obvious thing to write — double-transforms every nested shape.
  - **Each shape's matrix is centred on its own bounds:** `translate(c) · transform · translate(-c)`. render-vello had been applying the raw transform since Phase 1, which makes a rotation orbit the page origin. Now `Node::effective_transform`.

  Clip and opacity take separate layers: opacity wraps the node's own paint *and* its subtree, clipping covers only the children (a frame is not clipped by itself, which starts to matter once strokes straddle the boundary).

- **Slice C (done)** — lifecycle and viewport. Twelve entry points: `init`, `set_render_options`, `resize_viewbox`, `set_view`, `set_view_start`/`end`, `render`, `render_sync`, `set_canvas_background`, `reset_canvas`, `init_shapes_pool`, `clean_up`. The scene now reads from the ABI, with the hand-built demo kept only as a fallback for when no host is attached.

  **`init` does not create the drawing surface, and that asymmetry is structural.** Emscripten binds a GL context to a canvas in its JS glue, so render-wasm's `init(width, height)` is synchronous and canvas-free. Acquiring a wgpu adapter and device is async and needs the canvas element, so surface creation stays at `create_focus_renderer(canvas)` — a wasm-bindgen call the facade already passes through untouched. Phase 3's `Renderer` interface is where this gets absorbed, as an async `create` both backends implement.

  **`render()` records a request rather than drawing.** render-wasm's own `render()` schedules too, and Phase 0 deliberately left the frame loop with the host (D3), so the host polls `frame_requested()` from its `requestAnimationFrame`.

  Viewport maths is `scale(zoom · dpr) · translate(pan)`, reached from render-wasm's `Viewbox` by a different route but putting page point `(-pan_x, -pan_y)` at the canvas origin either way. Zero or negative zoom/dpr falls back to 1 — a degenerate matrix renders as a blank canvas, which is indistinguishable from a broken module.

  Verified by driving the C ABI from JavaScript in a browser: `clean_up` → `init` → `set_render_options` → `set_canvas_background` → shape tree with fills through the shared buffer → `set_view` → `render`. A `1280×720` probe rect at identity filled exactly the top-left quadrant of the `2560×1440` canvas, which pins the scene's coordinate space to device pixels and rules out a double-counted `dpr`.

- **Slice D (done)** — host wiring. `api/*.ts` drives render-vello unmodified, checked by execution: `vello-instance.ts` instantiates the real wasm in Node with all ~600 bindgen glue imports stubbed as throwers (the ABI path calls none of them), and the real `node-factory` → `orchestration::setObject` → `viewport::setViewBox` chain runs against it. In the app, `?renderer=vello` loads the Vello artifact, acquires a WebGPU adapter and syncs shapes into its scene.

  **It paints.** Re-measured in a real Chrome with the tab in front, which is what the earlier "zero frames" reading was missing: `requestAnimationFrame` does not fire in a hidden tab, and the module owns no frame loop by design (D3), so a backgrounded tab reports a healthy scene and zero frames forever. The demo model renders in full — clipped children, half-transparent group, dashed frame stroke straddling the edge, dotted stroke rotating with its rect — and shapes fed through the C ABI paint alongside it.

  **The measurement lesson is the durable part.** Every symptom of "the backend is broken" was also a symptom of "nobody asked it to draw", and the two are told apart by looking at the tab, not at the code. The same hidden-pane state now reads 5 nodes delivered, 4 paintable, 0 frames — a complete scene that simply never gets a tick.

  `scene_paintable_count` was added for the other half of that ambiguity: `scene_node_count` counts what the host *sent*, this counts what would be *drawn*, using the digest's reachability rules. A blank canvas with a healthy node count means the shapes arrived unreachable from the root, or with no fill and no stroke — a distinction no screenshot can make.

  The census this produced is the useful number: a page sync of frames, groups, rects and circles reaches exactly **thirteen** unimplemented entry points, all effects/layout/cache, none geometry. The raw count of 118-of-153 missing exports badly overstates the gap.

  Traps found: build the **cdylib**, not the bin (the bin's `main()` is a mock host that hijacks the page); Vite will not import from `public/` in source even with `@vite-ignore`, so the specifier is computed at runtime; and the backend marker must not start with `_`, or `stubMissingExports` turns it into a no-op function and the backend check silently fails.

  **The canvas needs its device-pixel backing store before the surface exists.** `initCanvasContext` ends with `setCanvasSize(canvas, dpr)`; the Vello branch did not, so the canvas kept its CSS-sized backing while `set_render_options` still announced the real dpr — the viewport scaled by a factor the canvas did not have and the whole scene drew exactly `dpr` times too large. Relative geometry stayed perfect throughout, which is the signature of a uniform scale error and rules out the traversal. It also self-corrected on the first window resize, because `Renderer.resize` calls `setCanvasSize` too, so it read as intermittent rather than systematic. The invariant to assert is `canvas.width === canvas.clientWidth * dpr`, and it must hold *before* `create_focus_renderer`, which sizes the wgpu surface from `canvas.width/height`.

  **Resizing had to be wired by the host.** Nothing in the app announces a resize to the backend — layout writes the canvas's `width`/`height` and a WebGPU canvas silently re-creates its drawing buffer to match. Vello's depth texture does not follow: `vello_hybrid` rebuilds it only when the `RenderSize` passed to `render()` changes, so the next frame fails validation with a depth attachment sized for the old canvas, and *every frame after it is rejected too* — one panel drag turns into a permanently dead canvas. `FocusRenderer::resize` existed and was simply never called. The frame loop now polls the canvas before drawing, which catches every source of the change (window, panel drag, DPR) and keeps the loop the only thing that talks to the renderer, per D3.

  Two hazards the paint investigation exposed, neither yet fixed:

  - **A malformed buffer yields zero fills, silently.** `set_shape_fills` reads a 4-byte header whose first byte is the count, then fixed-size records; a wrong offset makes the count read as zero, and `decode_fill(..).ok()` drops undecodable records without a word. The shape then arrives complete in every respect except that it has nothing to draw with, which looks exactly like a broken renderer. This is what `scene_paintable_count` is for, and it argues for the codec reporting rejects rather than swallowing them.
  - **`alloc_bytes` returns null while a buffer is still pending**, where render-wasm's simply replaces it. Any host that allocates twice without a consumer in between — a stubbed entry point that never drains the buffer would do it — gets a null pointer and writes into address 0. Not currently reached: after a full page sync the buffer is free.

- **Slice F (done)** — the differential harness. Built ahead of strokes because it is what makes strokes checkable.

  **The diff is at the model, not at pixels.** `Scene::digest` in render-core fingerprints everything that would be drawn; both backends can compute it from the *same* recorded byte stream — render-vello directly, render-wasm by projecting its Skia shapes through `model_export`. Equal digests mean the two agree on what the document *is*, which separates "we read the wire differently" from "our rasterisers differ". A pixel diff conflates those, and two rasterisers always disagree slightly on antialiasing.

  The digest ignores storage order (it walks the tree, never the map), respects paint order, and covers only what is reachable and visible — so an orphan one backend has collected and another has not is not a false positive.

  `abi-recorder.ts` captures the call stream — names, arguments, and the bytes staged in the shared buffer, without which every fill and path would be missing — and replays it into any backend. Replay re-runs `alloc_bytes` rather than trusting recorded pointers, which is precisely the indirection that lets one capture drive two different allocators. Recordings are JSON, so a capture from a live browser session becomes a fixture.

  **The trap worth knowing:** the digest covers only what is reachable from `ROOT_ID`, so a scene whose root children were never set hashes identically to an empty one — every comparison would pass while proving nothing. Every assertion in the suite is guarded against the empty digest.

  Still open: render-wasm's side. It cannot be driven in Node (its `_init` brings up a GL context), so the cross-backend comparison has to run in a browser, and it needs a `scene_digest` export built over `model_export`'s projection.

- **Slice E (done)** — strokes. Seven entry points; centre strokes drawn, inner and outer accepted and dropped (they are offsetting decisions kurbo cannot express, and drawing them centred puts paint visibly in the wrong place — worse than nothing, because it reads as a rendering bug rather than a missing feature).

  **The style→dash mapping lives in render-core**, in `apply_stroke_style`. Penpot's Dotted/Dashed/Mixed each imply a pattern built from the width (`width + 10`, `width + 5`, `width + 1`) — constants arbitrary enough that deriving them separately on each side is exactly how two backends end up drawing visibly different dashes from the same document.

  Three divergences this surfaced, none of which would have shown up without doing both sides at once:
  - **kurbo and Skia have different stroke defaults.** `kurbo::Stroke::new` gives a round join and round caps; Skia gives miter and butt, and render-wasm leaves those alone when the host sends nothing. Both the ABI and `model_export` now start from Skia's, or every unstyled stroke would differ with nothing in the document to explain it.
  - **`model_export` was dropping three of the four stroke styles.** It read `stroke.dashes` alone, so Dotted, Dashed and Mixed all projected as solid.
  - **It was also honouring dashes on a Solid stroke**, which render-wasm's own `to_paint` does not. (`set_dashes` forces `Dashed`, so the combination is unreachable from the host — but the projection disagreed with the renderer.)

  **Dotted needed a fix found only by looking.** Skia stamps circles with a `path_1d` effect; the kurbo equivalent is a round-capped dash of no length. An *exactly* zero-length dash is dropped rather than drawn — the dotted stroke simply did not appear in the browser — so it is `DOT_LENGTH = 0.01` instead.

  `Scene::digest` now covers the whole stroke style, not just the width: a dash pattern or join change would otherwise slip through a comparison unnoticed, which is the one thing the harness exists to prevent.

Two casualties of the relocation, both fixed in place:
- `SerializableResult` lost its `From<BytesType> + Into<BytesType>` supertrait bounds. Those types are foreign to render-wasm now, so the orphan rules forbid the conversion impls; nothing used the bounds (`write_vec` only calls `clone_to_slice`).
- **The generated `shared.js` came from one crate and now comes from two.** `ToJs` appends to `$OUT_DIR/render_wasm_shared.js` per crate, and both `_build_env` and the CI workflow took `find … | head -n 1` — an emscripten build duly picked render-core's file and cut the frontend's `shared.js` from 36 enum constants to 2. Both now concatenate and dedupe by declaration name; duplicates are real, because cargo keeps stale build-script hash directories and repeat invocations append twice.

**The emscripten build is the gate that matters here** (D2: render-wasm must keep building for `wasm32-unknown-emscripten` against prebuilt Skia). Run it with `pnpm run build:wasm` from `skia-rs-wasm` — it drives `render-wasm/build` inside `penpotapp/devenv`. Slice A passes it.

### Phase 3 — common ABI + runtime selection
Define the `Renderer` interface in `skia-rs-wasm`, shaped after `imaging`'s `PaintSink` (D13) with its streaming/retained split; write the two adapters (Emscripten and wasm-bindgen); capability-detect WebGPU and lazily download the matching `.wasm`. After this phase the two modules are genuinely interchangeable.

### Phase 4 — effects parity
Blur, drop/inner shadow, blend modes, masks, clips onto Vello's filter graph. Port the SkSL RuntimeEffects to WGSL via `FilterPrimitive::Custom`. Fuse pointwise runs between convolution barriers. Known Vello gaps to close: inner shadow, backdrop/background-blur semantics.

### Phase 5 — text + images
Parley layout/shaping → Vello glyph runs. Image decode/upload to Vello textures; browser-decoded texture fast path → wgpu interop. Highest-risk phase.

### Phase 6 — caching + animator
Rive-style dependency-ordered dirty propagation (D8), following Masonry's shape: a retained recorded scene per node, re-recorded only when a dirty flag is set. Layer-texture cache and filter-atlas pooling. Benchmark against Skia using present-cadence on real files — **including a pan and a zoom**, which are the cases that dirty everything.

This phase is also the gate on Phase 7: per D16, approach A cannot be judged before dirty gating exists and that measurement has been taken.

### Phase 7 — converge or hold
Either keep two peer modules indefinitely, or absorb render-wasm's model into `render-core` (approach A) so both modules share one model outright.

Genuinely open, not leaning (D6 as amended by D16). Note that `model_export` disappearing does **not** require A — it goes away in Phase 2 when the host feeds `render-vello` directly (D3, D4). A is only about whether render-wasm itself stops holding Skia types internally, and it carries the f64 working-set cost D16 quantifies.

---

## Open questions

- **How much geometry is already resolved in `skia-rs-wasm`'s TS layer vs inside render-wasm/Skia?** This sizes the shared core directly. The more that is already neutral in TS, the less Skia-resolution work remains. Text is the known Skia-internal case; stroke expansion is answered by D12 (`kurbo::stroke`), boolean ops remain unverified.
- **Does `imaging_conformance` run without its desktop GPU features?** `imaging_skia`'s `gpu` feature pulls wgpu 28, ash, Metal and D3D. The CPU path is what we would want; unverified.
- ~~**`render-core`'s home**~~ — settled by D15: repo root, sibling to both backends.
- **`vello_hybrid` has no threading.** If CPU-side encode becomes the bottleneck, that work has to be added.
- **Feature parity surface:** inner shadow, backdrop blur, all blend modes, exact gradient semantics.
- **Download cost** of the Vello module vs Skia, and how the host chooses when WebGPU is present but the document is effect-light.
