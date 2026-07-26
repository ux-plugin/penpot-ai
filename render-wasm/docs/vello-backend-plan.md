# Vello as a peer rendering backend — decisions & plan

Status: **Phase 0 done, Phase 1 in progress.** Architecture: **two standalone wasm modules, one chosen at runtime.**

This supersedes the earlier "Option A, focus-mode first" framing. See [Decision log](#decision-log) for what changed and why.

---

## Where things live

Everything is consolidated in the **main worktree** (`/Users/dhiat/coding/penpot-ai`, branch `develop`).

| Thing | Path | Notes |
|---|---|---|
| Vello fork | `vello/` (submodule → `ux-plugin/vello.git`) | branch `custom-wgsl-filter` |
| Embeddable Vello module | `vello/sparse_strips/vello_hybrid/examples/focus_embed/` | `FocusRenderer`, host-driven |
| Neutral shared crate | `render-wasm/render-core/` | **should move to repo root** — it is not render-wasm's |
| Skia↔neutral boundary | `render-wasm/src/core_convert.rs` | free fns, affine-only |
| Shape → neutral projection | `render-wasm/src/model_export.rs` | **transitional** — unnecessary in the end state |
| This plan | `render-wasm/docs/vello-backend-plan.md` | |

The `vello-spike` worktree at `../penpot-ai-vello-spike` is now empty of vello work and can be removed.

**Nothing is committed yet** — main tree and the vello submodule both carry uncommitted work.

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

### D4 — `skia-rs-wasm` is the host and owns the document
Not CLJS. `skia-rs-wasm` holds the document model (`IndexedShape`/`IndexedPage`), resolves geometry in TS (`renderer/geom/`: vector-network-faces, planarize, fillet, path-arc, subpaths, matrix), and already drives render-wasm via `node-factory`/`wasm-module`. Projection to a renderer originates **there**, which is what makes the two modules peers.

Exception: **text**. Skia's paragraph layout lives inside render-wasm, not in the host.

### D5 — Shared Rust crate: `render-core`
Backend-neutral, zero dependencies, `#![forbid(unsafe_code)]`. Today: `geom` (Point/Rect/Matrix, SkMatrix element order) + `model` (Color/Fill/ShapeKind/PathSeg/Path/Node/Scene). 596 lines, 11 tests, builds for `wasm32-unknown-unknown`. Compiled into both artifacts; only one ships per session.

### D6 — Approach B now, approach A as the destination
For the model boundary we chose **B: neutral model + convert at the handoff**, over **A: swap Skia types in place**. A is one indivisible ~260-site change because the four geom atoms (`Matrix`, `Point`, `Rect`, `Color`) are type-coupled.

But under D3 the end state wants the core to **be** the model, which is A. So B is the stepping stone that unblocks Vello without touching the shipping Skia engine; A is where render-wasm eventually lands as the core absorbs the model.

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

---

## What is already built

**Phase 0 — embeddable Vello module. Done.**
`focus_embed` exposes `FocusRenderer` on a **host-provided** canvas with no internal event loop: `render()`, `resize()`, `key()`, `set_scene()`, `set_transform()`, `status()`. WebGPU-first with WebGL2 fallback, preferred surface format (no extra per-frame copy), enlarged filter atlas, frame-skip instead of panic on atlas exhaustion. Verified in browser.

**Phase 1 — neutral core + end-to-end proof. Half done.**
- `render-core` geom + model, 11 tests.
- `core_convert.rs` — Skia↔core geometry boundary.
- `model_export.rs` — `Shape` → `render_core::model::Node` for rects, circles, paths, solid fills; 5 tests passing natively.
- `model_scene.rs` in `focus_embed` — renders a `render_core::model::Scene` with Vello.
- **End-to-end verified in browser:** real Skia `Shape` → neutral model → Vello pixels (rect, circle, cubic path), zero console errors.

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
- Binaries: render-wasm ~8.3 MB release; `focus_embed` 4.2 MB. Only one downloads.
- Geometry data: ~52 B/node + ~22 B/cubic segment.
- render-wasm's `Path` already stores geometry **twice** (`segments: Vec<Segment>` + `skia_path: skia::Path`).

---

## Plan

### Phase 1 (finish) — grow the neutral core
Add to `render-core`: strokes, gradients, opacity/blend, groups/clip/hierarchy, corner radius. Extend `model_export` in step, keeping its native tests green. Relocate `render-core` out of `render-wasm/` to a shared root location and repoint both consumers.
*Deferred to later phases: text, effects, custom shaders.*

### Phase 2 — live data path
Feed `render-vello` a real document from `skia-rs-wasm` rather than a hand-built model. Decide the wire format: reuse render-wasm's, or define one on `render-core`. Vello renders a real Penpot page (geometry only). Visual diff against Skia.

### Phase 3 — common ABI + runtime selection
Define the `Renderer` interface in `skia-rs-wasm`; write the two adapters (Emscripten and wasm-bindgen); capability-detect WebGPU and lazily download the matching `.wasm`. After this phase the two modules are genuinely interchangeable.

### Phase 4 — effects parity
Blur, drop/inner shadow, blend modes, masks, clips onto Vello's filter graph. Port the SkSL RuntimeEffects to WGSL via `FilterPrimitive::Custom`. Fuse pointwise runs between convolution barriers. Known Vello gaps to close: inner shadow, backdrop/background-blur semantics.

### Phase 5 — text + images
Parley layout/shaping → Vello glyph runs. Image decode/upload to Vello textures; browser-decoded texture fast path → wgpu interop. Highest-risk phase.

### Phase 6 — caching + animator
Rive-style dependency-ordered dirty propagation. Layer-texture cache and filter-atlas pooling. Benchmark against Skia using present-cadence on real files.

### Phase 7 — converge or hold
Either keep two peer modules indefinitely, or absorb render-wasm's model into `render-core` (approach A) so both modules share one model outright.

---

## Open questions

- **How much geometry is already resolved in `skia-rs-wasm`'s TS layer vs inside render-wasm/Skia?** This sizes the shared core directly. The more that is already neutral in TS, the less Skia-resolution work remains. Text is the known Skia-internal case; stroke expansion and boolean ops are unverified.
- **`render-core`'s home** — repo root, to serve two peers.
- **`vello_hybrid` has no threading.** If CPU-side encode becomes the bottleneck, that work has to be added.
- **Feature parity surface:** inner shadow, backdrop blur, all blend modes, exact gradient semantics.
- **Download cost** of the Vello module vs Skia, and how the host chooses when WebGPU is present but the document is effect-light.
