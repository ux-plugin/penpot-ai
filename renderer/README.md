# `renderer/`

All rendering lives here, split by surface and by role.

```
renderer/
├── 2D/                        the 2D vello stack
│   ├── vello/                 forked sparse-strips engine (submodule) — the base both branches fork
│   ├── core/                  shared crate: everything both branches share
│   │   ├── src/               backend-neutral: scheduler · tiling · model · effect-graph · ...
│   │   ├── src/vello/         the vello layer: sink · effects · glass · blur · blend · draw · FFI
│   │   └── macros/            render-macros (proc-macro crate; can't dissolve into core)
│   ├── webgpu-vello/          CLASSIC branch — WebGPU compute, whole-viewport   ← default
│   └── webgl-vello/           HYBRID branch  — WebGL2, 512-tile scheduler
├── 3D/                        (empty — Myth / three engine lands here later)
├── editor/                    editor-facing rendering integration (see below)
└── runtime/                   (empty — the shipped-app rendering runtime later)
```

## `2D/core` — one crate, two halves

`core` is the merged former `render-core` (backend-neutral scheduler/model/tiling) and
`render-vello-core` (the device-generic wgpu effect executor). They were two crates only so the
scheduler could stay Vello-free and be shared with the Skia backend. Skia is detached, so nothing
needs that separation anymore — they're one crate now, the vello half nested as `render_core::vello`.

`macros` stays a separate crate because Rust requires a `proc-macro = true` crate to stand alone.

## `2D/webgpu-vello` / `2D/webgl-vello` — the two branches

Same crate/lib names as before the move (`vello-gpu-renderer` / `render-vello`); only the
directories changed, so the published wasm artifacts (`render-vello-gpu*`, `render-vello*`) and the
build scripts' output names are unchanged. Each is a `cdylib` that re-exports the shared FFI shell
from `core`.

## `editor/`

The layer that sits between the wasm renderers and the editor's JS app — the TypeScript binding
(`backend.ts`, `wasm-module.ts`, `vello-module.ts`, `vello-module-facade.ts`, …) — currently lives
at `zoetrope-editor/src/lib/renderer/`. It is deeply woven into the editor package (imports its
`api/*`, `wasm-types`, etc., and is imported across the app), so lifting it out to this folder would
break in-package imports for no functional gain. It is left in place pending a decision; this folder
is the reserved home if we later extract a standalone binding package.

## `runtime/`

Empty for now. The runtime-profile rendering path (the shipped app, not the editor) will land here.

> Note: `render-wasm/` (the Skia crate) is **retired** — detached from the editor and left in place,
> unmoved and unbuilt. Its `path` deps into the old `render-core`/`render-macros` locations are now
> dangling on purpose; it is not part of this tree.
