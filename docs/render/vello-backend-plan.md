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

  **The facade must publish every heap view, not the ones a page sync happens to touch.** It exposed `HEAPU8`/`HEAP8` only, so `module.HEAPU32` was `undefined` and the first selection threw `Cannot read properties of undefined` from inside `writeUUIDToHeap` — nowhere near the cause. The host reaches for whichever width suits the data (`HEAPU32` for uuids, `HEAPF32` for rects), so all eight are published now, from one table that also drives the proxy's key checks so the two cannot drift.

  **`get_selection_rect` is the first *query* entry point**, and queries fail differently from the setters: a stub returning `0` is a valid-looking pointer, so the host reads ten floats from heap offset 0 and gets plausible garbage rather than an error. The result buffer is a `Vec<u32>`, not `Vec<u8>`: the host divides the returned pointer by four to index `HEAPF32`, and `Vec<u8>` only promises alignment 1.

  **The rule lives in `render_core::selection`, not in the ABI** — the same argument as `apply_stroke_style`. Its wire layout is positional and its central asymmetry reads like a bug until you know it is deliberate: a **single** selected shape reports its *oriented* box, with width and height being the shape's own and the rotation in the matrix, while a **multi**-selection reports the axis-aligned hull, unrotated. Two backends deriving that separately is precisely how they end up disagreeing. It takes quads rather than model nodes so both can call it: render-vello builds them from `Node`s via `node_quad`, and render-wasm's `Bounds` is already an oriented quad of the same four corners, so it can pass them straight in without projecting its Skia state through the neutral model.

  **Still one-sided:** render-wasm has not been migrated onto it and keeps its own copy, so "shared" is currently true of the code and not yet of the callers. That migration wants an equivalence test against the existing `Bounds::transform_matrix` before it lands, since it touches the selection path of the backend people actually use.

- **Modifiers (done, rigid slice)** — move, resize and rotate. All three are one mechanism: rather than committing on every pointer move, the host pushes a per-shape transform and commits once at the end, so a stubbed `set_modifiers` leaves all three gestures dead.

  The host's gesture block is `clean` → `set_structure_modifiers` → `propagate_modifiers('child')` → `set_modifiers(propagated)`, and it **uses what propagate returns** — so propagate cannot be a no-op that returns nothing, or the final `set_modifiers` is handed an empty list and nothing moves.

  Modifiers live beside the scene, not on `Node`: they are preview state alive only for a drag, and `Scene` means the document. render-wasm draws the same line — its modifiers sit in the shapes pool and are applied on `get`.

  Two placement rules that are silently wrong if reversed: the gesture transform goes **between** the viewport and the shape's own matrix (`root · modifier · effective_transform`), because it is expressed in page space; and it is **not** inherited down the tree, because the host already propagates a container's gesture to each descendant explicitly, exactly as it does for the committed absolute transforms. Inheriting would apply a group's drag twice to everything inside it.

  This also makes `get_selection_rect` modifier-aware, which is the reason that query belongs in the renderer at all: render-wasm's `shapes_pool::get` returns `shape.transformed(modifiers, …)`, so it reports live drag bounds that the committed document — and therefore the worker's index — does not have.

  **What the rigid slice does not do:** constraints and layout. A child pinned to its container's right edge will not stretch when the container is resized, and flex/grid containers do not reflow — render-wasm reaches those through a constraint solver and an iterative reflow loop. Half of that would be worse than none: a shape that moves *nearly* correctly is harder to trust than one that plainly does not move. `set_structure_modifiers` and `set_absolute_modifiers` are accepted and ignored for the same reason, but they still **drain** the shared buffer — a handler that ignores its input without taking it leaves the buffer occupied and the next `alloc_bytes` returns null.

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

  **Both sides now answer it.** render-wasm's `scene_digest` projects its whole shapes pool through `model_export` and digests that, so the two backends reach one model by different routes. Committed geometry only — `shapes.iter()` rather than `shapes.get()`, so modifiers are deliberately excluded: mid-drag the backends are *meant* to differ from the document, and a digest that moved during a gesture would compare two moving targets.

  **Verified in a browser: both backends report `3846661256` for the canonical document.** Same call stream, two engines, two routes to the neutral model, one number. render-wasm still cannot run in Node — `_init` brings up a GL context — so the Vello side is pinned to that constant in `cross-backend-digest.test.ts`, and the Skia side is re-checked by driving the same document through `api/*.ts` in a page and reading `renderer.sceneDigest()`.

  Getting there turned up three faults in the harness itself, all of the same family — a check that passes without testing what it claims:

  - **A child needs listing, not just parenting.** `setObject` takes a container's children from its own `shapes` array, so setting `parentId` alone leaves the child unreachable from the root and invisible to the digest. The first anchor covered the frame and nothing else, and read as parity.
  - **`node-factory` ids are random.** The digest hashes ids, so any two rebuilds differ regardless of geometry. `notices a one-unit geometry difference` had been passing on that alone; with fixed ids it failed, and now asserts reachability before asserting the difference.
  - **The Node harness loaded a different binary from the app** — `render-vello/dev/pkg/` rather than the published `public/wasm-vello/`. It sat several entry points behind and every test still passed, because they only touched exports both builds happened to have. Both now load the published artifact.

  Two things the harness caught immediately, which is the argument for having built it:

  - **The two models disagree on the default `clip`.** `Shape::new` defaults `clip_content` to true, `Node::new` to false. Every shape the host syncs carries an explicit value, so no real document is affected — but any path that creates a shape without the flag would have one backend hide its children and the other not. The defaults are deliberately left unaligned: failing open is safer, since an unclipped shape spills visibly while a wrongly-clipped one makes content vanish with nothing on screen to explain it.
  - **A fixture built from `node-factory` is not canonical.** It mints a fresh uuid per call and the digest hashes ids, so a document that looks fixed digests differently every run. Both backends must be driven with the *same ids*; a replayed recording gives that for free, a hand-built fixture has to state it.

- **Gradients (done, linear)** — fills and strokes.

  **The coordinate convention is the whole problem.** Penpot's exporter emits gradient endpoints normalised to `0..1` of the shape's own box, and render-wasm maps them with `translate(rect.origin) · scale(rect.size)` as a shader-local matrix. Vello's `set_paint_transform` has exactly those semantics — applied to the paint *after* the geometry's transform — so the same mapping is expressed the same way. Drawn without it, every gradient collapses into the top-left pixel of the page, which looks like a missing feature rather than a wrong matrix.

  The paint transform is context state, not an argument: left set, the next shape's solid fill is drawn through the previous shape's gradient mapping. It is reset after each node.

  Fill selection is now "the first fill this backend can *paint*", not "the first fill". A shape whose top fill is an image would otherwise render as nothing while a usable solid sat underneath it.

  **All three kinds now paint**, via a per-fill transform in the model. `Node.fills` is `Vec<Paint>` and `Stroke` carries a `Paint`, where `Paint { brush, transform }` — the transform is in *unit-box* space, so a renderer applies `unit_box_to(bounds) · paint.transform`. Solid paint and linear gradients leave it at the identity and cost nothing.

  **The gradient maths lives in `render_core::gradient`**, for the third time the same argument has come up: a radial's radius comes from the *distance* between its two points (not from `width`, which the field name invites), it is rotated by `atan2` of that span plus 90°, and squashed by `width.0`; an angular is a fixed sweep at `(0.5, 0.5)` with everything in a matrix built from two axes that need not be perpendicular. Deriving that twice is how the backends drift on a rotation nobody notices until a design looks subtly wrong.

  Two behaviours worth knowing, both pinned by tests: a radial whose start and end coincide is **dropped** rather than painted, since there is no direction to rotate to; and an angular whose two axes are collinear is dropped too — Skia builds a singular matrix there and paints something arbitrary. `wrap_angular_stops` moved across as well, closing the sweep's seam with an interpolated stop at each end. It interpolates component-wise in sRGB because that is what Skia's `lerp_color` does — a perceptually better blend here would be a worse match, and the two must agree on the pixel.

  Verified across both backends in a browser: identical digests for linear, radial and angular (`1569249000`, `599815916`, `494599920`), and the demo scene's radial renders with a visibly off-centre, squashed hot-spot — which is the rotation and ellipse arriving through the transform rather than being lost.

  **`digest_brush` now hashes gradient geometry**, not just stops. Colours alone would let two backends disagree about a gradient's direction — the same stops running left-to-right on one and top-to-bottom on the other — and report a match.

  Verified across both backends in a browser: identical digests for no-fill, solid, left-to-right and top-to-bottom (`1475261443`, `727853624`, `3649157659`, `1129462453`), and the gradient visibly rotates with its endpoints.

  Two things this turned up:

  - **Shape type ids are not what a reader guesses.** `2` is *bool*; rect is `3` (`serializers.ts`). More importantly, render-vello mapped every unknown id to `Rect` while render-wasm's projection returns `None`, so a text or bool shape was a rect on one side and absent on the other — real documents containing text could not be compared. **Closed by Slice F.**
  - **The clip default divergence is not theoretical.** Driving the ABI directly, with no `set_shape_clip_content`, the two backends disagreed on *every* shape — including one with no fill at all. The host always sends the flag, so documents are fine, but any harness that drives the wire by hand must send it too.

- **Image fills (slice 1 of 2 done)** — the reference is in the model and the digest; the pixels are not yet drawn.

  **Images cannot be a peniko brush in the shared model.** render-wasm holds a Skia texture and render-vello a wgpu one, and the neutral model can hold neither. So `render_core::model::Brush` is now a *local* enum — `Solid`, `Gradient`, `Image` — shadowing `peniko::Brush` with the same `Solid`/`Gradient` shapes (every construction site compiled unchanged) and adding `Image(ImageFill)`, a **reference**: id, dimensions, opacity, keep-aspect and an optional dest-rect, mirroring `RawImageFillData` and Skia's `ImageFill` field for field. Each backend resolves that id against its own image store at paint time — which is how render-wasm already works internally.

  Both projections carry it (`abi.rs` from the wire, `model_export.rs` from the Skia fill) and `digest_brush` hashes every field, so an image fill is now comparable across backends without either texture. Verified in a browser: the same wire record digests to `1012389335` on both.

  **Slice 2 (done) — the pixels paint.** The image path was the first genuine crack in D17's one-wire-format: the only upload today is `fetch → createImageBitmap → WebGL texture → store_image_from_texture(glTextureId)`, Emscripten-GL end to end and meaningless to wgpu. As decided, the host now branches on backend for image *data*: for Vello it reads the `ImageBitmap` back to straight RGBA (`OffscreenCanvas.getImageData`) and sends the pixels through a new `store_image_rgba`; the Skia path is untouched.

  On the module side, images take a different door from every other fill because the pixels need the wgpu device the *renderer* owns, not the ABI. So `store_image_rgba` only **stages** into a pending queue; the renderer drains it each frame, uploads to the hybrid `ImageCache` atlas (`Pixmap::from_parts` → `upload_image` → `ImageId`), and records `id → ImageId`. `scene.rs` resolves `Brush::Image` against that map — an id not yet uploaded draws nothing that frame rather than a placeholder, and the frame after the upload shows it. Premultiplication happens in Rust when the `Pixmap` is built, not in a JS pixel loop.

  Placement mirrors render-wasm's `get_source_rect`: stretch by default, cover-and-centre under keep-aspect (the overflow clipped by filling only the target), and into the dest sub-rect when one is set. Verified in a browser: a four-quadrant test image renders in the right orientation (top-left origin, not flipped) and fills the box.

  **Two honest gaps.** The host readback path (`storeImageRgbaForVello`) is typechecked and produces the exact bytes the render was driven with, but the full `fetchImage → getImageData → store_image_rgba` flow with a real fetched asset was not exercised (no asset URL in the harness). And the atlas slots leak on `clean_up` — the maps clear, the GPU allocations don't — the same Phase-3 lifecycle debt as orphaned nodes.

  **Superseded note — painting it is slice 2, and it needs the host.** The only image path today is `fetch → createImageBitmap → WebGL texture → store_image_from_texture(glTextureId)` — Emscripten-GL end to end, meaningless to wgpu. Decision (asked and taken): the host will read the decoded `ImageBitmap` back to RGBA (`getImageData`) and upload it through a new `store_image_rgba` entry; render-vello builds a `Pixmap::from_parts`, registers it in the hybrid `ImageCache` atlas, and resolves `Brush::Image` against it. This is the first place the host branches on *which backend* for data rather than only for init — a deliberate, scoped crack in D17's "one wire format", justified because the GL-texture handoff simply has no wgpu equivalent.

- **Diamond gradient (carried, paint deferred)** — no longer a silent hole.

  Diamond is Penpot's fourth gradient: the same stops sampled along the L1 distance `|x| + |y|` rather than a radius or an angle. peniko has no such kind and Vello no built-in; render-wasm draws it with a small SkSL runtime effect. Both backends used to **drop** it (`None`), which meant a diamond fill hashed identically to *no fill* — the harness was blind to it, and a document where diamond silently vanished on both sides read as parity.

  So it is now carried like an image: `Brush::Diamond(DiamondGradient)` holds its geometry and stops un-resolved, both projections build it, and `digest_brush` hashes it under its own tag. Verified in a browser: a diamond and a radial with *identical* geometry and stops digest apart (`2600502185` vs `219270083`) and match across backends.

  **And now it paints — by baking, not by a custom shader.** The realisation: a diamond is a pure function of static parameters (`ramp(|x|+|y|)`), so it can be *baked* to a texture and drawn through the image atlas from slice 2 — no WGSL, no D10 machinery. The custom-shader path is only needed for the *live* effects (glass, noise, material) that depend on a backdrop or clock.

  `render_core::gradient` bakes the L1 field into a 512² tile of straight RGBA (the inverse matrix mirrors render-wasm's `to_diamond_shader`, the ramp sampled component-wise in sRGB to match Skia). The renderer's pre-pass walks the scene for diamonds, bakes any it has not seen (keyed by a content hash, so an unchanged diamond bakes once), and stages them as `PendingImage`s that ride the *same* upload path as real images. `scene.rs` resolves `Brush::Diamond` to its baked `ImageId` and draws it — with a **pixel-space** transform (`[0, TILE]² → bounds`), not the unit-box transform gradients use: the first cut rendered solid because a unit-box map samples only the tile's first pixel across the whole shape.

  Verified in a browser: a three-stop diamond renders centred, with correct L1 (not circular) contours and edge-clamped corners. Tradeoff: bake resolution, so some softness at extreme zoom — the documented cost of baking over a live shader. render-wasm is unaffected — it never rendered from the neutral model, only projects into it, and keeps its own SkSL.

  Not cross-checked pixel-for-pixel against Skia: the WebGPU canvas is not readable via 2D `drawImage`, and diamond pixels are each backend's own rasterisation anyway (the digest compares the model, which already matches). The bake's unit tests and the visible L1 field are the correctness evidence.

- **Slice E (done)** — strokes. Seven entry points; centre strokes drawn, inner and outer accepted and dropped (they are offsetting decisions kurbo cannot express, and drawing them centred puts paint visibly in the wrong place — worse than nothing, because it reads as a rendering bug rather than a missing feature).

  **The style→dash mapping lives in render-core**, in `apply_stroke_style`. Penpot's Dotted/Dashed/Mixed each imply a pattern built from the width (`width + 10`, `width + 5`, `width + 1`) — constants arbitrary enough that deriving them separately on each side is exactly how two backends end up drawing visibly different dashes from the same document.

  Three divergences this surfaced, none of which would have shown up without doing both sides at once:
  - **kurbo and Skia have different stroke defaults.** `kurbo::Stroke::new` gives a round join and round caps; Skia gives miter and butt, and render-wasm leaves those alone when the host sends nothing. Both the ABI and `model_export` now start from Skia's, or every unstyled stroke would differ with nothing in the document to explain it.
  - **`model_export` was dropping three of the four stroke styles.** It read `stroke.dashes` alone, so Dotted, Dashed and Mixed all projected as solid.
  - **It was also honouring dashes on a Solid stroke**, which render-wasm's own `to_paint` does not. (`set_dashes` forces `Dashed`, so the combination is unreachable from the host — but the projection disagreed with the renderer.)

  **Dotted needed a fix found only by looking.** Skia stamps circles with a `path_1d` effect; the kurbo equivalent is a round-capped dash of no length. An *exactly* zero-length dash is dropped rather than drawn — the dotted stroke simply did not appear in the browser — so it is `DOT_LENGTH = 0.01` instead.

  `Scene::digest` now covers the whole stroke style, not just the width: a dash pattern or join change would otherwise slip through a comparison unnoticed, which is the one thing the harness exists to prevent.

- **Slice F (done)** — the unsupported-shape-kind divergence, the thing that blocked the harness on any real document. render-wasm's `node_from_shape` *drops* a Text/Bool/SVGRaw shape (returns `None`, so the parent lists an absent child hashing as `MISSING_NODE_TAG`); render-vello's streaming ABI has already created the node at `use_shape` and cannot cleanly drop it, so it mapped the unknown type to `Rect` — a shape that was a rect on one side and a hole on the other, and that Vello *painted* as a phantom solid box where glyphs belong.

  **The fix is a shared `ShapeKind::Unsupported`, digested as a hole.** render-wasm keeps dropping; render-vello now *marks* the node `Unsupported`; `digest_node` hashes that variant with the exact `id + MISSING_NODE_TAG` bytes the missing-child branch uses, so the drop and the mark reconcile to one hash. `count_paintable`, `collect_diamonds` and `scene::draw_node` treat it (and its subtree) as inert, so the picture and the digest count the same nodes.

  This is deliberately *not* the retraction the earlier note above predicted. Retracting a node `use_shape` created would fight the streaming ABI (later setters and `with_current` still address it); marking is local and needs no new machinery.

  Two traps worth recording:
  - **The variant is appended last on purpose.** `digest_node` hashes `kind as u64`, so inserting it mid-enum would shift every existing discriminant and silently move every digest — including the browser anchor `CANONICAL_DIGEST`. Same family as `RawShapeType`'s ordering.
  - **Rect had no explicit ABI arm.** `set_shape_type` matched only Frame/Group/Path/Circle and let *everything else* — including Rect (`3`) — fall to `_ => Rect`. Flipping the default to `Unsupported` therefore swept Rect in with Text/Bool/SVGRaw until a `3 => Rect` arm was added. Caught by two paintable-count tests going to zero.

  **Known limitation, left unsolved:** an unsupported kind that is *also a container* (Bool, with operand children) has its subtree dropped on both sides. Symmetric, so it cannot fake a cross-backend match for anything actually drawn — but the neutral model then doesn't represent whatever render-wasm's real Skia path might draw for a boolean result. Acceptable because the in-scope deferred kinds (Text, SVGRaw) carry no independently-painted children.

  Verified without a browser: the crux is a render-core test asserting a scene whose root lists an *absent* child digests identically to one where that child is *present but `Unsupported`* — i.e. render-wasm's projection and render-vello's agree — while a real `Rect` in the same slot still breaks parity (the safety property for the day a backend gains real support). The `cross-backend-digest` anchor is unmoved (`2568426414`), and the emscripten gate still builds.

Two casualties of the relocation, both fixed in place:
- `SerializableResult` lost its `From<BytesType> + Into<BytesType>` supertrait bounds. Those types are foreign to render-wasm now, so the orphan rules forbid the conversion impls; nothing used the bounds (`write_vec` only calls `clone_to_slice`).
- **The generated `shared.js` came from one crate and now comes from two.** `ToJs` appends to `$OUT_DIR/render_wasm_shared.js` per crate, and both `_build_env` and the CI workflow took `find … | head -n 1` — an emscripten build duly picked render-core's file and cut the frontend's `shared.js` from 36 enum constants to 2. Both now concatenate and dedupe by declaration name; duplicates are real, because cargo keeps stale build-script hash directories and repeat invocations append twice.

**The emscripten build is the gate that matters here** (D2: render-wasm must keep building for `wasm32-unknown-emscripten` against prebuilt Skia). Run it with `pnpm run build:wasm` from `skia-rs-wasm` — it drives `render-wasm/build` inside `penpotapp/devenv`. Slice A passes it.

### Phase 3 — common backend interface + runtime selection

**Done (the seam and selection; Skia stays the default).** The plan here read "define the `Renderer` interface … write the two adapters … capability-detect WebGPU and lazily download the matching `.wasm`." Exploring the code first collapsed the scope: the ~150-call setter surface was *already* unified by `vello-module-facade.ts` (the wasm-bindgen→Emscripten `Module` proxy), and the download was *already* lazy — only the chosen backend's `.wasm` loads. The abstraction leaked in exactly **three** places, the `isVelloModule(...)` branches: surface bring-up (`initPage`), teardown (`destroyContext`), and image upload (`fetchImage`).

What shipped:
- **`RenderBackend` (new `backend.ts`)** — one interface owning exactly those three operations (`attachSurface`, `detachSurface`, `storeImage`). `SkiaBackend` and `VelloBackend` implement it (the Vello one wrapping the existing low-level `velloBackend`), and the backend is carried on the module as an own property `renderBackend` (same Proxy-surviving trick as `velloBackend`). `backendOf(module).op(...)` replaces every `isVelloModule` branch — `isVelloModule` is no longer a control-flow branch anywhere.
- **The context-init asymmetry now lives in the backends.** `initCanvasContext`/`clearCanvas` set the shared context flag internally; the Vello methods set it explicitly. Preserved 1:1.
- **Capability-gated selection seam** — `chooseBackendKind()` + `probeWebGPU()`. `?renderer=vello` on a browser *without* WebGPU now falls back to Skia with a warning instead of failing deep in wgpu bring-up.

**Deliberately not done: auto-select.** `AUTO_SELECT_VELLO` is a `false` constant; the default stays Skia. Auto-routing WebGPU users onto Vello would render text and effects blank until Phases 4–5. Flipping it later is one line. This is *not* a `PaintSink` port (D13): that is a Rust trait that cannot span two wasm targets (D2), and the streaming setter surface it describes already exists as `api/*.ts`; the retained half is Phase 6.

Verified in real Chrome (the in-app browser has no working GL surface, and this app's *workspace* canvas renders through a worker — the main-thread `Renderer` path is focus-mode only — so the seam was exercised directly): `chooseBackendKind()` returns `skia` by default even with WebGPU present, `vello` under `?renderer=vello` with an adapter, and `probeWebGPU()` goes `false` when `navigator.gpu` is masked (the fallback signal). Types clean; 593 unit tests pass with the cross-backend digest anchor unmoved (`2568426414`). A live Vello frame through the focus-mode `Renderer` was not driven — the selection + dispatch are behavior-preserving and unit/type-verified, but a visual focus-mode render remains unproven here.

### Phase 4 — effects parity
Blur, drop/inner shadow, blend modes, masks, clips onto Vello's filter graph. Fuse pointwise runs between convolution barriers.

**A correction the exploration forced, worth stating up front: most of this phase does *not* need the custom shader.** render-wasm applies blur/shadow/blend/mask via Skia `ImageFilter`/blend-mode/`save_layer` — **none via SkSL** (SkSL is only diamond/glass/noise/material, out of scope here). And Vello already exposes, on the `RenderingContext` trait render-vello drives, upstream primitives for blend (`push_layer` blend arg), masks (`push_layer` mask arg), layer blur (`fill_blurred_rounded_rect` / `GaussianBlur`) and drop shadow (`DropShadow`). The `custom-wgsl-filter` fork's `FilterPrimitive::Custom` is needed only for the *gaps*: **inner shadow** (`InnerShadow` is `unimplemented!()` in the fork) and **backdrop/background blur** — plus stacking >1 filter on a node (`unimplemented!("Multi-primitive filter graphs")`).

Every effect first threads through the model like Diamond/Image did: `Node` field → `Node::new` default → `digest_node` → `node_from_shape` (render-wasm) → ABI setter (render-vello) → apply in `scene.rs`.

- **Slice 1 (done) — blend modes.** New `render_core::blend` is the single authority: `blend_from_raw(u8) -> peniko::BlendMode` (Penpot's 16 modes are all `Mix`es composited `SrcOver`; `Normal` is the default) and `DEFAULT_BLEND`. render-vello's `set_shape_blend_mode` calls it directly; render-wasm's `model_export` holds a `skia::BlendMode` and goes through `skia_blend_to_peniko`, **pinned equal to `blend_from_raw` over all 16 bytes by a test** (`skia_and_raw_blend_agree`) — the one thing that keeps the two projections from silently disagreeing. `Node` gained `blend`; `digest_node` hashes both `#[repr(u8)]` discriminants unconditionally (so the anchor moved). `scene.rs` folds blend into the same outer layer as opacity — both wrap node + children, so `push_layer(None, blend, alpha, None, None)` when either is non-default.

  Verified: render-core 59, render-vello 42, render-wasm 113 (+4 known `tile_grid::ssa`); the cross-backend anchor is now `3081092446`, produced by the Vello wasm running the **real wire path** (the fixture rect carries a `Multiply` blend, so `_set_shape_blend_mode(24)` flows through the facade → the new ABI export → `node.blend` → digest — reachability the Rust unit test can't cover). Emscripten gate builds. A live focus-mode Multiply *render* was not driven (same worker/GPU-surface limits as Phase 3); the cross-backend digest match on the non-default-blend document is the parity evidence.

- **Slice 2 (done) — layer blur + drop shadows.** New `render_core::blur::radius_to_sigma` is the authority for the radius→sigma conversion (Skia's `0.577·r + 0.5`), pinned equal to render-wasm's own copy by `radius_to_sigma_agrees_with_render_core`. `Node` gained `blur: Option<f32>` (a layer-blur radius) and `shadows: Vec<Shadow>` (drop shadows only — `Shadow { color, blur, spread, offset }`); `digest_node` hashes both. render-wasm's `model_export` reads the layer blur and Drop shadows; render-vello implements the previously-stubbed `set_shape_blur` / `add_shape_shadow` / `clear_*`. **Dropped at projection on both sides** (like inner/outer strokes): background blur, inner shadows, and shadow **spread** (needs a dilate the fork lacks).

  **The multi-primitive limit never bit — Slice 1's expectation was wrong.** A drop shadow is *fill the silhouette in the shadow colour, offset, under a `GaussianBlur` filter layer* — the single upstream primitive, one `push_filter_layer` per shadow — so multiple shadows and a layer blur stack as separate passes. **No fork edit.** In `scene.rs`, layer blur rides the composite layer's filter slot (`push_layer(None, blend, alpha, None, blur)`); shadows draw behind, outside that layer, so the layer blur does not blur them.

  Verified: render-core 62, render-vello 43, render-wasm 116 (+4 known); anchor `2592162645` (fixture rect now carries a layer blur *and* a drop shadow through the real wire). Emscripten builds. **And the first effects-pixel proof** — driven live on Vello in real Chrome, a rect renders a soft offset drop shadow and a second renders Gaussian-blurred. One trap caught only by looking: the shadow array property is Penpot's `shadow` (singular) — `shadows` is silently ignored by `setObject`, which had briefly made both the fixture anchor and the pixel test drop the shadow with no error.

- **Slice 3 (done) — masked groups.** `Node` gained `masked: bool` (only ever true on a `Group`); `digest_node` hashes it unconditionally, like `clip`. render-wasm's `model_export` reads it straight off the `Group` payload (`matches!(&shape.shape_type, Type::Group(g) if g.masked)`), dropping the hard-coded `false`; render-vello adds the `set_shape_masked_group` export the facade had been stubbing to a silent no-op — without it a masked group reached Vello as a plain one and the two projections would disagree. The flag is an *interpretation* of the existing `children` list (the first, bottom-most child is the mask, the rest is content), so the digest already covered the shapes; the flag records that the first is consumed rather than drawn.

  **A correction, and the deferred half.** `push_layer`'s mask slot wants a screen-space **alpha raster** (`vello_common::mask::Mask`, built from a `Pixmap`), which faithful DstIn masking would fill from an offscreen render of the mask child — a pass the neutral `RenderingContext` cannot yet produce. But an **opaque** mask (the common case) makes masking *exactly a clip to the mask's silhouette*, so `scene.rs` draws a masked group by pushing `outline(children[0])` as a clip layer around the content — reusing the existing clip machinery, no mask raster, no fork edit. **Deferred** (approximated as a hard clip for now, the same "carry it, approximate the pixels" contract as shadow spread): soft masks — a gradient, an image, or a partly-transparent mask fill — which need the true alpha pass.

  Verified: render-core 62, render-vello 44, render-wasm model_export green; anchor `1240504707` (the fixture frame now holds a masked group — a circle mask over a rect — driven through `_set_shape_masked_group`, and `scene_paintable_count` is 4). Emscripten builds. **And the pixel proof** — live on Vello in real Chrome, two identical groups side by side differing only in `maskedGroup`: the masked one clips its magenta content to a circle (centre magenta, all four bbox corners background), the control paints the full square.

  **Roadmap for the rest:** inner shadow + backdrop blur + shadow spread + soft (true-alpha) masks — the genuine custom-GPU / fork work, plus the offscreen-render pass a soft mask needs.

### Phase 5 — text + images
Parley layout/shaping → Vello glyph runs. Image decode/upload to Vello textures; browser-decoded texture fast path → wgpu interop. Highest-risk phase.

- **Slice 1 (done) — text renders.** The design fork the recon forced: the host ships text *content* (paragraphs → styled spans + UTF-8), and render-wasm shapes it itself with Skia's `textlayout` — it does **not** send positioned glyphs. render-vello shapes with **Parley**. Two different shapers never agree glyph-for-glyph, so the neutral model carries the **input**, each backend shapes it, and the digest hashes the input — glyph-position divergence is a rasteriser detail, out of scope like antialiasing (Model A).

  - **`render_core::text`** (new): `TextBlock { paragraphs, grow, vertical_align }`, `TextParagraph { align, line_height, letter_spacing, spans }`, `TextSpan { text, font: FontRef{id,weight,italic}, size, line_height, letter_spacing, color }`. `ShapeKind::Text` (appended after `Unsupported` so no discriminant shifts) + `Node.text: Option<TextBlock>`; `digest_node` hashes it, gated on `kind == Text`; `paintable_count` counts a non-empty text node.
  - **Projections.** render-wasm's `model_export` adds a `Type::Text` arm (`text_to_core`) reading `TextContent` + the shape's vertical-align; render-vello's ABI adds `set_shape_type 5 → Text`, `set_shape_text_content` (a byte-exact `RawParagraphData`/`RawTextSpan` parser), `clear_shape_text`, `set_shape_grow_type`, `set_shape_vertical_align`, and **`store_font`/`is_font_uploaded`** — `wasm32-unknown-unknown` has no system fonts, so every face is uploaded and registered into a Parley collection under an internal alias (`font_alias`). The two projections meet on the same font id (`Uuid::as_u128()` == `uuid_u128(wire)`, as shape ids already do).
  - **Draw (`scene.rs`).** A `TextEngine` (Parley `FontContext`+`LayoutContext`) lives on the scene; the `resources` the scene had ignored is threaded to `draw_node`. Per text node: one `Layout` per paragraph (family by alias, size, line-height, letter-spacing, align, max-advance from grow/box), stacked with a vertical-align offset, drawn via `glyph_run(...).font_size().normalized_coords().hint().fill_glyphs()` in the run's colour.
  - **Deferred, dropped on both sides so the digest still agrees:** text strokes, decorations (underline/line-through/overline), text-transform, RTL, emoji/COLR fallback, multi-fill spans, text shadows/effects, the editor/caret. Only the first solid fill's colour crosses.

  **The phase's biggest risk — Parley + glifo linking for `wasm32-unknown-unknown` alongside the vello fork's pinned `peniko`/`fontique` — is cleared:** they unify and the module builds (6.5 MB). Verified: render-core 63, render-vello 45, render-wasm model_export green (+4 known `tile_grid::ssa`); cross-backend anchor `166674860` with a text shape through the real `_set_shape_text_content` wire (paintable count 5); emscripten gate builds; and the **pixel proof** — live on Vello in real Chrome, "Hello — text renders!" shaped by Parley (Roboto 700, uploaded via `store_font`) drawn as glyph runs (~6.6k glyph pixels in a 536×34 line). Next: image fills, then the deferred text features.

- **Slice 2 (done) — decorations + per-span multi-fill.** The wire already carried both (span-header byte 1 is `RawTextDecoration`; up to eight fill records follow the header) — slice 1 just read neither. So this is pure model surface, no fork or GPU work. `render_core::text` gains `TextDecoration { None, Underline, LineThrough, Overline }` (`from_wire`, matching `RawTextDecoration`); `TextSpan.color: Color` becomes `TextSpan.fills: Vec<Paint>` (bottom-to-top, the order `merge_fills` composites, each new fill `SrcOver` the last) plus `decoration`. `digest_text` hashes the decoration discriminant and every fill through the existing `digest_paint`, so the anchor moves.

  **Projections.** render-wasm's `span_to_core` swaps `text_span_color` for `span.fills.iter().filter_map(fill_to_core)` (the same collect the shape fills use) and a `text_decoration_to_core` — the wire is single-valued, so each `RawTextDecoration` becomes exactly one Skia flag and a plain `==` is exact. render-vello's `parse_span` reads decoration byte 1 and rebuilds the whole fill list with the same `decode_fill`+`paint_from_raw` loop `set_shape_fills` uses — same decode, filter and order, so the two hash identically.

  **Draw (`scene.rs`).** `TextBrush` carries the span's `fills` and `decoration`. `draw_glyph_run` materialises the positioned glyphs once, then paints the glyph coverage once per fill through the shared [`set_paint`] (so a gradient text fill gets the same unit-box→bounds mapping a gradient shape fill does; an unresolved image fill draws nothing rather than a hole), then draws the decoration with glifo's own skip-ink `render_decoration` — `underline_offset`/`strikethrough_offset`+size straight from the run's `RunMetrics` (overline rides the ascent), tinted by the topmost fill.

  **Deferred still:** text strokes, text-transform, RTL, emoji/COLR fallback, text shadows/effects, the editor/caret.

  Verified: render-core 63, render-vello 45, render-wasm model_export 28 (+4 known `tile_grid::ssa`); the whole `skia-rs-wasm` renderer suite (593 pass, the 3 `font-cache` failures pre-existing/environmental); cross-backend anchor moves to `1484165574` (the fixture text span now carries an underline and a second, semi-transparent fill through the real wire, paintable count still 5); emscripten gate builds; and the **pixel proof** — live on Vello in real Chrome, an underlined run whose ink is the composite of two layered fills (bright orange `#ee6c4d`@0.55 over `#f4d35e` — a single-fill draw would read pure yellow). Next: image fills, then the remaining deferred text features.

- **Slice 3 (done) — text strokes.** Almost free, because a text stroke is a *shape-level* stroke (render-wasm's `render/text.rs` takes the shape's `Stroke`, not a per-span one), so `node.strokes` was already projected (`model_export` builds it for every shape, kind-agnostic), already parsed by the ABI, and already hashed by `digest_node` — the stroke slice built all of that. The only gap was that render-vello's `draw_text` ignored it. So this slice is **`scene.rs` only**: `draw_glyph_run` gains a stroke pass after the fills — for each stroke, `set_paint` then `set_stroke(style)` then glifo's `stroke_glyphs` (the text counterpart of a shape's `set_stroke`+`stroke_path`), over the fills. Only centre strokes reach here — inner/outer are dropped at projection on *both* sides (the same offset-decision kurbo can't express that shape strokes hit), so there is nothing to fake and the two never disagree.

  No render-core, render-wasm or ABI change — the model already carried it. Verified: render-vello host 45 unchanged (no ABI touched); the `skia-rs-wasm` renderer suite 593 pass; the cross-backend anchor moves to `2549898142` **purely from adding a centre stroke to the fixture text node** (proving a text-node stroke crosses the wire and both projections hash it identically — the model plumbing this slice relies on but doesn't change); emscripten gate unaffected (render-wasm source identical). And the **pixel proof** — live on Vello in real Chrome, "Stroked" in a cream fill with a blue centre-stroke outline drawn on the glyph silhouettes. Next: image fills, then the remaining deferred text features (transforms, RTL, emoji/COLR, text effects, the editor).

- **Slice 4 (done) — case transform + base direction (RTL).** `render_core::text` gains `TextTransform { None, Uppercase, Lowercase, Capitalize }` (with `apply`, replicating render-wasm's `capitalize_words`) on `TextSpan`, and `TextDirection { Ltr, Rtl }` on `TextParagraph`; `digest_text` hashes both. The model keeps the span text **raw** — the fold happens at *draw*, so the model stays the literal input and the digest agrees on it. Both wire bytes already existed (span byte 2 = transform, paragraph byte 5 = direction); the projections just read them (`text_transform_to_core` / `text_direction_to_core` on render-wasm, `from_wire` on render-vello).

  **Draw (`scene.rs`).** `layout_paragraph` folds each span with `span.transform.apply(&span.text)` before shaping (ranges track the folded length, which `to_uppercase` can grow). Parley resolves the Unicode bidi algorithm from content on its own and exposes no base-direction knob, so an RTL paragraph is forced by prepending a zero-width **RIGHT-TO-LEFT MARK** — the same base level render-wasm's `set_text_direction` sets. Real RTL scripts reorder on their own; the mark only fixes the base for neutral/mixed text. Absolute `Left`/`Right` alignment is unchanged (it stays put under RTL; the base only reorders glyphs within the line).

  Verified: render-core 63, render-vello 45, render-wasm model_export 28 (+4 known); `skia-rs-wasm` renderer suite 593 pass; cross-backend anchor moves to `1318113828` (the fixture text now carries an uppercase transform *and* an RTL base direction through the real wire); **emscripten gate builds**. And the **pixel proof** — live on Vello in real Chrome: lowercase "transform works" renders "TRANSFORM WORKS", and Hebrew "שלום עולם 2024" (DejaVu Sans, uploaded via `store_font`) shapes and reads right-to-left with the digits held LTR — real mixed-direction bidi. (Latin text alone doesn't visibly reorder under an RTL base — bidi collapses the neutral spaces to LTR — which is why the proof uses a real RTL script.) Next: image fills, then emoji/COLR fallback, text effects, the editor.

- **Slice 5 (done) — emoji / COLR fallback.** Emoji are just UTF-8 text — they already cross the wire and hash into the digest, so there is **no model, digest, or projection change**. And glifo's glyph cascade already resolves **COLR > bitmap > outline** per glyph, so `fill_glyphs` draws colour-glyph layers with no draw change. The one missing piece: `wasm32-unknown-unknown` has no system emoji font, and Parley, for any cluster it detects as emoji, appends the **`GenericFamily::Emoji`** generic to its font query — which was empty. So `store_font` (which already received an `is_emoji` flag it ignored) now carries it on `UploadedFont`, and `sync_fonts` calls `collection.append_generic_families(GenericFamily::Emoji, ids)` for an emoji face after registering it. That is the whole slice — render-vello `abi.rs` + `scene.rs` only.

  A general (non-emoji) `is_fallback` face still can't be auto-wired: Parley's non-emoji fallback is keyed by the run's **script**, which the wire does not carry, so those stay registered-by-name only (a later slice, when a script travels with the font). glifo's `png` feature is off, so **bitmap** emoji (CBDT/sbix, e.g. the default Noto Color Emoji) won't draw — COLR is the supported path.

  Verified: render-vello host 45 unchanged; `skia-rs-wasm` renderer suite 593 pass; cross-backend anchor **unmoved** at `1318113828` (emoji is render-only — nothing new to hash); emscripten gate unaffected (render-wasm identical). And the **pixel proof** — live on Vello in real Chrome, "Vello 😀 🎉 🚀 / emoji ❤️ 🌈 👍": the Latin comes from Roboto, the emoji fall through to a **Noto COLRv1** face (uploaded `is_emoji`) and draw in full colour. Next: image fills (verified with a real fetched asset — no code change, image *is* a fill), then text effects, the editor, and general per-script fallback.

- **Image fills (verified, no code) — image *is* a fill.** Penpot has no image shape kind; a photo on the canvas is a rect with an `Fill::Image`, so "image fills" and "normal image rendering" are one path — the one Phase 2 already built and painted. The only gap was that Phase 2 proved it with a *synthetic* bitmap; a real fetched asset was never exercised. Closed: live on Vello in real Chrome, a photo fetched from a CDN → `store_image_rgba` → rendered as an image fill on a rect (keep-aspect, white page background). No code change.

- **The editor (done, three stages) — caret, selection, typing, IME.** Unlike everything else, the editor is *ephemeral interaction state*, not part of the model or its digest, so the cross-backend anchor is **unmoved** throughout. render-wasm hand-builds it on Skia's read-only paragraph API (~2800 lines across ~35 ABI entry points); render-vello wraps Parley's **`PlainEditor`**, which already does cursor movement, bidi-aware hit-testing, selection geometry and IME — so it is a *wrap + a bridge*, not a rewrite (~600 lines in a new `editor.rs` + `scene.rs`).

  **Architecture (D3).** The `PlainEditor` needs a `FontContext` to lay text out, and that lives on the scene's `TextEngine`, which only the render pass touches. So the `text_editor_*` ABI records intent only — a focused id, theme colours, a queue of commands — and reads back state the render pass cached. `sync_editor`, inside the render pass, rebuilds the editor on a focus change, drains the queue against the live `PlainEditor`, draws the caret + selection inline (a focused shape is drawn from the *editor's own layout* so caret and glyphs share one layout), and caches the text, selection range and caret rect. The host drives both backends through the same `text_editor_*` names (D17), unchanged.

  - **Stage 1 — display + hit-test:** `apply_theme`, `focus`/`blur`/`dispose`, `has_focus`/`has_selection`/`get_active_shape_id`, `pointer_down`/`move`/`up` (click + drag select via `move_to_point`/`extend_selection_to_point`), `select_all`, `select_word_boundary`, `update_blink`, `poll_event`.
  - **Stage 2 — typing + write-back:** `insert_text`/`insert_paragraph`, `delete_backward`/`forward` (word variants), `move_cursor` (render-wasm's `CursorDirection` × word × extend → the driver's `move_*`/`select_*`), `toggle_overtype_mode` (approximated). `export_content` (paragraphs-of-spans JSON) and `get_selection` serve from the cached snapshot, so the host persists edits on commit.
  - **Stage 3 — IME + geometry:** `composition_start`/`update`/`end` → the driver's `set_compose`/`clear_compose` + commit; `get_cursor_rect` (caret `[l,t,w,h]` for candidate-window placement) from the cached caret rect.

  **The plain-vs-rich boundary (closed by the next slice).** `PlainEditor` is single-style, so a focused multi-span run flattened to its first span's style *while editing*. That was the one real gap — see the rich-editing slice below.

  Verified: render-vello host 45; `skia-rs-wasm` renderer suite 593 pass; anchor unmoved; three live pixel proofs on Vello in real Chrome — (1) click-drag produced a bidi-aware selection highlight with a caret; (2) an empty box typed to "Typed live on Vello", backspaced and retyped to "Typed live on Parley", `export_content` returning `[["Typed live on Parley"]]`; (3) an IME pre-edit "naïve café" composed inline with `get_cursor_rect` returning a caret rect.

- **Rich multi-span editing (done) — styles survive focus.** Parley ships exactly one editor, `PlainEditor`, which its own doc calls single-style (its `StyleSet` "is unsuited for rich text"). But the pieces *under* it are not: `Selection` and `Cursor` are generic over **any** `Layout<B>` — every method takes `&Layout` — and the rich layout path (`RangedBuilder`, per-range `StyleProperty`) already existed for the non-editing draw. So the fix bypasses `PlainEditor` and reuses those: a new host-testable `rich_editor.rs` keeps a span model (`StyledText` = flat text + covering style segments), transforms it on each edit, rebuilds a **multi-style** `Layout`, and drives `Selection`/`Cursor` over it. Caret motion, bidi hit-testing, word boundaries, selection geometry and IME are reused verbatim; the only new logic is the span-transform on insert/delete (`replace_range`, inserted text inheriting the run to its left). ~500 lines, **not** the 2800-line rewrite — because the model already carried the spans.

  The editor stays ephemeral (no model/digest/wire change), so the anchor is still **unmoved**. `sync_editor` now builds/drives a `RichEditor` instead of a `PlainEditor`; `draw_focused_editor` draws its multi-style layout. **Still deferred (host-coupled, a later slice):** `export_content` emits plain text — the span model is preserved across edits, but serialising per-span *styles* back through render-wasm's export JSON (rich `export_styled`/`get_current_styles`/`apply_styles`) is a host contract, not a renderer concern; and the block lays out under the first paragraph's alignment / base direction (per-paragraph align + RTL base while editing).

  Verified: 7 new host unit tests for the span-transform (flatten/coalesce, newline-joins, insert-inherits-left, delete-clips-both, empty-box style carrier) — render-vello host 52 pass; wasm build clean; cross-backend anchor **unmoved** at `1318113828` against the rebuilt wasm (render-only). And the **pixel proof** — live on Vello in real Chrome: a focused two-span box keeps "Big" at 48px red and " small" at 18px blue instead of flattening (the old behaviour), with the caret drawn; and typing "Hey " at the start renders it in the inherited big-red style ("Hey Big small"), the caret landing correctly across the size boundary. Next: text effects (glyph-silhouette shadows/glass/noise) and the custom-shader track.

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
